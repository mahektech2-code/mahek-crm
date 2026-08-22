import { all, newId, one } from '../db';
import { enqueue } from '../sync/queue';
import { insertLocal } from './write';

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
  /** Goods come here; the invoice does not. See `billingChoicesFor`. */
  thirdParty: number;
  /** JSON: who invoices this shop instead. `[]` on a direct customer. */
  distributors: string | null;
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


/* ------------------------------------------------- who we bill for a shop */

export type BillingChoice = {
  id: string;
  name: string;
  /** Who serves this shop usually, from the arrangement the office recorded. */
  isPrimary: boolean;
  /**
   * Whether this account is on THIS handset.
   *
   * A billing party has to be a customer in the salesman's own book, because
   * that is the account whose credit limit, term and outstanding decide
   * whether the order can be taken at all. A distributor who belongs to
   * somebody else is still SHOWN — naming who bills the shop is useful even
   * when he cannot write the order — but it cannot be chosen, and the screen
   * says which of the two it is rather than leaving a row that does nothing.
   */
  onBook: boolean;
};

/**
 * Everybody this shop's order could be billed to, best first.
 *
 * THE SHOP ITSELF IS ALWAYS AN OPTION, including where it is marked third
 * party. That is deliberate: a shop we usually serve through a distributor
 * sometimes buys direct, and refusing to express that would make the salesman
 * either abandon the order or file it against a distributor who is not paying
 * for it. `account-types.ts` on the server says the same thing — a third-party
 * customer is still a customer underneath, which is exactly what lets us bill
 * one when it starts ordering.
 *
 * The ORDER of the list is the answer to "who usually": the primary
 * distributor first where there is one, then the others, then the shop itself
 * on a third-party account — and the shop first where it is not, because
 * billing whoever you are standing in front of is the ordinary case.
 */
export async function billingChoicesFor(customer: Customer): Promise<BillingChoice[]> {
  let arrangement: { id: string; name: string; isPrimary: boolean }[] = [];
  try {
    arrangement = JSON.parse(customer.distributors || '[]');
  } catch {
    /* A malformed blob must not take the order screen down with it: the shop
       itself is always billable, so the salesman is never stuck. */
    arrangement = [];
  }

  const ids = arrangement.map((d) => d.id);
  const onBook = new Set<string>();
  if (ids.length) {
    const rows = await all<{ id: string }>(
      `SELECT id FROM customers WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    for (const r of rows) onBook.add(r.id);
  }

  const distributors: BillingChoice[] = arrangement.map((d) => ({
    id: d.id,
    name: d.name,
    isPrimary: Boolean(d.isPrimary),
    onBook: onBook.has(d.id),
  }));
  distributors.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

  const itself: BillingChoice = {
    id: customer.id,
    name: customer.name,
    isPrimary: false,
    // It is the customer whose screen we are on, so it is on the book by
    // definition — there is no way to reach here otherwise.
    onBook: true,
  };

  return customer.thirdParty ? [...distributors, itself] : [itself, ...distributors];
}


/**
 * Everybody on this handset we could put an invoice against.
 *
 * Direct customers only: a shop already marked as one we deliver to and do not
 * bill cannot be the one billed for another. Same rule the console's picker
 * enforces and the server checks again on the way in.
 */
export async function billableCustomers(q?: string): Promise<Customer[]> {
  const term = (q ?? '').trim();
  if (!term) {
    return all<Customer>('SELECT * FROM customers WHERE thirdParty = 0 ORDER BY name LIMIT 50');
  }
  const like = `%${term}%`;
  return all<Customer>(
    `SELECT * FROM customers
      WHERE thirdParty = 0 AND (name LIKE ? OR city LIKE ? OR phone LIKE ?)
      ORDER BY name LIMIT 50`,
    [like, like, like],
  );
}

/* --------------------------------------- a shop opened standing inside it */

/**
 * A delivery shop that is not on the book yet.
 *
 * The case is a salesman in an outlet nobody has recorded, taking an order his
 * distributor will be invoiced for. Without this he either abandons the order
 * or files it as though the distributor received the goods, and where the
 * lorry actually went is lost — which is the very thing the delivery party
 * exists to record.
 *
 * IT IS WRITTEN LOCALLY FIRST and queued, like every other thing this app
 * creates. He is standing in a shop with no signal; the order that follows
 * depends on this row and goes out behind it.
 *
 * THE DUPLICATE IS NOT THIS FUNCTION'S PROBLEM, deliberately. Two salesmen
 * will type a shop's name two ways and neither is wrong, so the office decides
 * — the server writes a conflict against the phone number and somebody merges.
 * Refusing here would teach him to retype the name until it went through,
 * which is how three spellings of one shop get onto the book.
 */
export async function addFieldShop(args: {
  name: string;
  phone: string;
  city: string;
  contactPerson?: string | null;
  /** Who invoices it. Required — a shop we do not bill must say who does. */
  distributorCustomerId: string;
  /**
   * Their NAME, for the row this writes locally.
   *
   * The pull will send it again on the next sync, but that may be hours away
   * and the order he opened this shop to take is happening now — the order
   * screen reads the billing party's name out of this blob, and an empty one
   * would draw "Bill to" with nothing after it.
   */
  distributorName: string;
  gpsLat?: number | null;
  gpsLng?: number | null;
}): Promise<{ ok: true; customerId: string } | { ok: false; message: string }> {
  const name = args.name.trim();
  const phone = args.phone.trim();
  const city = args.city.trim();

  if (!name) return { ok: false, message: 'The shop needs a name.' };
  /* The town is NOT NULL on the office's side, and being refused at sync for a
     field he was never asked for is the worst way to find that out. */
  if (!city) return { ok: false, message: 'Which town is it in?' };
  if (phone.replace(/\D/g, '').length < 6) {
    return { ok: false, message: 'A working phone number, so the office can reach them.' };
  }
  if (!args.distributorCustomerId) {
    return { ok: false, message: 'Say who is billed for this shop.' };
  }

  const customerId = newId('customer');
  const row = {
    id: customerId,
    name,
    contactPerson: args.contactPerson?.trim() || name,
    phone,
    city,
    /* Marked and arranged in the same breath. A shop flagged as one we do not
       bill, with nobody recorded as billing it, is the row the office already
       has a tidying list for. */
    thirdParty: 1,
    distributors: JSON.stringify([
      { id: args.distributorCustomerId, name: args.distributorName, isPrimary: true },
    ]),
    /* Credit, health and outstanding are the office's to decide. A new account
       arrives with none of them rather than with a confident zero. */
    lastSyncedAt: 0,
  };

  await insertLocal('customers', row);

  await enqueue({
    entityType: 'customer',
    entityId: customerId,
    op: 'create',
    payload: {
      id: customerId,
      name,
      contactPerson: row.contactPerson,
      phone,
      city,
      thirdParty: true,
      distributorCustomerId: args.distributorCustomerId,
      gpsLat: args.gpsLat ?? undefined,
      gpsLng: args.gpsLng ?? undefined,
    },
  });

  return { ok: true, customerId };
}
