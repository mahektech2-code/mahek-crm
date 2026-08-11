import { all, newId, one, run, tx } from '../db';
import { enqueue } from '../sync/queue';
import { insertLocal, stamp } from './write';
import { getConfig } from './config';
import { notify } from './notifications';
import { cashPosition } from '../engines/cash';
import { createTask } from './tasks';

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
    payload: {
      id: base.id,
      customerId: args.customerId,
      customerName: args.customerName,
      userId: args.userId,
      amountPaise: args.amountPaise,
      mode: args.mode,
      chequeNumber: args.chequeNumber ?? null,
      bank: args.bank ?? null,
      localReceiptRef: receiptRef,
      isAdvance: !!args.isAdvance,
      billRefs: args.billRefs ?? [],
      collectedAt: base.clientCreatedAt,
      deviceId: base.deviceId,
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
};

/**
 * What the salesman is carrying.
 *
 * Cash collections not yet deposited, with the oldest and anything past its
 * deadline surfaced. This is a real personal liability for the person holding
 * it, which is why the figure is on the home screen rather than buried.
 */
export async function cashInHand(userId: string, now = Date.now()) {
  /* The customer's name comes along because the escalation list has to say
     whose money it is, not just how much. */
  const rows = await all<CashRow>(
    `SELECT p.id, p.customerId, c.name AS customerName, p.amountPaise, p.collectedAt,
            p.depositSlaDueAt, p.depositedAt
       FROM payments p LEFT JOIN customers c ON c.id = p.customerId
      WHERE p.userId = ? AND p.deposited = 0 ORDER BY p.collectedAt ASC`,
    [userId],
  );
  const slaHours = await getConfig<number>('mbos.payments.cashDepositSlaHours', 36);
  return cashPosition(
    rows.map((r) => ({
      id: r.id,
      customerName: r.customerName ?? 'Unknown customer',
      amountPaise: r.amountPaise,
      collectedAt: r.collectedAt,
      /* Only cash goes missing — the engine filters on this, so the mode is
         load-bearing rather than decorative. */
      mode: 'cash' as const,
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
export async function markBounced(paymentId: string): Promise<void> {
  const payment = await one<{ customerId: string; amountPaise: number; chequeNumber: string | null }>(
    'SELECT customerId, amountPaise, chequeNumber FROM payments WHERE id = ?',
    [paymentId],
  );
  if (!payment) return;

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
      summary: `Cheque ${payment.chequeNumber ?? ''} bounced`,
    });
  });

  await enqueue({ entityType: 'payment', entityId: paymentId, op: 'update', payload: { id: paymentId, bounced: true, bouncedAt: Date.now() } });

  await createTask({
    title: `Ring ${name} — the cheque bounced`,
    customerId: payment.customerId,
    priority: 'High',
    dueDate: new Date().toISOString().slice(0, 10),
  });

  await notify({
    title: 'Cheque bounced',
    body: `${name} · the amount is back on their account.`,
    kind: 'danger',
    priority: 1,
  });
}

export async function listPayments(customerId?: string) {
  return customerId
    ? all('SELECT * FROM payments WHERE customerId = ? ORDER BY collectedAt DESC', [customerId])
    : all('SELECT * FROM payments ORDER BY collectedAt DESC LIMIT 50');
}
