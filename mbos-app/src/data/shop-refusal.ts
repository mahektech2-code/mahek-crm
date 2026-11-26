/* ---------------------------------------------------------------------------
 * A SHOP THE OFFICE REFUSED — the pure half, no Expo import, so it is tested
 * against the real handset schema (`shop-refusal.test.ts`).
 *
 * A shop added at a counter (`addFieldShop`) is written here at once and sent
 * up; the office may refuse it — no distributor it can bill, a number already
 * on the book. That answer used to land in the outbox and nowhere else, so the
 * card looked like every other shop for ever and the order he opened it to take
 * was saved and then blocked behind a create that would never land. The card
 * now says it (the row's `syncState`, which the outbox writes back), and a new
 * order is refused at the door with the office's own reason.
 *
 * Read off the OUTBOX rather than the row for the order gate, as a refused
 * lead is: an edit since re-queues the row and would wipe the row's word.
 * ------------------------------------------------------------------------- */

/** The office's reason for refusing this shop's create, if it did. */
export const SHOP_CREATE_REFUSED_SQL = `SELECT COALESCE(failureReason, '') AS reason FROM sync_queue
  WHERE entityId = ? AND entityType = 'customer' AND op = 'create' AND state = 'rejected' LIMIT 1`;

/** Why an order cannot be taken for this shop on this phone. */
export function shopOrderRefusal(name: string, reason: string | null | undefined): string {
  const why = (reason ?? '').trim();
  return (
    `The office did not take ${name}` +
    (why ? ` — ${why.replace(/[.\s]+$/, '')}.` : '.') +
    ' An order for it cannot be sent. Fix it on Not accepted, or take the order on the shop already in the book.'
  );
}

/** What the card says, or null for a shop with nothing wrong. */
export function shopRefusalLine(c: { syncState?: string | null; syncMessage?: string | null }): string | null {
  if (c.syncState !== 'rejected' && c.syncState !== 'blocked') return null;
  const why = (c.syncMessage ?? '').trim();
  return why || 'The office did not take this shop. See why on Not accepted.';
}
