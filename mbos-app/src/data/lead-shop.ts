/* ---------------------------------------------------------------------------
 * A LEAD AS A SHOP ON THIS PHONE — the pure half, no Expo import, so it is
 * tested against the real schema (`lead-shop.test.ts`). `leads.ts` runs it.
 *
 * At the office a lead IS a `customers` row with the lead's own id, and a
 * visit to it is an ordinary visit. On this phone leads and customers were
 * separate tables, and every way into a visit — the shop card, the journey,
 * Nearby, `TravelGate` — looks the shop up in `customers`. So a lead added at
 * the shop door had no shop to visit until its create had gone up, been
 * accepted and come back down on a later pull: with no signal, never.
 *
 * The row is reference data the next pull replaces with the office's copy
 * (same id), and `reconcileBook` keeps it meanwhile because its id is a live
 * lead. INSERT OR IGNORE: a row the office already sent is the better copy.
 * ------------------------------------------------------------------------- */

export type LeadShopInput = {
  id: string;
  name: string;
  company: string | null;
  contactPerson?: string | null;
  mobile: string | null;
  city: string | null;
  area: string | null;
  customerType?: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
};

export const LEAD_SHOP_SQL = `INSERT OR IGNORE INTO customers (id, name, contactPerson, phone, city, area, customerType, gpsLat, gpsLng, kind, lastSyncedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'lead', 0)`;

/** The shop's name leads, as the office shows it; the lead's `name` is the person where a shop name was also given. */
export function leadShopParams(l: LeadShopInput): (string | number | null)[] {
  const shop = l.company?.trim() || l.name.trim();
  const person = l.contactPerson?.trim() || (l.company?.trim() ? l.name.trim() : null);
  return [l.id, shop, person, l.mobile, l.city?.trim() || null, l.area?.trim() || null, l.customerType ?? null, l.gpsLat, l.gpsLng];
}

/** Why a lead cannot be visited from its own record, or null when it can. */
export function leadVisitRefusal(l: { archived: number; syncState: string }): string | null {
  if (l.syncState === 'rejected' || l.syncState === 'blocked')
    return 'The office did not take this lead — most often the shop is already in the book under this number. Open that shop and visit it there.';
  if (l.archived) return 'This lead is filed. Bring it back to visit it.';
  return null;
}

/**
 * A REFUSED lead's phone-only shop row goes. The office did not take the lead —
 * most often because the shop is already in the book — so the row this phone
 * wrote for it is a second copy of a real shop in Customers, Nearby and the
 * journey picker. Only the phone's own copy (`lastSyncedAt = 0`, `kind = 'lead'`)
 * is removed; a row the office ever sent is left to the reconcile.
 */
export const DROP_PHONE_LEAD_SHOP_SQL = `DELETE FROM customers WHERE id = ? AND kind = 'lead' AND lastSyncedAt = 0`;

/** Whether this lead's create was refused, read off the outbox — an edit since does not clear it. */
export const LEAD_CREATE_REFUSED_SQL = `SELECT 1 AS refused FROM sync_queue WHERE entityId = ? AND entityType = 'lead' AND op = 'create' AND state = 'rejected' LIMIT 1`;
