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
