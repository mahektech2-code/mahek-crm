import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { readOnce, statementShape } from "./read-memo";
import { LEDGER_CACHE_POLICY, StampedRowCache } from "./ledger-cache-policy";

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
 * writes to any table these reads touch (`0269_erp_ledger_ticks.sql`). The
 * stamp is read in the reader's own snapshot, so it moves only once a write
 * has COMMITTED — a form saved in the factory app, a box scanned at dispatch,
 * an import run from a terminal, all alike, with nothing in the app having to
 * remember to say so. A kept answer whose stamp no longer matches is thrown
 * away and read again.
 *
 * The stamp is read BEFORE the ledger, so a kept answer is never older than
 * its stamp; a write landing in between leaves an answer newer than its stamp,
 * which the next reader simply re-reads. A read on a transaction never comes
 * here: whatever is about to SPEND stock reads it afresh under its lock.
 * ------------------------------------------------------------------------- */

const STAMP = sql`select count(*)::text || ':' || coalesce(max(id), 0)::text as s from erp_ledger_ticks`;

/* What may be kept, in rows, and which statements are kept at all: `ledger-cache-policy.ts`. */
const kept = new StampedRowCache<Promise<unknown>>(LEDGER_CACHE_POLICY);

/** The stamp now — asked once per page inside `withReadMemo`, every time outside it. */
function currentStamp(): Promise<string> {
  return readOnce(STAMP, async () => {
    const rows = (await db.execute(STAMP)) as unknown as { s: string }[];
    return String(rows[0]?.s ?? "");
  });
}

/** The statement's answer as of the ledgers' last committed write, from the pool. */
export async function ledgerRead<T>(q: SQL, run: () => Promise<T>): Promise<T> {
  return ledgerReadShaped(statementShape(q), run);
}

/** `ledgerRead` for a statement whose shape the caller has already worked out — building it is not free on a long statement. */
export async function ledgerReadShaped<T>({ key, params }: { key: string; params: number }, run: () => Promise<T>): Promise<T> {
  if (!kept.admits(params)) return run();
  const stamp = await currentStamp();
  const at = kept.get(key, stamp);
  if (at) return at as Promise<T>;
  const value = run();
  /* Kept while it is being read, so two pages asking at once share one read; sized once it lands. */
  kept.set(key, stamp, value, 0);
  value.then(
    (rows) => kept.set(key, stamp, value, Array.isArray(rows) ? rows.length : 1),
    () => kept.drop(key, value),
  );
  return value;
}

/** What the cache holds now. */
export function ledgerCacheSize(): { entries: number; rows: number } {
  return kept.size();
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

const derived = new Map<string, { stamp: string; value: Promise<unknown> }>();

/** `build()` as of the ledgers' last committed write: worked out once per stamp, shared by every page until then. */
export async function ledgerDerived<T>(name: string, build: () => Promise<T>): Promise<T> {
  const stamp = await currentStamp();
  const at = derived.get(name);
  if (at && at.stamp === stamp) return at.value as Promise<T>;
  const value = build();
  derived.set(name, { stamp, value });
  value.catch(() => {
    if (derived.get(name)?.value === value) derived.delete(name);
  });
  return value;
}
