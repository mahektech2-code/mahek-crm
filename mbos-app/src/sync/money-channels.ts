/* ---------------------------------------------------------------------------
 * FOUR MONEY CHANNELS ON THE PULL, as the statements that apply them — pure,
 * no Expo import, so `money-channels.test.ts` runs them against the real
 * handset schema. `pull.ts` runs them inside its transaction.
 *
 *  - `openOrdered`: ordered, not yet invoiced, per billing party — the
 *    office's figure (`openOrderedFor`), written over
 *    `customers.submittedNotInvoicedPaise`. Sent WHOLE, so a shop not listed
 *    has nothing open and is zeroed.
 *  - `priceKeys`, `priceUnoffered`: which shops' rates sit under a key other
 *    than their tag, and what their list does not sell them. Replaced whole.
 *  - `myPayments`: the office's word on each receipt he reported, onto his own
 *    `payments` row: status, reason, the real receipt number.
 *
 * Each is ABSENT from an older server, and absent changes nothing — zeroing
 * the book because a field did not arrive would be the wire failing silently
 * in the worst direction.
 * ------------------------------------------------------------------------- */

export type Statement = [sql: string, params: (string | number | null)[]];

export function openOrderedStatements(rows: unknown[] | undefined): Statement[] {
  if (!Array.isArray(rows)) return [];
  const out: Statement[] = [['UPDATE customers SET submittedNotInvoicedPaise = 0 WHERE submittedNotInvoicedPaise <> 0', []]];
  for (const raw of rows) {
    const r = raw as { customerId?: unknown; paise?: unknown };
    if (typeof r.customerId !== 'string') continue;
    const paise = Math.max(0, Math.round(Number(r.paise) || 0));
    out.push(['UPDATE customers SET submittedNotInvoicedPaise = ? WHERE id = ?', [paise, r.customerId]]);
  }
  return out;
}

export function priceKeyStatements(keys: unknown[] | undefined, unoffered: unknown[] | undefined): Statement[] {
  const out: Statement[] = [];
  if (Array.isArray(keys)) {
    out.push(['DELETE FROM customer_price_keys', []]);
    for (const raw of keys) {
      const r = raw as { customerId?: unknown; priceKey?: unknown };
      if (typeof r.customerId !== 'string' || typeof r.priceKey !== 'string') continue;
      out.push(['INSERT OR REPLACE INTO customer_price_keys (customerId, priceKey) VALUES (?, ?)', [r.customerId, r.priceKey]]);
    }
  }
  if (Array.isArray(unoffered)) {
    out.push(['DELETE FROM price_unoffered', []]);
    for (const raw of unoffered) {
      const r = raw as { priceKey?: unknown; productId?: unknown };
      if (typeof r.priceKey !== 'string' || typeof r.productId !== 'string') continue;
      out.push(['INSERT OR REPLACE INTO price_unoffered (priceKey, productId) VALUES (?, ?)', [r.priceKey, r.productId]]);
    }
  }
  return out;
}

/** The office's receipt statuses, as Collections says them. */
export const OFFICE_RECEIPT_WORDS: Record<string, string> = {
  reported: 'With accounts',
  held: 'Accounts are checking',
  confirmed: 'Confirmed by accounts',
  rejected: 'Not found by accounts',
  reversed: 'Taken back by accounts',
};

export function myPaymentStatements(rows: unknown[] | undefined): Statement[] {
  if (!Array.isArray(rows)) return [];
  const out: Statement[] = [];
  for (const raw of rows) {
    const r = raw as { id?: unknown; status?: unknown; receiptNo?: unknown; reason?: unknown; decidedAt?: unknown };
    if (typeof r.id !== 'string' || typeof r.status !== 'string') continue;
    out.push([
      `UPDATE payments SET officeStatus = ?, officeReason = ?, officeDecidedAt = ?,
              receiptNumber = COALESCE(?, receiptNumber)
        WHERE id = ?`,
      [
        r.status,
        typeof r.reason === 'string' ? r.reason : null,
        typeof r.decidedAt === 'number' ? r.decidedAt : null,
        typeof r.receiptNo === 'string' && r.receiptNo ? r.receiptNo : null,
        r.id,
      ],
    ]);
  }
  return out;
}

/**
 * AN EXPENSE THE OFFICE DELETED, which this phone used to keep as pending for
 * ever. Only an office-entered line is ever tombstoned (`deleteEnteredExpense`)
 * — but `expenses` is an OWNED table, so the delete is still guarded the way
 * every owned write is: a row with anything waiting in the outbox stays.
 */
export function expenseTombstoneStatement(ids: string[]): Statement | null {
  if (!ids.length) return null;
  const marks = ids.map(() => '?').join(',');
  return [
    `DELETE FROM expenses WHERE id IN (${marks})
        AND COALESCE(syncState, 'synced') = 'synced'
        AND NOT EXISTS (SELECT 1 FROM sync_queue q WHERE q.entityId = expenses.id AND q.state <> 'synced')`,
    ids,
  ];
}
