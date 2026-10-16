import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/* ---------------------------------------------------------------------------
 * ONE PAGE, ONE READ OF EACH LEDGER.
 *
 * Stock is computed from the whole of its history (`stock.ts`), and a screen
 * asks for it through several doors at once — the list's own rows, the new
 * form's lot picker, the rate behind a costing column, a level beside it.
 * Each door asked the database again: on the real book the SFG batch screen
 * read the raw-material ledger five times for one page, a fifth of a second
 * apiece.
 *
 * Inside `withReadMemo` an identical statement is asked once and every caller
 * shares the answer. Only a PAGE opens one, and a page writes nothing, so a
 * shared answer cannot be stale: a server action runs outside it and always
 * reads afresh, and a statement run on a transaction never comes here at all.
 * ------------------------------------------------------------------------- */

const store = new AsyncLocalStorage<Map<string, Promise<unknown>>>();
const dialect = new PgDialect();

/** Runs a page's reads with identical statements answered once. */
export function withReadMemo<T>(fn: () => Promise<T>): Promise<T> {
  return store.getStore() ? fn() : store.run(new Map(), fn);
}

/**
 * The statement's answer, shared with every identical statement in the same
 * page; outside a page it simply runs. Callers must treat the rows as read
 * only — every caller in `stock.ts` maps them into objects of its own.
 */
export function readOnce<T>(q: SQL, run: () => Promise<T>): Promise<T> {
  const memo = store.getStore();
  if (!memo) return run();
  const key = statementKey(q);
  let p = memo.get(key) as Promise<T> | undefined;
  if (!p) {
    p = run();
    memo.set(key, p);
    p.catch(() => memo.delete(key));
  }
  return p;
}

/** A statement's identity: its text and its parameters. */
export function statementKey(q: SQL): string {
  const { sql, params } = dialect.sqlToQuery(q);
  return `${sql}\u0000${JSON.stringify(params)}`;
}
