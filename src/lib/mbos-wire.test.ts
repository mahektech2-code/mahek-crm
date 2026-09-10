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
   * COMMENTS COME OUT FIRST, before anything scans for a keyword.
   *
   * They were stripped further down, after the loop that finds the `from`
   * closing the select list — so a prose comment inside the select containing
   * the word "from" ended the scan early and every column after it read as one
   * the server never sends. It is a false POSITIVE, which is the tolerable
   * direction, but it is triggered by ordinary house style: these queries carry
   * paragraphs, and "reached the office perfectly from the first build" is not
   * a sentence anybody would suspect.
   *
   * Parentheses inside a comment went into the depth count too, which could
   * unbalance it in either direction.
   */
  query = query.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

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

  /* Comments are already out — see the top of this function. */
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
  if (obj) return [...obj[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);

  /*
   * A payload assembled in TypeScript rather than by the database.
   *
   * `leaveBalanceRows` is the one of these: its entitlement comes from
   * configuration and its usage from a GROUP BY, so there is no single select
   * whose columns are the row. Reading the object it maps to keeps this test
   * pointed at the thing that actually goes on the wire — anchoring it on one
   * of the two queries instead would have checked two of the five columns and
   * reported the other three as safe.
   */
  const literal = body.match(/=>\s*\(\{([\s\S]*?)\}\)\)/);
  assert.ok(
    literal,
    `${fn} has no sql template, no .select({}) and no mapped object to read`,
  );
  return [...literal[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
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
  { fn: "recentOrders", table: "customer_orders", extra: ["lastSyncedAt"] },
  { fn: "recentPayments", table: "customer_payments", extra: ["lastSyncedAt"] },
  /*
   * `customerBills` assembles its row in TypeScript rather than in SQL — it
   * reads the Accounts ledger through `listBills` and TRIMS the result, so the
   * mapped object literal is the thing that actually goes on the wire. That is
   * the `leaveBalanceRows` case, and `payloadColumns` reads it the same way.
   */
  { fn: "customerBills", table: "customer_bills", extra: ["lastSyncedAt"] },
  { fn: "journeyStops", table: "journey_stops", extra: ["lastSyncedAt"] },
  { fn: "schemeRows", table: "schemes" },
  { fn: "unreadNotifications", table: "notifications" },
  { fn: "leaveBalanceRows", table: "leave_balances", extra: ["lastSyncedAt"] },
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
  /*
   * TWO ENTRIES LEFT THIS LIST, one from each side of this merge, and both for
   * the same reason: the delta now calls the same function the bootstrap does,
   * so there is no second spelling left to check and the WIRE entry above
   * covers each once. That is the state every remaining entry is waiting to
   * reach.
   *
   * `journey_days` moved for a stronger reason than tidiness — the bootstrap
   * sent NO plan days at all, so a fresh sign-in got an empty Journey tab and
   * the `updated_at`-gated delta could never make it up: a day proposed before
   * this handset signed in arrived on no pass, ever.
   */
];

/* The history channels are sent by the SAME functions on both paths — the
   delta calls `recentOrders`/`recentPayments` rather than spelling them out
   again — so the bootstrap check above covers both. Listed here in words so
   the next person to add an inline copy knows it has to be registered. */

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

/* ---------------------------------------------------------------------------
 * THE OTHER DIRECTION: what an ACCEPT writes back onto the record.
 *
 * `setEntityState` in `mbos-app/src/sync/queue.ts` reflects a queue item's
 * fate onto the row itself, so a screen can say what state an order is in
 * without joining the outbox. It writes `syncState` and `syncMessage` always,
 * and `serverCreatedAt` whenever the server sent a time — which an ACCEPT
 * always does, so that is the ordinary path and not the exception.
 *
 * `journey_days` was in `ENTITY_TABLE` without a `serverCreatedAt` column, so
 * every accepted `plan_day` threw `no such column` INSIDE the push loop:
 * after the queue row had been marked synced, before the rest of the batch had
 * been read, and before `applyPull` ran at all. So agreeing a day silently
 * threw away that tick's whole delta — the stops for the day just agreed
 * included — and left the day reading "waiting for signal" for ever with the
 * answer already on the server. Every OTHER table in that map had the column,
 * which is exactly why nothing caught it.
 *
 * Same shape as the pull contract above and the same reason nothing else can
 * catch it: one file's `UPDATE` is a string, the other file's schema is a
 * string, and they meet only inside a phone.
 * ------------------------------------------------------------------------- */

const QUEUE = "mbos-app/src/sync/queue.ts";

test("every table a sync verdict is written onto can hold the verdict", () => {
  const queue = readFileSync(QUEUE, "utf8");
  const tables = handsetTables();

  const map = queue.match(/const ENTITY_TABLE[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(map, "ENTITY_TABLE is gone from sync/queue.ts — this test needs updating with it");

  /* `'visits'` in `visit: 'visits',` — the quoted half, so a comment
     mentioning a table name cannot be read as an entry. */
  const targets = [...map[1].matchAll(/^\s*\w+:\s*'(\w+)'/gm)].map((m) => m[1]);
  assert.ok(targets.length > 10, `only ${targets.length} entity tables parsed — the shape changed`);

  /* Read off `setEntityState` rather than typed out here, so a fourth column
     added to that UPDATE is checked without anybody remembering to. */
  const from = queue.indexOf("async function setEntityState");
  assert.ok(from > -1, "setEntityState is gone from sync/queue.ts");
  /* That function's body only — the file goes on to UPDATE `sync_queue`
     itself, and those columns belong to a different table. */
  const writes = queue.slice(from, queue.indexOf("\n}", from));
  const written = [...new Set([...writes.matchAll(/SET ([^`]*?) WHERE/g)]
    .flatMap((m) => [...m[1].matchAll(/(\w+)\s*=\s*\?/g)].map((c) => c[1])))];
  assert.ok(
    written.includes("syncState") && written.includes("serverCreatedAt"),
    `setEntityState no longer writes what this test thinks: ${written.join(", ")}`,
  );

  const faults: string[] = [];
  for (const table of new Set(targets)) {
    const local = tables.get(table);
    if (!local) {
      faults.push(`${table} does not exist on the handset at all`);
      continue;
    }
    const missing = written.filter((c) => !local.has(c));
    if (missing.length) faults.push(`${table}: ${missing.join(", ")}`);
  }

  assert.deepEqual(
    faults,
    [],
    "An accept writes these onto the row, and a missing column throws inside " +
      "the push loop — which abandons the rest of the batch AND the pull " +
      "behind it:\n  " + faults.join("\n  "),
  );
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

/*
 * What the server sends that the handler never reads — the third direction,
 * and the one that had nothing looking down it.
 *
 * The two checks above watch the handler: what it READS that nothing sends,
 * and what it WRITES that the table lacks. Neither can see a field going the
 * other way. The generic upsert cannot lose one silently — it inserts exactly
 * the keys that arrived, so an unknown column throws and the test at the top
 * of this file catches it before it ships. A hand-rolled handler types its
 * column list out, so a field nobody listed is simply absent: no error on the
 * server, none on the handset, and a column of nulls in between.
 *
 * `openLeads` sent `gpsLat` and `gpsLng` from the day leads existed and the
 * handset had nowhere to put them, so every lead on every handset had a null
 * place — found by hand, long after. Writing this test found the next one
 * unaided: `area`, sent by the same query, dropped the same way, while the
 * customer row beside it showed a locality from the very same two fields.
 *
 * A field that is deliberately not stored is named in NOT_STORED with the
 * reason, so the list of exceptions stays short enough to read and nobody
 * silences a real drop by adding a line to it without saying why.
 */
const NOT_STORED: Record<string, string> = {
  /* The delta's own cursor. It is compared on the server to decide what to
     send and is not a fact about the row — the handset stamps its own
     `lastSyncedAt` instead. */
  updatedAt: "the delta cursor, never a column on the handset",
};

test("a hand-rolled handler drops nothing the server sends", () => {
  const service = readFileSync(SERVICE, "utf8");
  const pull = readFileSync("mbos-app/src/sync/pull.ts", "utf8");
  const faults: string[] = [];

  for (const { handler, fns } of HANDLERS) {
    const read = new Set(fieldsRead(pull, handler));
    for (const fn of fns) {
      const dropped = payloadColumns(service, fn).filter(
        (f) => !read.has(f) && !(f in NOT_STORED),
      );
      if (dropped.length) {
        faults.push(`${fn} sends what ${handler} never reads: ${dropped.join(", ")}`);
      }
    }
  }

  assert.deepEqual(
    faults,
    [],
    "a typed column list cannot throw on a field it does not know, so these " +
      "arrive, are ignored, and leave a column of nulls with nothing failing " +
      `at either end:\n  ${faults.join("\n  ")}`,
  );
});

/* ---------------------------------------------------------------------------
 * THE FUNNEL'S ENGINES ARE COMPILED TWICE, and a copy can drift.
 *
 * `lead-gates.ts` says it in its own header: three callers, one answer. The
 * handset draws the next rung disabled with the missing conditions under it,
 * the server action refuses on the same function before it writes, and the
 * console shows a manager what a lead is stuck behind. That only holds while
 * the two copies ARE one answer.
 *
 * The handset cannot import these files — it is a separate TypeScript program
 * that this one excludes and that excludes this one, joined only inside a
 * phone. So they are copied, and this is what stops the copy going stale: the
 * two are read as text and compared, allowing only the import PATH to differ,
 * because that is the one line a copy has to change.
 *
 * A drift here is the worst shape of bug this repo has: the salesman is told a
 * rung is open, does the work, and the save refuses in different words. He
 * concludes the app is lying, which it is.
 * ------------------------------------------------------------------------- */

const ENGINE_COPIES: { server: string; handset: string }[] = [
  { server: "src/lib/lead-labels.ts", handset: "mbos-app/src/engines/funnel/lead-labels.ts" },
  { server: "src/lib/engines/lead-ladder.ts", handset: "mbos-app/src/engines/funnel/lead-ladder.ts" },
  { server: "src/lib/engines/lead-gates.ts", handset: "mbos-app/src/engines/funnel/lead-gates.ts" },
];

/** The import lines are the one difference allowed, so they are normalised. */
function normalisedEngine(source: string): string {
  return source.replace(/from "\.[^"]*\/?(lead-labels|lead-ladder)"/g, 'from "<engine>/$1"');
}

test("the handset's copy of the funnel engines has not drifted", () => {
  const faults: string[] = [];

  for (const { server, handset } of ENGINE_COPIES) {
    const a = normalisedEngine(readFileSync(server, "utf8"));
    const b = normalisedEngine(readFileSync(handset, "utf8"));
    if (a === b) continue;

    /* The first differing line, because "these files differ" on a 600-line
       engine is a message somebody has to diff by hand anyway. */
    const left = a.split("\n");
    const right = b.split("\n");
    let at = 0;
    while (at < left.length && at < right.length && left[at] === right[at]) at++;
    faults.push(
      `${handset} differs from ${server} at line ${at + 1}:\n` +
        `    server:  ${left[at] ?? "<end of file>"}\n` +
        `    handset: ${right[at] ?? "<end of file>"}`,
    );
  }

  assert.deepEqual(
    faults,
    [],
    "Edit the server's copy and copy it across — never the handset's. " +
      "While these differ, a rung the phone says is open is a rung the save " +
      "may refuse, in different words:\n  " + faults.join("\n  "),
  );
});

/*
 * And the handset's own stage list, which is neither a copy nor derivable.
 *
 * `wire.ts` validates an outgoing funnel stage against a `Set` of strings,
 * because `LeadStage` is a TypeScript union and the wire carries text. A rung
 * missing from that set is sent as `undefined` — which is the safe direction
 * and completely silent: the lead moves on the phone and stays where it was in
 * the office, with nothing anywhere saying so.
 */
test("the handset validates every stage the ladder can reach", () => {
  const labels = readFileSync("src/lib/lead-labels.ts", "utf8");
  const union = labels.slice(labels.indexOf("export type LeadStage ="));
  const stages = [...union.slice(0, union.indexOf(";")).matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.ok(stages.length > 6, "LeadStage no longer reads as a union of string literals");

  const wire = readFileSync("mbos-app/src/lib/wire.ts", "utf8");
  const set = wire.slice(wire.indexOf("const FUNNEL_STAGES"));
  const known = new Set([...set.slice(0, set.indexOf("]")).matchAll(/'(\w+)'/g)].map((m) => m[1]));

  const missing = stages.filter((s) => !known.has(s));
  assert.deepEqual(
    missing,
    [],
    `these rungs would be silently dropped on the way out of the handset: ${missing.join(", ")}`,
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

/* ---------------------------------------------------------------------------
 * A CONFIG KEY IS A WIRE CONTRACT TOO, and this one decides whether a control
 * is drawn at all.
 *
 * Dictation's readiness cannot be worked out on a handset — it depends on a
 * provider key that lives on the server and deliberately never crosses — so
 * the server computes the answer and posts it under one string, and the phone
 * reads it back under the same string. Nothing joins the two but the spelling.
 *
 * Get it wrong and NOTHING FAILS. `getConfig` falls through to the handset's
 * own default, that default is `{ available: false }`, and every screen simply
 * draws no microphone. No error, no log, no empty state — the feature is just
 * absent, on a deployment that paid for it and switched it on. That is the
 * same silence the payload bug above hid in, arriving through a different
 * door: a value nobody sends and a default that looks like a decision.
 * ------------------------------------------------------------------------- */

test("the dictation readiness key is spelled the same on both sides", () => {
  const KEY = "mbos.ai.dictation";

  const service = readFileSync(SERVICE, "utf8");
  assert.ok(
    service.includes(`out["${KEY}"]`),
    `mbosConfigPayload no longer publishes ${KEY} — every handset microphone goes dark`,
  );

  const dictate = readFileSync("mbos-app/src/components/ui/dictate.tsx", "utf8");
  assert.ok(
    dictate.includes(`'${KEY}'`),
    `the handset no longer reads ${KEY}, so it will fall back to "no microphone" for ever`,
  );

  /* The default has to be the CLOSED one. An `available: true` default would
   * draw a mic on a handset that has never heard from the office, which is a
   * button that fails when pressed — the one thing this feature may not do. */
  const config = readFileSync("mbos-app/src/data/config.ts", "utf8");
  const line = config.slice(config.indexOf(`'${KEY}'`));
  assert.match(
    line.slice(0, line.indexOf("\n")),
    /available:\s*false/,
    "the handset's fallback for dictation must be unavailable, never available",
  );
});

/* ---------------------------------------------------------------------------
 * THE VOICE SETTINGS AND THE KEYS BEHIND THEM STAY ON THE SERVER.
 *
 * `mbosConfigPayload` ships everything prefixed `mbos.` or `leads.`, so a
 * setting named `voice.*` would never cross by accident — but the map key
 * above is proof that explicit additions happen, and a `voice.apiKey` added
 * "so the handset can call the provider directly" is exactly the change that
 * would look reasonable in review. Nothing on a phone calls a transcription
 * provider: the audio goes to MahekOne and MahekOne spends the credential.
 * ------------------------------------------------------------------------- */

test("no voice setting and no provider key reaches a handset", () => {
  const service = readFileSync(SERVICE, "utf8");
  const payload = service.slice(
    service.indexOf("export async function mbosConfigPayload"),
  );
  const body = payload.slice(0, payload.indexOf("\n}\n"));

  const leaked = [...body.matchAll(/out\["([^"]+)"\]/g)]
    .map((m) => m[1])
    .filter((key) => key.startsWith("voice.") || /sarvam|openai|apiKey/i.test(key));

  assert.deepEqual(
    leaked,
    [],
    `these belong to the server alone and were about to be handed to a phone: ${leaked.join(", ")}`,
  );
});
