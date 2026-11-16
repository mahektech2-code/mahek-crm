import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";
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

const store = new AsyncLocalStorage<Map<string, unknown>>();
const dialect = new PgDialect();

/** Runs a page's reads with identical statements answered once. */
export function withReadMemo<T>(fn: () => Promise<T>): Promise<T> {
  return store.getStore() ? fn() : store.run(new Map<string, unknown>(), fn);
}

/*
 * ONE MAP FOR THE WHOLE RENDER, layout and page alike.
 *
 * The ERP's layout counts its sidebar badges inside a memo of its own and the
 * list page reads inside another, so the two never shared an answer: on
 * Orders the open order book — the biggest read in the ERP — was read once for
 * the badges and again for the tab strip and the list, on every load, every
 * tab click and every refresh after a save. React's `cache` hands every caller
 * in one render the same map, so the layout and the page now share it; outside
 * a render (a test, a server action, a job) there is no render to share and
 * each call gets a fresh map, exactly as `withReadMemo` does.
 *
 * Only for a render that WRITES NOTHING. Logistics brings its transport rows up
 * to date as it loads, so it keeps a memo of its own.
 */
const renderMap = cache(() => new Map<string, unknown>());

/** `withReadMemo`, sharing its answers with every other reader in the same React render. */
export function withRenderMemo<T>(fn: () => Promise<T>): Promise<T> {
  return store.getStore() ? fn() : store.run(renderMap(), fn);
}

/**
 * The statement's answer, shared with every identical statement in the same
 * page; outside a page it simply runs. Callers must treat the rows as read
 * only — every caller in `stock.ts` maps them into objects of its own.
 */
export function readOnce<T>(q: SQL, run: () => Promise<T>): Promise<T> {
  if (!store.getStore()) return run();
  return readOnceAt(statementKey(q), run);
}

/** `readOnce` under a statement key the caller has already worked out (`statementShape`). */
export function readOnceAt<T>(key: string, run: () => Promise<T>): Promise<T> {
  const memo = store.getStore();
  if (!memo) return run();
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

/** A statement's identity and how many parameters it carries — the stock cache keeps only short ones. */
export function statementShape(q: SQL): { key: string; params: number } {
  const { sql, params } = dialect.sqlToQuery(q);
  return { key: `${sql}\u0000${JSON.stringify(params)}`, params: params.length };
}

/**
 * A read that is not one statement — `orderLines`, built from six — shared the
 * same way, under a key the caller names. The badges, the dashboard and the
 * list each asked for the open order lines on one page; now the page asks once.
 */
export function readOnceKeyed<T>(key: string, run: () => Promise<T>): Promise<T> {
  const memo = store.getStore();
  if (!memo) return run();
  const k = `keyed\u0000${key}`;
  let p = memo.get(k) as Promise<T> | undefined;
  if (!p) {
    p = run();
    memo.set(k, p);
    p.catch(() => memo.delete(k));
  }
  return p;
}

/**
 * A map the whole page shares under `name`, or null outside a page. For a read
 * asked for BY ID through several doors, each with its own list: the open
 * order lines, this month's dispatches and the returns each name customers,
 * mostly the same ones, and each used to read its list afresh — the
 * dashboard read the customer book five times to draw itself once.
 */
export function pageMap<V>(name: string): Map<string, V> | null {
  const memo = store.getStore();
  if (!memo) return null;
  const k = `map\u0000${name}`;
  let m = memo.get(k) as Map<string, V> | undefined;
  if (!m) {
    m = new Map<string, V>();
    memo.set(k, m);
  }
  return m;
}
