import { all, newId, one } from '../db';
import {
  CUSTOMER_PAGE,
  cityOriginsQuery,
  customerCountQuery,
  customerPageQuery,
  type BookView,
  type Origin,
} from './customer-query';
import { enqueue } from '../sync/queue';
import { insertAndQueue, insertLocal, stamp } from './write';

/*
 * WHAT A CARD SAYS ABOUT A ROW lives in `lib/account-label.ts` and is
 * re-exported here, where every caller already looked for it.
 *
 * It left because this file imports the database and therefore cannot be
 * tested without a handset — and these three decide the words on four hundred
 * rows a salesman reads a day. `customerStage` shipped with a branch comparing
 * against two values the `customer_status` enum cannot produce, so it could
 * never fire, and nothing anywhere noticed: there was no test that could.
 */
export { accountLine, accountType, customerStage } from '../lib/account-label';

/**
 * The retention band, exactly as the server computes and sends it.
 *
 * Declared HERE, in the data layer, because this is the wire shape — the
 * component that draws it imports this rather than keeping its own copy of the
 * four words. Two copies of a four-value union is how the fifth rendering of
 * customer health came to exist in the first place.
 */
export type HealthBandValue = 'active' | 'at-risk' | 'dormant' | 'lost';

/**
 * WHERE OUTSTANDING TURNS RED — ONE NUMBER, NOT TWO.
 *
 * `dues > 300000` was written out as a literal on the list card and again on
 * the record head, in two files, which is a business number living in a screen
 * and a second copy of it waiting to disagree. The day one moves, the list and
 * the record say different things about the same shop one tap apart — the
 * drift the health thresholds beside it were made configuration to end.
 *
 * It is PAISE, like every other money figure on the handset, and it is a
 * constant here rather than a `getConfig` key because there is no such key in
 * MahekOne's own registry to read: an `mbos.*` key the server never sends is a
 * setting a manager can see and cannot change, which is worse than an honest
 * constant. Adding it there is the fix; this is the half that stops the two
 * copies drifting in the meantime.
 */
export const OUTSTANDING_ALERT_PAISE = 30_000_000;

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
  /**
   * The lead's own facts, from `LEAD_FACTS` in `customer-query.ts`. Absent on
   * every other read of this table — `getCustomer` selects `*` from
   * `customers` alone — which is why all three are optional rather than
   * nullable: undefined means nobody asked, and null would claim we did.
   */
  isLead?: number;
  leadFunnelStage?: string | null;
  leadStage?: string | null;
  healthScore: number | null;
  /**
   * The retention band, computed by the server from the customer's own buying
   * cycle — 'active' | 'at-risk' | 'dormant' | 'lost'. Null where they have
   * never ordered, which is not a band: they have not stopped buying, they
   * have not started.
   */
  healthBand: HealthBandValue | null;
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
  /** The tier `price_list` is keyed on for this account — "DEALER", and so on. */
  priceTag: string | null;
  /** When this row was last refreshed from MahekOne. Shown wherever a
   *  decision hangs on the figures — credit limit and outstanding above all. */
  lastSyncedAt: number;
  /** Squared degrees from the origin the page was sorted by, when there was
   *  one. `metresFromDist2` is the only thing that reads it. */
  dist2?: number | null;
  /** `customer` or `lead`. Null on a row synced before migration v12. */
  kind?: string | null;
};

export type CustomerPage = {
  rows: Customer[];
  /** How many MATCH, from SQL. Never how many happen to be loaded. */
  total: number;
  hasMore: boolean;
};

/**
 * One page of the book, nearest first — the SQL is in `customer-query.ts`.
 *
 * This function is the only thing that touches the database; everything about
 * WHAT is asked lives next door, pure, where a test can run it against a real
 * SQLite and check that a distance ordering actually orders by distance.
 */
export async function listCustomersPage(args: {
  query?: string;
  origin?: Origin;
  /** Customers, leads, or the whole book. See `BookView`. */
  view?: BookView;
  offset?: number;
  limit?: number;
} = {}): Promise<CustomerPage> {
  const offset = args.offset ?? 0;

  /* The SAME view goes to both, or the screen prints a total over a list that
     does not match it. */
  const count = customerCountQuery(args.query, args.view);
  const totalRow = await one<{ n: number }>(count.sql, count.params);
  const total = totalRow?.n ?? 0;

  const page = customerPageQuery({ ...args, offset });
  const rows = await all<Customer>(page.sql, page.params);

  return { rows, total, hasMore: offset + rows.length < total };
}

/**
 * Names for a handful of ids.
 *
 * The Tasks screen used to read the WHOLE book to turn a task's customer id
 * into a name — five thousand rows held in memory to render a dozen labels.
 * A task list shows the tasks it has, so it asks for the names it needs.
 */
export async function customerNames(ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return new Map();
  const rows = await all<{ id: string; name: string }>(
    `SELECT id, name FROM customers WHERE id IN (${wanted.map(() => '?').join(',')})`,
    wanted,
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The towns this book actually sells into, each with its centre. */
export async function cityOrigins(): Promise<{ city: string; lat: number; lng: number; n: number }[]> {
  const q = cityOriginsQuery();
  return all<{ city: string; lat: number; lng: number; n: number }>(q.sql, q.params);
}

/**
 * The whole book, for a caller that genuinely needs every row.
 *
 * Kept, and kept honest: this is a LOOKUP, not a list to draw. Anything that
 * renders what this returns has the bug `CUSTOMER_PAGE` exists to prevent.
 */
export async function listCustomers(query = ''): Promise<Customer[]> {
  const q = customerPageQuery({ query, limit: -1 });
  return all<Customer>(q.sql, q.params);
}

export type CustomerOrder = {
  id: string;
  customerId: string;
  orderedAt: string | null;
  status: string | null;
  valuePaise: number | null;
  lines: number | null;
  orderNo: string | null;
};

export type CustomerPayment = {
  id: string;
  customerId: string;
  receivedAt: string | null;
  amountPaise: number | null;
  mode: string | null;
  reference: string | null;
  status: string | null;
};

/**
 * One open bill, as Accounts holds it.
 *
 * `balancePaise` is what is still open. On an `unstated` bill that is the full
 * amount purely because nobody has recorded anything against it either way —
 * it is NOT a debt, the office keeps it out of the outstanding figure, and the
 * screen has to say which kind of number it is rather than printing it beside
 * real balances.
 */
export type CustomerBill = {
  id: string;
  customerId: string;
  billNo: string | null;
  billDate: string | null;
  dueDate: string | null;
  amountPaise: number | null;
  paidPaise: number | null;
  balancePaise: number | null;
  overdueDays: number | null;
  disputed: number | null;
  paymentPosition: string | null;
};

/**
 * What the office knows this shop bought and paid.
 *
 * Read-only, and capped at ten of each by the server. The screen says so —
 * a list that is a slice has to admit it, or the salesman reads ten orders as
 * the whole history and tells the customer so.
 */
export async function customerOrders(id: string): Promise<CustomerOrder[]> {
  return all<CustomerOrder>(
    'SELECT * FROM customer_orders WHERE customerId = ? ORDER BY orderedAt DESC, id DESC',
    [id],
  );
}

export async function customerPayments(id: string): Promise<CustomerPayment[]> {
  return all<CustomerPayment>(
    'SELECT * FROM customer_payments WHERE customerId = ? ORDER BY receivedAt DESC, id DESC',
    [id],
  );
}

/**
 * The open bills behind the shop's outstanding, oldest first.
 *
 * Oldest first because that is the order they are chased in and the order the
 * automatic spread settles them in — so the list a salesman reads and the
 * allocation the server would make on its own tell the same story.
 *
 * These are the office's, read-only, and replaced wholesale on every pull. A
 * settled bill is gone from the next pass rather than left here to be offered.
 */
export async function customerBills(id: string): Promise<CustomerBill[]> {
  return all<CustomerBill>(
    'SELECT * FROM customer_bills WHERE customerId = ? ORDER BY billDate ASC, id ASC',
    [id],
  );
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
export async function customersWithoutGps(): Promise<{ rows: Customer[]; total: number }> {
  /* Capped and counted like every other read of the book. Nothing calls this
     yet, which is exactly why the cap goes on now: 487 of the 1,076 shops on a
     real handset have no coordinate, so the screen this is waiting for would
     mount half the territory on its first render and freeze the app the way
     the pick list did. */
  const counted = await one<{ n: number }>(
    'SELECT COUNT(*) AS n FROM customers WHERE gpsLat IS NULL OR gpsLng IS NULL',
  );
  const rows = await all<Customer>(
    `SELECT * FROM customers
      WHERE gpsLat IS NULL OR gpsLng IS NULL
      ORDER BY name LIMIT ${CUSTOMER_PAGE}`,
  );
  return { rows, total: counted?.n ?? rows.length };
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

/**
 * Writing down what was heard.
 *
 * The button above this used to toast "Name and rate is enough" and write
 * nothing — the form the salesman filled in went nowhere. This is the write
 * path that button was always missing.
 */
export async function recordCompetitor(args: {
  customerId: string;
  visitId?: string | null;
  competitorName: string;
  ratePaise: number | null;
  rateNote?: string | null;
  creditTerms?: string | null;
  delivery?: string | null;
  strengths?: string | null;
  weaknesses?: string | null;
}): Promise<string> {
  const base = await stamp('competitor');
  return insertAndQueue({
    table: 'competitor_records',
    entityType: 'competitor',
    dependsOn: args.visitId ? [args.visitId] : [],
    row: {
      ...base,
      customerId: args.customerId,
      visitId: args.visitId ?? null,
      competitorName: args.competitorName,
      ratePaise: args.ratePaise,
      rateNote: args.rateNote ?? null,
      creditTerms: args.creditTerms ?? null,
      delivery: args.delivery ?? null,
      strengths: args.strengths ?? null,
      weaknesses: args.weaknesses ?? null,
      capturedAt: Date.now(),
    },
  });
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

/**
 * Full product records for a set of ids, for "reorder the last order" —
 * `order_lines` keeps only a name and a quantity, never the packing a fresh
 * line needs to derive boxes and litres from.
 */
export async function productsByIds(ids: string[]) {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  return all<{ id: string; name: string; packSize: string | null; cansPerBox: number | null; millilitresPerCan: number | null; sellingPricePaise: number | null; formulation: string | null; brand: string | null }>(
    // Retired since the last order is not re-offered silently.
    `SELECT * FROM products WHERE active = 1 AND id IN (${marks})`,
    ids,
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
