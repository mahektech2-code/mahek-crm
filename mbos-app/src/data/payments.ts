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

export type PaymentMode = 'Cash' | 'Cheque' | 'UPI' | 'Bank transfer';

/**
 * The cheque's bank and date, and whether this was money in advance, said in
 * the one sentence the receipt has room for.
 *
 * MahekOne's receipt carries an amount, a mode, a reference and a note. It has
 * no column for the bank a cheque is drawn on or the date written across it,
 * and inventing one from this end is not this app's decision to take — so they
 * go where a person will read them rather than nowhere at all. A cheque dated
 * next month is the difference between money accounts can bank this morning
 * and money they cannot.
 */
function collectionNote(args: {
  bank?: string | null;
  chequeDate?: string | null;
  isAdvance?: boolean;
}): string | undefined {
  const parts: string[] = [];
  if (args.bank) parts.push(args.bank);
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
  bank?: string | null;
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
        args.chequeNumber ?? null, args.bank ?? null, args.chequeDate ?? null, args.chequePhotoId ?? null,
        Date.now(), receiptRef, args.isAdvance ? 1 : 0, JSON.stringify(args.billRefs ?? []),
        depositSlaDueAt, base.clientCreatedAt, base.deviceId,
      ],
    );

    if (args.chequePhotoId) {
      await run('UPDATE media_queue SET parentId = ? WHERE id = ?', [base.id, args.chequePhotoId]);
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
      reference: args.chequeNumber || undefined,
      note: collectionNote(args),
      billIds: args.billRefs ?? undefined,
      receivedAt: isoDate(new Date()),
      visitId: args.visitId ?? undefined,
      localReceiptRef: receiptRef,
      deviceId: base.deviceId,
      clientCreatedAt: base.clientCreatedAt,
    },
    dependsOn: args.visitId ? [args.visitId] : [],
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
  for (const id of paymentIds) {
    await run('UPDATE payments SET deposited = 1, depositedAt = ?, depositProofId = ? WHERE id = ?', [Date.now(), proofMediaId, id]);
    await enqueue({
      entityType: 'payment',
      entityId: id,
      op: 'update',
      payload: { id, deposited: true, depositedAt: Date.now(), depositProofId: proofMediaId },
    });
  }
}

/**
 * A bounced cheque, in one transaction.
 *
 * It reverses the collection's effect, reopens what it was against, flags the
 * record, tells both people involved and creates the follow-up — because the
 * customer now owes money he believes he has already paid, and somebody has to
 * ring him about it.
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
   * Already bounced, so there is nothing to do and doing it anyway would be
   * wrong rather than merely wasteful: this function ADDS the amount back to
   * the customer's outstanding, so a second pass bills them twice for one
   * bounce. A double tap on a phone with a slow write is the ordinary way that
   * happens, and the second task and the second notification would arrive to
   * confirm it. Read-then-act, in one place, before anything is written.
   */
  if (payment.bounced) return;

  const customer = await one<{ name: string }>('SELECT name FROM customers WHERE id = ?', [payment.customerId]);
  const name = customer?.name ?? 'the customer';

  await tx(async () => {
    await run('UPDATE payments SET bounced = 1, bouncedAt = ? WHERE id = ?', [Date.now(), paymentId]);
    await run('UPDATE customers SET outstandingPaise = outstandingPaise + ? WHERE id = ?', [payment.amountPaise, payment.customerId]);
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
        (reason?.trim() ? ` — ${reason.trim()}` : ''),
    });
  });

  await enqueue({ entityType: 'payment', entityId: paymentId, op: 'update', payload: { id: paymentId, bounced: true, bouncedAt: Date.now() } });

  await createTask({
    title:
      `Ring ${name} — the cheque bounced` +
      (reason?.trim() ? ` (${reason.trim()})` : ''),
    customerId: payment.customerId,
    priority: 'High',
    dueDate: isoDate(new Date()),
  });

  await notify({
    title: 'Cheque bounced',
    body: `${name} · the amount is back on their account.`,
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
                         p.bounced, p.bouncedAt, p.syncState
                    FROM payments p LEFT JOIN customers c ON c.id = p.customerId`;
  return customerId
    ? all<CollectedPayment>(
        `${select} WHERE p.customerId = ? ORDER BY p.collectedAt DESC LIMIT 100`,
        [customerId],
      )
    : all<CollectedPayment>(`${select} ORDER BY p.collectedAt DESC LIMIT 100`);
}
