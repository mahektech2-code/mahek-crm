/**
 * THE SHAPE OF A FIELD DAY'S EDGES, as statements and pure rules.
 *
 * Punch, trip, arrival, visit and the plan each have an edge where one runs
 * into another — a reassignment under an open visit, a pick made before the
 * day reached the office, a punch-out with a visit still running. The
 * modules that act on those edges import the database or Expo, so nothing in
 * them can be exercised without a handset; what decides each edge lives here
 * instead, imports nothing, and is run against the real handset schema in
 * `day-shape.test.ts` the way `lead-shop.ts` is.
 */

/**
 * The shops with a journey he is on, or one he finished and has not yet
 * spent on a visit. A closed, unbound leg is an arrival in all but the
 * record — but only for a day, because an abandoned trip stays unbound for
 * ever. One bound value: the earliest `endedAt` still counted.
 */
export const IN_FLIGHT_LEG_SHOPS_SQL = `SELECT DISTINCT customerId FROM travel_legs
  WHERE origin = 'visit' AND customerId IS NOT NULL AND visitId IS NULL
    AND (endedAt IS NULL OR endedAt >= ?)`;

/** How far back a closed, unbound leg still holds its shop on the phone. */
export const IN_FLIGHT_LEG_WINDOW_MS = 86_400_000;

/** The half-finished order and payment, and the shop they were built for. */
export type DraftCart = {
  cartFor: string;
  cart: Record<string, string>;
  oQ: string;
  payMode: string | null;
  payAmt: string;
  payChq: string;
};

/**
 * WHAT HAPPENS TO THE CART WHEN HE OPENS ANOTHER SHOP.
 *
 * A draft belongs to a shop, so moving to a different one clears it — the
 * rule `draftMovedShop` in the store was written for, after three lines typed
 * at one counter turned up priced against the next. But a visit is a shop he
 * is STANDING in, and opening a second shop's record mid-visit — to check
 * whose the godown next door is, to answer a call about another account — is
 * not leaving it. The clear took the visit's cart with it, so he came back to
 * the counter with nothing in the order he had been building for ten minutes.
 *
 * So the cart of the shop he is checked into (`visitShopId`) is SET ASIDE on
 * the way out rather than thrown away, the other shop opens on an empty one as
 * it always did, and the visit's cart comes back the moment he returns to it.
 * With no visit running nothing is kept aside, which is the old rule exactly.
 */
export function moveDraft(
  cur: DraftCart & { visitCartStash: DraftCart | null },
  nextCustId: string,
  visitShopId: string | null,
): Partial<DraftCart & { visitCartStash: DraftCart | null }> {
  if (nextCustId === cur.cartFor) return {};
  const empty = { cartFor: nextCustId, cart: {}, oQ: '', payMode: null, payAmt: '', payChq: '' };
  if (!visitShopId) return { ...empty, visitCartStash: null };
  if (nextCustId === visitShopId && cur.visitCartStash?.cartFor === visitShopId) {
    return { ...cur.visitCartStash, visitCartStash: null };
  }
  if (cur.cartFor === visitShopId) {
    const { cartFor, cart, oQ, payMode, payAmt, payChq } = cur;
    return { ...empty, visitCartStash: { cartFor, cart, oQ, payMode, payAmt, payChq } };
  }
  return empty;
}

/**
 * A DAY HE PLANNED THAT THE OFFICE HAD ALREADY PROPOSED, adopted.
 *
 * He plans Thursday on the phone; between him opening the form and it
 * reaching the office, his manager proposes Thursday too. One row per person
 * per day, so the office answers his create with ITS day's id — and until
 * this existed the phone kept its own id, so the shops he picked for it went
 * up against a day the office had never heard of and were retried for ever.
 * Now the phone takes the office's id: the day row is renamed (or folded into
 * the office's row where a pull already brought it), and everything still
 * waiting in the outbox under the old id — the picks above all — is pointed
 * at the new one.
 *
 * These are the two pure halves: an outbox row's payload and its
 * dependencies, re-pointed. Nothing else in either is touched.
 */
/** A day plan the office filed under its own day's id rather than ours. */
export function adoptsServerId(
  item: { entityType: string; op: string; entityId: string },
  serverId: string | undefined,
): boolean {
  return item.entityType === 'plan_day' && item.op === 'create' && !!serverId && serverId !== item.entityId;
}

export function repointPayload(raw: string, from: string, to: string): string {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || value.id !== from) return raw;
    return JSON.stringify({ ...value, id: to });
  } catch {
    return raw;
  }
}

export function repointDependsOn(raw: string, from: string, to: string): string {
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list) || !list.includes(from)) return raw;
    return JSON.stringify(list.map((d) => (d === from ? to : d)));
  } catch {
    return raw;
  }
}

/**
 * THE FIRST CHECK-IN PINS THE SHOP ON THE PHONE TOO.
 *
 * The office pins an unpinned shop from the check-in fix (`gps_lat is null`
 * in its statement), and the phone never did — so the shop stayed unpinned
 * here until the next pull, and the very next visit to it, an hour later,
 * asked "Are you at this shop?" again and measured nothing. Guarded by
 * `gpsLat IS NULL` in the statement for the office's reason: a pin already
 * there, from the office or an earlier visit, is never moved by this.
 * Bound values: lat, lng, accuracy, customer id.
 */
export const PIN_UNPINNED_SHOP_SQL = `UPDATE customers
  SET gpsLat = ?, gpsLng = ?, gpsAccuracyM = ?
  WHERE id = ? AND gpsLat IS NULL`;
