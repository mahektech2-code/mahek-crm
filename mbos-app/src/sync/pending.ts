/**
 * "HAS THIS HANDSET SAID SOMETHING THE OFFICE HAS NOT HEARD YET", as SQL.
 *
 * Pure — no database import — so the clauses can be run against a real SQLite
 * in `pending.test.ts`. `pull.ts` imports expo-sqlite at module scope and
 * cannot be loaded under `tsx --test`, which is how a clause written inline
 * there goes unexercised until it is on somebody's phone.
 */

/** The outbox states that mean "not yet heard by the office". */
export const PENDING_STATES = "('queued','syncing','failed','blocked')";

/** No queued item for this row. The guard every owned table's upsert carries. */
export function noPending(table: string): string {
  return `NOT EXISTS (SELECT 1 FROM sync_queue q WHERE q.entityId = ${table}.id AND q.state IN ${PENDING_STATES})`;
}

/**
 * THE SAME GUARD FOR A LEAD, which also has to read the VISIT queue.
 *
 * A Suspect decision taken at the end of a visit is written onto the local
 * `leads` row (`data/visits.ts`) but travels to the office INSIDE the visit —
 * the queued item is the visit, keyed on the visit's id, not the lead's. So
 * `noPending('leads')` found nothing pending, the very next pull wrote the
 * office's older rung back over the decision, and the lead slid back down the
 * ladder until the visit landed. A pending visit whose payload names this shop
 * and carries a decision or its reason is the lead's own pending change.
 *
 * `json_valid` first and `json_extract` only inside the CASE: a payload that is
 * not JSON must answer "not this lead", never throw and take the pull with it.
 */
export function noPendingLead(table = 'leads'): string {
  const field = (path: string) =>
    `CASE WHEN json_valid(v.payload) THEN json_extract(v.payload, '$.${path}') END`;
  return `${noPending(table)} AND NOT EXISTS (SELECT 1 FROM sync_queue v
      WHERE v.entityType = 'visit' AND v.state IN ${PENDING_STATES}
        AND ${field('customerId')} = ${table}.id
        AND (${field('suspectDecision')} IS NOT NULL OR ${field('suspectReason')} IS NOT NULL))`;
}

/**
 * THE COLUMNS A SALESMAN EDITS ON A SHOP, held against the pull while his edit
 * is on its way.
 *
 * `customers` is reference data and every pull wrote the office's copy over
 * it whole — so a contact, a number or a pin he had just corrected on the card
 * (`editShop`) went back to the office's older value on the very next pull,
 * before the edit had even left, and the card read as though he had saved
 * nothing. Only these columns are held, and only while a `customer` item for
 * this shop is pending: the office's credit, outstanding and health go on
 * arriving, because a refused edit must never freeze a shop's money.
 */
export const SHOP_EDIT_COLUMNS = ['contactPerson', 'phone', 'gpsLat', 'gpsLng', 'gpsAccuracyM'] as const;

/** A shop edit (or create) of this row still on its way to the office. */
export function pendingShopEdit(table = 'customers'): string {
  return `EXISTS (SELECT 1 FROM sync_queue q WHERE q.entityId = ${table}.id AND q.entityType = 'customer' AND q.state IN ${PENDING_STATES})`;
}

/**
 * The `ON CONFLICT … DO UPDATE SET` list for an upsert, with `hold` columns
 * keeping their local value while `hold.while` is true. Pure, so the clause
 * runs against a real SQLite in `pending.test.ts`.
 */
export function upsertSets(
  table: string,
  cols: string[],
  key: string,
  hold?: { cols: readonly string[]; while: string },
): string {
  const held = new Set(hold?.cols ?? []);
  return cols
    .filter((c) => c !== key)
    .map((c) =>
      hold && held.has(c)
        ? `${c} = CASE WHEN ${hold.while} THEN ${table}.${c} ELSE excluded.${c} END`
        : `${c} = excluded.${c}`,
    )
    .join(', ');
}
