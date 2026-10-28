import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { readOnce, statementShape } from "./read-memo";
import { LEDGER_CACHE_POLICY, LEDGER_CACHE_POLICY_ORDERS, StampedRowCache } from "./ledger-cache-policy";

/* ---------------------------------------------------------------------------
 * STOCK, KEPT BETWEEN REQUESTS — AND NEVER A MOMENT PAST BEING TRUE.
 *
 * Every stock figure in the ERP is computed from the whole history of its
 * ledger (`stock.ts`): on the real book the FG ledger alone is fourteen
 * thousand entries and a fifth of a second to add up, and nearly every screen,
 * the dashboard and the sidebar's badges ask for it. Most of those asks find
 * nothing has moved since the last one.
 *
 * So the answer is kept, under a STAMP: the count and highest id of
 * `erp_ledger_ticks`, a table a trigger adds a row to whenever a statement
 * writes to any table these reads touch (migration 0269). The
 * stamp is read in the reader's own snapshot, so it moves only once a write
 * has COMMITTED — a form saved in the factory app, a box scanned at dispatch,
 * an import run from a terminal, all alike, with nothing in the app having to
 * remember to say so. A kept answer whose stamp no longer matches is thrown
 * away and read again.
 *
 * The stamps are read BEFORE the ledger, so a kept answer is never older than
 * its stamp; a write landing in between leaves an answer newer than its stamp,
 * which the next reader simply re-reads. A read on a transaction never comes
 * here: whatever is about to SPEND stock reads it afresh under its lock.
 * ------------------------------------------------------------------------- */

/*
 * TWO STAMPS, BECAUSE AN ORDER IS NOT STOCK.
 *
 * `erp_orders` and `erp_order_details` carry the trigger because a few reads
 * here do read them — drums sold, boxes dispatched — but the ledgers that cost
 * something to add up (FG, packing, raw material, and the costing chain over
 * them) never do. With one stamp, every order click in the office — Ready,
 * verify, bill, stickers — threw all of those away, and the next page to ask
 * for stock read the whole book again: on prod, a second or more apiece, on
 * the screen somebody had just clicked on. Orders are most of the ERP's writes,
 * so most pages after a write paid it.
 *
 * So the tick names its table (migration 0289) and there are
 * two stamps: STOCK, which every table but those two moves, and ALL, which any
 * write moves — exactly the old stamp. A statement naming either order table
 * is kept under ALL, as before; every other statement under STOCK. Ticks
 * written before the column existed have no table and count as stock, which
 * only ever means one needless re-read.
 * ------------------------------------------------------------------------- */

const ORDER_TABLES = /\berp_order(?:s|_details)\b/;

const STAMP = sql`
  select (count(*) filter (where tbl is null or tbl not in ('erp_orders', 'erp_order_details')))::text || ':' ||
         coalesce(max(id) filter (where tbl is null or tbl not in ('erp_orders', 'erp_order_details')), 0)::text as stock,
         count(*)::text || ':' || coalesce(max(id), 0)::text as "all"
    from erp_ledger_ticks`;

type Stamps = { stock: string; all: string };

/* What may be kept, in rows, and which statements are kept at all: `ledger-cache-policy.ts`.
   One cache per stamp, so a moved ALL stamp empties only what reads orders. */
const kept = new StampedRowCache<Promise<unknown>>(LEDGER_CACHE_POLICY);
const keptWithOrders = new StampedRowCache<Promise<unknown>>(LEDGER_CACHE_POLICY_ORDERS);

/** The stamps now — asked once per page inside `withReadMemo`, every time outside it. */
function currentStamps(): Promise<Stamps> {
  return readOnce(STAMP, async () => {
    const rows = (await db.execute(STAMP)) as unknown as Stamps[];
    return { stock: String(rows[0]?.stock ?? ""), all: String(rows[0]?.all ?? "") };
  });
}

/*
 * WHAT A WORKED-OUT ANSWER READ, so it is kept under the right stamp.
 *
 * `ledgerDerived` builds from several statements, some through caches of
 * their own (`sfgRates` inside `fgRates`), so it cannot be told up front which
 * tables it reads. Every statement a build runs — or finds already answered —
 * says whether it reads orders, into the build's own record here.
 */
const reading = new AsyncLocalStorage<{ orders: boolean }>();

/** A ledger statement is about to be answered: if it reads orders, so does whatever is being built from it. */
export function noteLedgerRead(statementKey: string): void {
  const d = reading.getStore();
  if (d && !d.orders && ORDER_TABLES.test(statementKey)) d.orders = true;
}

/** The statement's answer as of the ledgers' last committed write, from the pool. */
export async function ledgerRead<T>(q: SQL, run: () => Promise<T>): Promise<T> {
  return ledgerReadShaped(statementShape(q), run);
}

/** `ledgerRead` for a statement whose shape the caller has already worked out — building it is not free on a long statement. */
export async function ledgerReadShaped<T>({ key, params }: { key: string; params: number }, run: () => Promise<T>): Promise<T> {
  noteLedgerRead(key);
  const orders = ORDER_TABLES.test(key);
  const cache = orders ? keptWithOrders : kept;
  if (!cache.admits(params)) return run();
  const stamps = await currentStamps();
  const stamp = orders ? stamps.all : stamps.stock;
  const at = cache.get(key, stamp);
  if (at) return at as Promise<T>;
  const value = run();
  /* Kept while it is being read, so two pages asking at once share one read; sized once it lands. */
  cache.set(key, stamp, value, 0);
  value.then(
    (rows) => cache.set(key, stamp, value, Array.isArray(rows) ? rows.length : 1),
    () => cache.drop(key, value),
  );
  return value;
}

/** What the cache holds now. */
export function ledgerCacheSize(): { entries: number; rows: number } {
  const a = kept.size();
  const b = keptWithOrders.size();
  return { entries: a.entries + b.entries, rows: a.rows + b.rows };
}

/* ---------------------------------------------------------------------------
 * WHAT IS WORKED OUT FROM THE LEDGERS, KEPT UNDER THE SAME STAMP.
 *
 * Rows are only half the cost. Every lot's rate is a walk over its fills, its
 * batch lines and its raw-material lots (`fgRates`, `sfgRates`,
 * `packBatchCosting`), done again in JavaScript on every page — and a page
 * asked for the lots it shows, so the statement named thousands of them and
 * was too long to keep at all. Each lot's figure depends only on that lot's
 * own rows, so the whole book's answer, worked out once, is every page's
 * answer until a write moves the stamp.
 *
 * Keyed by NAME, from a fixed set in `stock.ts` — never by anything a page
 * passes — so it holds at most one answer per name and is bounded by the
 * names, not by traffic. An answer read under a stamp that has since moved is
 * worked out again; a failed one is not kept.
 * ------------------------------------------------------------------------- */

type Derived = { stamps: Stamps; value: Promise<unknown>; reads: { orders: boolean } };
const derived = new Map<string, Derived>();

/** `build()` as of the ledgers' last committed write: worked out once per stamp, shared by every page until then. */
export async function ledgerDerived<T>(name: string, build: () => Promise<T>): Promise<T> {
  const stamps = await currentStamps();
  let at = derived.get(name);
  /* Until a build has finished it has read no orders, so an answer still being worked out is shared on the stock stamp. */
  const fresh = at && (at.reads.orders ? at.stamps.all === stamps.all : at.stamps.stock === stamps.stock);
  if (!at || !fresh) {
    const reads = { orders: false };
    const value = reading.run(reads, build);
    at = { stamps, value, reads };
    derived.set(name, at);
    const mine = at;
    value.catch(() => {
      if (derived.get(name) === mine) derived.delete(name);
    });
  }
  const value = (await at.value) as T;
  /* Whatever is being built from this answer read what it read. */
  const d = reading.getStore();
  if (d && at.reads.orders) d.orders = true;
  return value;
}
