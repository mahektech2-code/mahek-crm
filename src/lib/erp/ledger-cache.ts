import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { readOnce, statementKey } from "./read-memo";

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

/** A handful of statements, each one ledger: kept by recency, the oldest dropped past this. */
const MAX_KEPT = 48;
const kept = new Map<string, { stamp: string; value: Promise<unknown> }>();

/** The stamp now — asked once per page inside `withReadMemo`, every time outside it. */
function currentStamp(): Promise<string> {
  return readOnce(STAMP, async () => {
    const rows = (await db.execute(STAMP)) as unknown as { s: string }[];
    return String(rows[0]?.s ?? "");
  });
}

/** The statement's answer as of the ledgers' last committed write, from the pool. */
export async function ledgerRead<T>(q: SQL, run: () => Promise<T>): Promise<T> {
  const key = statementKey(q);
  const stamp = await currentStamp();
  const at = kept.get(key);
  if (at && at.stamp === stamp) {
    kept.delete(key);
    kept.set(key, at);
    return at.value as Promise<T>;
  }
  const value = run();
  const entry = { stamp, value };
  kept.set(key, entry);
  value.catch(() => {
    if (kept.get(key) === entry) kept.delete(key);
  });
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
  return value;
}
