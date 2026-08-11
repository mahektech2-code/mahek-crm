import { all, one } from '../db';

/**
 * Reading the book.
 *
 * Every one of these hits SQLite and returns. Nothing here is async because of
 * a network — it is async because storage is, and that is a millisecond, not a
 * tower.
 */

export type Customer = {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  city: string | null;
  area: string | null;
  beat: string | null;
  territoryRegion: string | null;
  gstin: string | null;
  dealerCode: string | null;
  customerType: string | null;
  potential: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  gpsAccuracyM: number | null;
  creditLimitPaise: number | null;
  creditDays: number | null;
  creditBlocked: number;
  creditBlockReason: string | null;
  outstandingPaise: number;
  submittedNotInvoicedPaise: number;
  healthScore: number | null;
  healthComponents: string | null;
  lastOrderDate: string | null;
  lastVisitDate: string | null;
  visitFrequencyDays: number | null;
  cycleDays: number | null;
  payBehaviour: string | null;
  status: string | null;
  /** When this row was last refreshed from MahekOne. Shown wherever a
   *  decision hangs on the figures — credit limit and outstanding above all. */
  lastSyncedAt: number;
};

export async function listCustomers(query = ''): Promise<Customer[]> {
  const q = query.trim().toLowerCase();
  if (!q) return all<Customer>('SELECT * FROM customers ORDER BY name');
  /* Name, owner, city, phone and GST — because a salesman looking somebody up
     mid-conversation has whichever of those the customer just said. */
  const like = `%${q}%`;
  return all<Customer>(
    `SELECT * FROM customers
      WHERE lower(name) LIKE ? OR lower(COALESCE(contactPerson,'')) LIKE ?
         OR lower(COALESCE(city,'')) LIKE ? OR COALESCE(phone,'') LIKE ?
         OR lower(COALESCE(gstin,'')) LIKE ? OR lower(COALESCE(dealerCode,'')) LIKE ?
      ORDER BY name`,
    [like, like, like, like, like, like],
  );
}

/**
 * The word on the card: Active, At risk, Overdue.
 *
 * MahekOne owns it and sends it down in `status`; the health band is only the
 * fallback for a row that arrived without one, because a card with a blank
 * where the verdict goes is a card nobody trusts.
 */
export function customerStage(c: Pick<Customer, 'status' | 'healthScore'>): 'Active' | 'At risk' | 'Overdue' {
  if (c.status === 'Overdue' || c.status === 'At risk' || c.status === 'Active') return c.status;
  if (c.healthScore == null) return 'Active';
  return c.healthScore < 40 ? 'Overdue' : c.healthScore < 60 ? 'At risk' : 'Active';
}

/** Whole days since a `YYYY-MM-DD`, or null when there is no date to count from. */
export function daysSince(date: string | null, today: string): number | null {
  if (!date) return null;
  const a = new Date(date + 'T00:00:00').getTime();
  const b = new Date(today + 'T00:00:00').getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export async function getCustomer(id: string): Promise<Customer | null> {
  return one<Customer>('SELECT * FROM customers WHERE id = ?', [id]);
}

/**
 * Customers with no coordinates.
 *
 * The brief requires these to be surfaced and countable: route optimisation
 * and visit validation both depend on coordinates, and if most of the book is
 * missing them then capturing them is an early field task rather than a
 * background nicety.
 */
export async function customersWithoutGps(): Promise<Customer[]> {
  return all<Customer>('SELECT * FROM customers WHERE gpsLat IS NULL OR gpsLng IS NULL ORDER BY name');
}

/**
 * What the book owes, in one figure and one count.
 *
 * The number on Home and the number on the collections list have to be the
 * same number, so both read this rather than each summing their own rows.
 */
export async function collectionDue(): Promise<{ totalPaise: number; customers: number }> {
  const row = await one<{ total: number; n: number }>(
    'SELECT COALESCE(SUM(outstandingPaise), 0) AS total, COUNT(*) AS n FROM customers WHERE outstandingPaise > 0',
  );
  return { totalPaise: row?.total ?? 0, customers: row?.n ?? 0 };
}

export type TimelineEvent = {
  id: string;
  customerId: string;
  eventType: string;
  sourceApp: string;
  sourceRecordId: string | null;
  occurredAt: number;
  actor: string | null;
  summary: string;
  meta: string | null;
};

/**
 * One stream, written by both apps.
 *
 * A telecaller's call from yesterday sits in here beside this morning's visit,
 * which is the entire reason the two apps share a table rather than each
 * keeping their own history.
 */
export async function customerTimeline(customerId: string, filter = 'All'): Promise<TimelineEvent[]> {
  const rows = await all<TimelineEvent>(
    'SELECT * FROM timeline_events WHERE customerId = ? ORDER BY occurredAt DESC LIMIT 100',
    [customerId],
  );
  if (filter === 'All') return rows;
  const wanted: Record<string, string[]> = {
    Visits: ['visit'],
    Orders: ['order'],
    Payments: ['payment'],
    Calls: ['call', 'telecaller_call'],
    Complaints: ['complaint'],
  };
  const kinds = wanted[filter];
  return kinds ? rows.filter((r) => kinds.includes(r.eventType)) : rows;
}

export async function competitorRecords(customerId: string) {
  return all<{
    id: string; competitorName: string; ratePaise: number | null; rateNote: string | null;
    creditTerms: string | null; delivery: string | null; strengths: string | null;
    weaknesses: string | null; capturedAt: number;
  }>('SELECT * FROM competitor_records WHERE customerId = ? ORDER BY capturedAt DESC', [customerId]);
}

/** Products this customer has actually bought, most-ordered first. */
export async function frequentProducts(customerId: string, limit = 6) {
  return all<{ id: string; name: string; packSize: string | null; cansPerBox: number | null; sellingPricePaise: number | null; n: number }>(
    `SELECT p.*, COUNT(ol.id) AS n
       FROM order_lines ol
       JOIN orders o ON o.id = ol.orderId
       JOIN products p ON p.id = ol.productId
      WHERE o.customerId = ? AND p.active = 1
      GROUP BY p.id
      ORDER BY n DESC, p.name
      LIMIT ?`,
    [customerId, limit],
  );
}

export async function searchProducts(query: string, limit = 20) {
  const like = `%${query.trim().toLowerCase()}%`;
  return all<{ id: string; name: string; packSize: string | null; cansPerBox: number | null; millilitresPerCan: number | null; sellingPricePaise: number | null; formulation: string | null; brand: string | null }>(
    `SELECT * FROM products
      WHERE active = 1 AND (lower(name) LIKE ? OR lower(COALESCE(formulation,'')) LIKE ? OR lower(COALESCE(brand,'')) LIKE ?)
      ORDER BY name LIMIT ?`,
    [like, like, like, limit],
  );
}

/** A short starter list, so an order form is not an empty search box mid-call. */
export async function starterProducts(limit = 8) {
  return all<{ id: string; name: string; packSize: string | null; cansPerBox: number | null; millilitresPerCan: number | null; sellingPricePaise: number | null }>(
    'SELECT * FROM products WHERE active = 1 ORDER BY displayOrder, name LIMIT ?'.replace('displayOrder, ', ''),
    [limit],
  );
}
