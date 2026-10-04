import { all, newId, one, run, tx } from '../db';
import { enqueue } from '../sync/queue';
import { insertLocal, stamp } from './write';
import { getConfig } from './config';
import { notify } from './notifications';
import { cashPosition, collectionMode } from '../engines/cash';
import { createTask } from './tasks';
import { isoDate } from '../lib/format';

/**
 * Collecting money.
 *
 * Two things this screen must never confuse: money the customer handed over,
 * and money the business has seen. A receipt written here is the first; the
 * second happens when accounts find it in the bank. So a collection reduces
 * nothing until the server says so — what it does is stop the chasing and put
 * the amount into cash-in-hand with a deadline attached.
 */

/**
 * How the money came, in the office's own words.
 *
 * A STRING, not the four literals it used to be. The list is the office's
 * `payments.modes` and reaches this phone on the pull, so a mode accounts
 * add — a demand draft, say — is offered here without an APK. The server has
 * always taken any string up to sixty characters; the four that used to be
 * written here survive as the list a phone falls back to when an older server
 * sends none.
 */
export type PaymentMode = string;

/* What is offered, and which two are left out, is `engines/payment-modes.ts`. */

/**
 * Whether this was money in advance, said in the one sentence the receipt has
 * room for. The cheque's DATE used to ride here too, as prose — so the
 * receipt's `instrument_date` stayed empty and a post-dated cheque reached the
 * office looking bankable today. It has its own field now; the note still
 * carries it, because a person reading the receipt reads the note.
 */
function collectionNote(args: { chequeDate?: string | null; isAdvance?: boolean }): string | undefined {
  const parts: string[] = [];
  if (args.chequeDate) parts.push(`dated ${args.chequeDate}`);
  if (args.isAdvance) parts.push('taken in advance');
  return parts.length ? parts.join(' · ') : undefined;
}

export async function collectPayment(args: {
  customerId: string;
  customerName: string;
  userId: string;
  visitId?: string | null;
  amountPaise: number;
  mode: PaymentMode;
  chequeNumber?: string | null;
  /** The UTR or transaction id, for a transfer. What accounts match the bank
      statement against — asked, never demanded. */
  reference?: string | null;
  chequeDate?: string | null;
  chequePhotoId?: string | null;
  isAdvance?: boolean;
  billRefs?: string[];
}): Promise<{ paymentId: string; receiptRef: string }> {
  const base = await stamp('payment');

  /* A receipt the customer can be shown before he lets go of the cash. The
     number is provisional and the screen says so; the server reconciles it
     against the configured series on sync. */
  const receiptRef = `TMP-${base.id.slice(-6).toUpperCase()}`;

  const slaHours = await getConfig<number>('mbos.payments.cashDepositSlaHours', 36);
  const notifyThreshold = await getConfig<number>('mbos.payments.managerNotifyThresholdPaise', 0);

  const depositSlaDueAt = args.mode === 'Cash' ? Date.now() + slaHours * 3_600_000 : null;

  await tx(async () => {
    await run(
      `INSERT INTO payments (id, customerId, userId, visitId, amountPaise, mode, chequeNumber, bank, chequeDate,
                             chequePhotoId, collectedAt, localReceiptRef, isAdvance, billRefs, depositSlaDueAt,
                             clientCreatedAt, deviceId, syncState)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued')`,
      [
        base.id, args.customerId, args.userId, args.visitId ?? null, args.amountPaise, args.mode,
        args.chequeNumber ?? args.reference ?? null, null, args.chequeDate ?? null, args.chequePhotoId ?? null,
        Date.now(), receiptRef, args.isAdvance ? 1 : 0, JSON.stringify(args.billRefs ?? []),
        depositSlaDueAt, base.clientCreatedAt, base.deviceId,
      ],
    );

    /* The photograph was taken before the receipt existed. Claimed while it
       is still in the queue; one that already went up under `pending` is the
       office's to bind, from `chequePhotoId` on the payload below. */
    if (args.chequePhotoId) {
      await run(`UPDATE media_queue SET parentId = ? WHERE id = ? AND state <> 'synced'`, [base.id, args.chequePhotoId]);
    }

    await insertLocal('timeline_events', {
      id: newId('tl'),
      customerId: args.customerId,
      eventType: 'payment',
      sourceApp: 'mbos',
      sourceRecordId: base.id,
      occurredAt: Date.now(),
      actor: 'You',
      summary: `${args.mode} collected`,
    });
  });

  await enqueue({
    entityType: 'payment',
    entityId: base.id,
    op: 'create',
    /* PROTOCOL.md §4.1. Two of these mattered more than the names suggest:
       `billRefs` reached a server reading `billIds`, so every collection was
       spread oldest-first however carefully the salesman had named the bills;
       and the cheque number went as `chequeNumber` to a field called
       `reference`, which is the string accounts match against the bank
       statement — so the one thing that identifies the money was dropped. */
    payload: {
      id: base.id,
      customerId: args.customerId,
      customerName: args.customerName,
      amountPaise: args.amountPaise,
      mode: args.mode,
      /* What identifies this money to whoever holds the statement: the cheque
         number where there is one, the transfer reference otherwise. */
      reference: args.chequeNumber?.trim() || args.reference?.trim() || undefined,
      note: collectionNote(args),
      /* The date written across a cheque, in its own field — it is what
         decides whether accounts can bank it this morning. */
      instrumentDate: args.chequeDate ?? undefined,
      chequePhotoId: args.chequePhotoId ?? undefined,
      billIds: args.billRefs ?? undefined,
      receivedAt: isoDate(new Date()),
      visitId: args.visitId ?? undefined,
      localReceiptRef: receiptRef,
      deviceId: base.deviceId,
      clientCreatedAt: base.clientCreatedAt,
    },
    /* Not behind the visit — see the same note in `saveOrder`. */
  });

  if (notifyThreshold > 0 && args.amountPaise >= notifyThreshold) {
    await notify({
      title: 'Large collection recorded',
      body: `${args.customerName} · your manager has been told.`,
      kind: 'neutral',
    });
  }

  return { paymentId: base.id, receiptRef };
}

/* ------------------------------------------------------------ cash in hand */

export type CashRow = {
  id: string; customerId: string; customerName: string | null; amountPaise: number;
  collectedAt: number; depositSlaDueAt: number | null; depositedAt: number | null;
  mode: string;
};

/**
 * What the salesman is carrying.
 *
 * Cash collections not yet deposited, with the oldest and anything past its
 * deadline surfaced. This is a real personal liability for the person holding
 * it, which is why the figure is on the home screen rather than buried.
 *
 * **THE MODE IS READ, and it was a constant.** Every undeposited row was
 * handed to the engine as `mode: 'cash'`, so the filter one line inside it —
 * the filter the whole engine is built around, documented at the top of
 * `engines/cash.ts` as "cheque and UPI collections are not here" — matched
 * everything it was given. A UPI receipt that was in the company's account
 * before the salesman left the shop counted as notes in his pocket, on the
 * home screen and against the deposit deadline. The comment saying the mode
 * was load-bearing sat directly above the line that threw it away.
 */
export async function cashInHand(userId: string, now = Date.now()) {
  /* The customer's name comes along because the escalation list has to say
     whose money it is, not just how much. */
  const rows = await all<CashRow>(
    `SELECT p.id, p.customerId, c.name AS customerName, p.amountPaise, p.collectedAt,
            p.depositSlaDueAt, p.depositedAt, p.mode
       FROM payments p LEFT JOIN customers c ON c.id = p.customerId
      WHERE p.userId = ? AND p.deposited = 0 AND p.bounced = 0
        AND COALESCE(p.syncState, '') NOT IN ('rejected','blocked')
      ORDER BY p.collectedAt ASC`,
    [userId],
  );
  const slaHours = await getConfig<number>('mbos.payments.cashDepositSlaHours', 36);
  return cashPosition(
    rows.map((r) => ({
      id: r.id,
      customerName: r.customerName ?? 'Unknown customer',
      amountPaise: r.amountPaise,
      collectedAt: r.collectedAt,
      mode: collectionMode(r.mode),
      depositedAt: r.depositedAt,
    })),
    slaHours,
    now,
  );
}

/**
 * Marking a deposit.
 *
 * Two-step by design: the salesman records it with proof, and the back office
 * confirms it on the bank statement. Either half alone leaves a gap somebody
 * eventually has to reconcile by memory.
 */
export async function markDeposited(paymentIds: string[], proofMediaId: string | null): Promise<void> {
  /*
   * ONE SLIP, ONE TRANSACTION. A day's cash goes into the bank on one slip,
   * and this is the write that says so for all of it — so either every row
   * reads banked and is queued, or none does. A loop of separate writes left
   * half a deposit recorded when the app was reaped part-way through.
   */
  const at = Date.now();
  await tx(async () => {
    for (const id of paymentIds) {
      await run('UPDATE payments SET deposited = 1, depositedAt = ?, depositProofId = ? WHERE id = ?', [at, proofMediaId, id]);
      await enqueue({
        entityType: 'payment',
        entityId: id,
        op: 'update',
        payload: { id, deposited: true, depositedAt: at, depositProofId: proofMediaId },
      });
    }
  });
}

/**
 * A bounced cheque, in one transaction.
 *
 * It flags the record, tells the office and creates the follow-up — because
 * the customer believes he has paid, and somebody has to ring him about it.
 *
 * IT DOES NOT TOUCH WHAT THEY OWE. A receipt collected in the field never
 * reduced outstanding in the first place: it is `reported` until accounts find
 * the money in the bank, and outstanding is the office's figure. Adding the
 * amount back here doubled the customer's debt on this phone until the next
 * pull — and where accounts HAD confirmed the cheque, reversing it is their
 * decision, taken on their screen, not a sum done on a handset.
 */
export async function markBounced(paymentId: string, reason?: string): Promise<void> {
  const payment = await one<{
    customerId: string; amountPaise: number; chequeNumber: string | null; bounced: number;
  }>(
    'SELECT customerId, amountPaise, chequeNumber, bounced FROM payments WHERE id = ?',
    [paymentId],
  );
  if (!payment) return;

  /*
   * Already bounced, so there is nothing to do: a second pass would raise a
   * second task to ring the customer and a second notification about one
   * cheque. A double tap on a phone with a slow write is the ordinary way that
   * happens. Read-then-act, in one place, before anything is written.
   */
  if (payment.bounced) return;

  const customer = await one<{ name: string }>('SELECT name FROM customers WHERE id = ?', [payment.customerId]);
  const name = customer?.name ?? 'the customer';

  await tx(async () => {
    await run('UPDATE payments SET bounced = 1, bouncedAt = ? WHERE id = ?', [Date.now(), paymentId]);
    await insertLocal('timeline_events', {
      id: newId('tl'),
      customerId: payment.customerId,
      eventType: 'payment_bounced',
      sourceApp: 'mbos',
      sourceRecordId: paymentId,
      occurredAt: Date.now(),
      actor: 'You',
      /*
       * The reason is KEPT, and it is kept LOCALLY.
       *
       * `paymentSchema` on the server takes `bounced` and `bouncedAt` and
       * nothing else, and there is no `bounceReason` column at either end — so
       * putting it on the wire would have it dropped by the parse in silence,
       * which is the failure this codebase names over and over. It goes where
       * it is actually read instead: the customer's timeline and the title of
       * the task to ring them, both of which are in front of the salesman at
       * the moment he makes that call.
       */
      summary:
        `Cheque ${payment.chequeNumber ?? ''} bounced` +
        (reason?.trim() ? `: ${reason.trim()}` : ''),
    });
  });

  await enqueue({ entityType: 'payment', entityId: paymentId, op: 'update', payload: { id: paymentId, bounced: true, bouncedAt: Date.now() } });

  await createTask({
    title:
      `Call ${name}. The cheque bounced` +
      (reason?.trim() ? ` (${reason.trim()})` : ''),
    customerId: payment.customerId,
    priority: 'High',
    dueDate: isoDate(new Date()),
  });

  await notify({
    title: 'Cheque bounced',
    body: `${name} · the office is told. If accounts had already counted it, they will take it back off.`,
    kind: 'danger',
    priority: 1,
  });
}

/* ------------------------------------------------- what he has collected */

/**
 * One row of the collections list.
 *
 * The customer's NAME is joined in rather than left to the screen, for the
 * same reason `cashInHand` joins it: a list of amounts with no names on it
 * cannot be worked, and every screen that needed it would otherwise fetch the
 * book a second time to get it.
 */
export type CollectedPayment = {
  id: string;
  customerId: string;
  customerName: string | null;
  amountPaise: number;
  mode: string;
  chequeNumber: string | null;
  chequeDate: string | null;
  collectedAt: number;
  localReceiptRef: string;
  deposited: number;
  depositedAt: number | null;
  depositSlaDueAt: number | null;
  bounced: number;
  bouncedAt: number | null;
  syncState: string;
  /** Why the office would not take it, where it would not. */
  syncMessage: string | null;
};

/**
 * The money he has taken, newest first.
 *
 * This is HIS record, not the office's. The customer screen's Payments tab
 * reads `customer_payments`, which is what the office has confirmed against a
 * bank statement; this reads what he wrote down at the counter. The two are
 * meant to be able to differ — that difference is the whole reason a deposit
 * has two halves — and a screen that showed only the office's copy would be a
 * screen where he could never act on his own.
 *
 * Capped like every other read of a list that grows for ever.
 */
export async function listPayments(customerId?: string): Promise<CollectedPayment[]> {
  const select = `SELECT p.id, p.customerId, c.name AS customerName, p.amountPaise, p.mode,
                         p.chequeNumber, p.chequeDate, p.collectedAt, p.localReceiptRef,
                         p.deposited, p.depositedAt, p.depositSlaDueAt,
                         p.bounced, p.bouncedAt, p.syncState, p.syncMessage
                    FROM payments p LEFT JOIN customers c ON c.id = p.customerId`;
  return customerId
    ? all<CollectedPayment>(
        `${select} WHERE p.customerId = ? ORDER BY p.collectedAt DESC LIMIT 100`,
        [customerId],
      )
    : all<CollectedPayment>(`${select} ORDER BY p.collectedAt DESC LIMIT 100`);
}
