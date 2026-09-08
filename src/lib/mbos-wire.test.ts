import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* ---------------------------------------------------------------------------
 * THE HANDSET'S SCHEMA IS THE WIRE CONTRACT, and nothing was checking it.
 *
 * `sync/pull.ts` upserts a pulled row by writing EXACTLY the columns the
 * server sent — `INSERT INTO customers (<every key that arrived>)`. SQLite
 * refuses a column it does not have, so one extra field in a payload throws;
 * and because `applyPull` wraps every table in ONE transaction, that throw
 * rolls back the whole pull. Not the customers — the pull. Products, the price
 * list, the timeline, the journey, the configuration, all of it.
 *
 * That is what an empty book on a working handset looks like from the outside:
 * the salesman signs in, the app opens, everything he authors syncs UP
 * perfectly, and no reference data has ever come down. `signIn` catches the
 * SQLite error, finds it is not an `ApiError`, and falls through to the
 * offline path — which succeeds, because the password was remembered two lines
 * earlier. So there is no error on the screen either.
 *
 * Nothing else can catch this. The server's SQL is a string, the handset's
 * schema is a string in a different project that `tsconfig.json` excludes, and
 * the two are joined only inside a phone. It type-checks, it lints, the
 * integration tests pass, and the APK in somebody's pocket cannot be recalled
 * — which is why the payload has to be trimmed to the handset rather than the
 * handset widened to the payload.
 *
 * This test reads both files as text and asserts the one thing that matters:
 * every column a payload sends has somewhere to land.
 * ------------------------------------------------------------------------- */

const HANDSET_SCHEMA = "mbos-app/src/db/schema.ts";
const SERVICE = "src/lib/services/mbos-service.ts";

/** table -> its columns, read from the migrations the handset actually runs. */
function handsetTables(): Map<string, Set<string>> {
  const src = readFileSync(HANDSET_SCHEMA, "utf8");
  const body = src.slice(src.indexOf("export const MIGRATIONS"));
  const tables = new Map<string, Set<string>>();

  for (const stmt of body.matchAll(/`([^`]*)`/g)) {
    const sql = stmt[1].trim();

    const created = sql.match(/^CREATE TABLE(?: IF NOT EXISTS)? (\w+) \(([\s\S]*)\)\s*;?$/i);
    if (created) {
      const cols = new Set<string>();
      let depth = 0;
      let current = "";
      for (const ch of created[2]) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
          cols.add(current.trim().split(/\s+/)[0]);
          current = "";
        } else current += ch;
      }
      if (current.trim()) cols.add(current.trim().split(/\s+/)[0]);
      cols.delete("");
      tables.set(created[1], cols);
      continue;
    }

    const altered = sql.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
    if (altered) tables.get(altered[1])?.add(altered[2]);
  }

  return tables;
}

/**
 * The names a SELECT hands back, at the TOP level only.
 *
 * Depth matters: `json_build_object('name', pc.name, ...)` inside a correlated
 * subquery names no output column, and counting its keys would report faults
 * that are not there.
 */
function selectedNames(query: string): string[] {
  const names: string[] = [];
  let depth = 0;

  /*
   * The OUTERMOST select, which is not always the first one. `salaryFor`
   * opens with a CTE and `recentTimeline` selects from a subquery, so both
   * have a select the handset never sees the columns of — reading the first
   * one reports a `from` column that no table has.
   */
  let start = -1;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && /^select\s/i.test(query.slice(i, i + 7))) start = i;
  }
  assert.ok(start > -1, "no top-level select to read");

  depth = 0;
  let clause = "";
  for (let i = start; i < query.length; i++) {
    const ch = query[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    /* The `from` that closes the top-level select list, not one inside a
       subquery and not `extract(epoch from ...)`. */
    if (depth === 0 && /^\sfrom\s/i.test(query.slice(i, i + 6))) break;
    clause += ch;
  }

  /* Comments carry commas and column-shaped words. */
  clause = clause.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  clause = clause.slice(clause.search(/\bselect\b/i) + 6);

  depth = 0;
  let item = "";
  const items: string[] = [];
  for (const ch of clause) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(item);
      item = "";
    } else item += ch;
  }
  items.push(item);

  for (const raw of items) {
    const it = raw.trim();
    if (!it) continue;
    /* Quoted or bare: `c.lead_source as source` names a column just as much as
       `c.phone as "mobile"` does, and only one of the two needs the quotes. */
    const aliased = it.match(/\bas\s+"?(\w+)"?\s*$/i);
    if (aliased) {
      names.push(aliased[1]);
      continue;
    }
    /* A bare column: `c.name`, `t.summary`, `p.rating`, or `period`. */
    const bare = it.match(/^(?:\w+\.)?(\w+)$/);
    if (bare) {
      names.push(bare[1]);
      continue;
    }
    /* An already-quoted one, re-selected from a subquery by its alias. */
    const quoted = it.match(/^"(\w+)"$/);
    if (quoted) names.push(quoted[1]);
  }

  return names;
}

/** The `sql` template inside a named function, or the drizzle `.select({...})`. */
function payloadColumns(source: string, fn: string): string[] {
  const at = source.indexOf(`function ${fn}(`);
  assert.ok(at > -1, `${fn} is gone from ${SERVICE} — this test needs updating with it`);
  const end = source.indexOf("\n}", at);
  const body = source.slice(at, end);

  /*
   * Raw SQL or the query builder — both are in use, and the builder ones name
   * their columns as object keys. Anchoring on `db.execute` rather than on the
   * first `sql` template matters twice: `visibleDocuments` builds its scope
   * clause as a fragment several lines ABOVE the select it goes into, and
   * `unreadNotifications` has a `sql` template in its `orderBy` and no query
   * of its own to read at all.
   */
  const executed = body.indexOf("db.execute");
  if (executed > -1) {
    const tpl = body.indexOf("sql`", executed);
    /* A backtick inside a sql template would end it early; the house style
       forbids one, and `selectedNames` would report nonsense if that changed. */
    return selectedNames(body.slice(tpl + 4, body.indexOf("`", tpl + 4)));
  }

  const obj = body.match(/\.select\(\{([\s\S]*?)\}\)/);
  assert.ok(obj, `${fn} has neither a sql template nor a .select({}) to read`);
  return [...obj[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
}

/*
 * Which payload feeds which table, taken from the `upsert(...)` calls in
 * `mbos-app/src/sync/pull.ts`. `extra` is what the handset stamps on the row
 * itself on the way in — part of the same INSERT, so part of the same
 * contract.
 */
const WIRE: { fn: string; table: string; extra?: string[] }[] = [
  { fn: "customersForDevice", table: "customers", extra: ["lastSyncedAt"] },
  { fn: "activeCatalogue", table: "products", extra: ["lastSyncedAt"] },
  { fn: "recentTimeline", table: "timeline_events" },
  { fn: "journeyStops", table: "journey_stops", extra: ["lastSyncedAt"] },
  { fn: "schemeRows", table: "schemes" },
  { fn: "unreadNotifications", table: "notifications" },
  { fn: "leaveBalances", table: "leave_balances", extra: ["lastSyncedAt"] },
  { fn: "holidaysFor", table: "holidays", extra: ["lastSyncedAt"] },
  { fn: "visibleDocuments", table: "documents", extra: ["lastSyncedAt"] },
  { fn: "coursesFor", table: "courses", extra: ["lastSyncedAt"] },
  { fn: "performanceFor", table: "performance", extra: ["lastSyncedAt"] },
  { fn: "salaryFor", table: "salary", extra: ["lastSyncedAt"] },
];

test("every column MBOS sends has a column on the handset to land in", () => {
  const tables = handsetTables();
  const service = readFileSync(SERVICE, "utf8");
  const faults: string[] = [];

  for (const { fn, table, extra } of WIRE) {
    const local = tables.get(table);
    assert.ok(local, `the handset has no \`${table}\` table for ${fn} to fill`);

    const sent = [...new Set([...payloadColumns(service, fn), ...(extra ?? [])])];
    const missing = sent.filter((c) => !local.has(c));
    if (missing.length) {
      faults.push(`${table} (${fn}): ${missing.join(", ")}`);
    }
  }

  assert.deepEqual(
    faults,
    [],
    "A pulled row is inserted with exactly the columns that arrived, and the " +
      "whole pull is one transaction — so each of these empties the handset:\n  " +
      faults.join("\n  "),
  );
});

/*
 * The delta writes the SAME tables through the SAME upsert, and it does not
 * reuse the bootstrap's queries for all of them — six are spelled out again
 * inline inside `buildPull`. A second spelling is a second thing to get right,
 * and every one of them drifted: the customer row sent `address`, the product
 * row sent `status` and `updatedAt`, the timeline row sent `actorUserId`. So
 * the first delta AFTER a good bootstrap would undo the bootstrap.
 *
 * Anchored on the opening of each select rather than enumerated by position,
 * because a query that moves is fine and a query that is deleted should fail
 * loudly rather than quietly stop being checked.
 */
const DELTA: { anchor: string; table: string }[] = [
  { anchor: 'select c.id, c.name, c.contact_person', table: "customers" },
  { anchor: 'select p.id, p.name, p.pack_size', table: "products" },
  { anchor: 'select t.id, t.customer_id as "customerId"', table: "timeline_events" },
  { anchor: "select s.id,", table: "journey_stops" },
  { anchor: 'select p.id, p.plan_date::text as "planDate"', table: "journey_days" },
  { anchor: "select b.leave_type::text as kind", table: "leave_balances" },
];

test("the delta's own queries send nothing the handset cannot hold either", () => {
  const service = readFileSync(SERVICE, "utf8");
  const tables = handsetTables();
  const pull = service.slice(service.indexOf("export async function buildPull"));
  const faults: string[] = [];

  for (const { anchor, table } of DELTA) {
    const at = pull.indexOf(anchor);
    assert.ok(at > -1, `${anchor} is gone from buildPull — this test needs updating with it`);
    const local = tables.get(table);
    assert.ok(local, `the handset has no \`${table}\` table`);

    const sent = selectedNames(pull.slice(at, pull.indexOf("`", at)));
    const missing = sent.filter((c) => !local.has(c));
    if (missing.length) faults.push(`${table}: ${missing.join(", ")}`);
  }

  assert.deepEqual(faults, [], `the delta would throw on the handset:\n  ${faults.join("\n  ")}`);
});

/*
 * The three tables written by a HAND-ROLLED handler rather than the generic
 * upsert: their column lists are typed out, so an unknown column cannot throw
 * — and that is the trap rather than the safety. `lib/wire.ts` states it: an
 * unknown field is not an invalid one, so a field the handler reads and the
 * server never sends is `undefined`, becomes NULL, and is written into the row
 * by the same `ON CONFLICT` clause that carries the real updates. Nothing
 * fails. `upsertTasks` read `completionNote`, `completionPhotoId` and
 * `escalatedAt`, none of which were on the wire, so every pull erased the note
 * and the photograph off any task the salesman had completed.
 *
 * Both server functions are checked for tasks, because the bootstrap and the
 * delta spell that query out separately and only one of them drifting is the
 * ordinary way this happens.
 */
const HANDLERS: { handler: string; fns: string[] }[] = [
  { handler: "upsertTasks", fns: ["openTasks", "tasksSince"] },
  { handler: "upsertLeads", fns: ["openLeads"] },
  { handler: "upsertSamples", fns: ["openSamples"] },
];

/** The keys of the `raw as { ... }` cast a hand-rolled handler reads through. */
function fieldsRead(pull: string, handler: string): string[] {
  const at = pull.indexOf(`function ${handler}(`);
  assert.ok(at > -1, `${handler} is gone from sync/pull.ts — this test needs updating with it`);
  const body = pull.slice(at, pull.indexOf("\n}", at));
  const cast = body.match(/=\s*raw as \{([\s\S]*?)\n\s*\};/);
  assert.ok(cast, `${handler} does not read its row through a typed cast any more`);
  return [...cast[1].matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}

test("a hand-rolled handler reads no field the server forgets to send", () => {
  const service = readFileSync(SERVICE, "utf8");
  const pull = readFileSync("mbos-app/src/sync/pull.ts", "utf8");
  const faults: string[] = [];

  for (const { handler, fns } of HANDLERS) {
    const read = fieldsRead(pull, handler);
    for (const fn of fns) {
      const sent = new Set(payloadColumns(service, fn));
      const missing = read.filter((f) => !sent.has(f));
      if (missing.length) faults.push(`${handler} reads what ${fn} never sends: ${missing.join(", ")}`);
    }
  }

  assert.deepEqual(
    faults,
    [],
    `these arrive as undefined, become NULL, and are written over whatever was there:\n  ${faults.join("\n  ")}`,
  );
});

test("a hand-rolled handler writes no column the handset lacks", () => {
  const tables = handsetTables();
  const pull = readFileSync("mbos-app/src/sync/pull.ts", "utf8");
  const faults: string[] = [];

  for (const [, table, cols] of pull.matchAll(/INSERT INTO (\w+) \(([^)]*)\)/g)) {
    const local = tables.get(table);
    if (!local) continue;
    const written = cols.split(",").map((c) => c.trim()).filter(Boolean);
    const missing = written.filter((c) => !local.has(c));
    if (missing.length) faults.push(`${table}: ${missing.join(", ")}`);
  }

  assert.deepEqual(faults, [], `the handset has nowhere to put these:\n  ${faults.join("\n  ")}`);
});
