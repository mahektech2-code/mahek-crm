import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";

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
  /* Not covered until `scope` was added to it, which is exactly the shape of
     column this test exists for: a field the office knows about and the
     handset has no place for throws on an unknown column and takes the whole
     pull down with it. */
  { fn: "travelModeRows", table: "travel_modes", extra: ["lastSyncedAt"] },
  /*
   * §8 and §5.2, and both go through the GENERIC upsert rather than a
   * hand-rolled handler — which is why this list can cover them at all.
   *
   * `lead_validations` is an OWNED table with an office end, like `leads` and
   * `samples`: the office's own calls land in the SAME table the handset
   * writes, under the id the row was minted with, so a call made on the phone
   * comes back as itself instead of as a second copy on the record. It carries
   * the guard those two carry — `syncState = 'synced'` on the conflict clause
   * — but it pays for it with a string rather than by typing a column list
   * out, which is the half that silently NULLed every completed task's note.
   *
   * `extra` is `syncState`, stamped on arrival and never sent: what it records
   * is how the row got onto this phone, which is not a fact the office holds.
   */
  { fn: "leadValidations", table: "lead_validations", extra: ["syncState"] },
  { fn: "leadFieldChecks", table: "lead_field_checks" },
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
  { anchor: 'select p.id, p.name, p.pack_size', table: "products" },
  { anchor: 'select t.id, t.customer_id as "customerId"', table: "timeline_events" },
  { anchor: "select s.id,", table: "journey_stops" },
  /*
   * THREE ENTRIES HAVE LEFT THIS LIST, all for the same reason: the delta now
   * calls the same function the bootstrap does, so there is no second spelling
   * left to check and the WIRE entry above covers each once. That is the state
   * every remaining entry is waiting to reach.
   *
   * `customers` was the third, and it is the one that proves why the state is
   * worth reaching. This test only ever asked whether the delta sends
   * something the handset CANNOT HOLD — an extra column, which throws and
   * takes the whole pull with it. It could not ask the opposite, because it
   * has no second list to compare against: a column the delta simply omits is
   * not a fault in any file, it is an absence, and eleven of them sat there
   * for as long as the channel existed. See `changedCustomersForDevice`.
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
  /* §7 — the verb, not the rung. The sales manager is told "Confirm actual
     order" and the back office "Dispatch sample" about one lead on one
     afternoon, and a handset wording either of those differently is a
     salesman and his manager reading two instructions off one shop. */
  {
    server: "src/lib/engines/lead-role-action.ts",
    handset: "mbos-app/src/engines/funnel/lead-role-action.ts",
  },
  /*
   * The words for the two components that are a SHARE. It imports nothing at
   * all, deliberately — money is rendered by a function the caller passes in —
   * so this copy is byte-identical rather than merely equivalent, and needs no
   * normalising. A drift here is a manager and the salesman he manages reading
   * two different sentences about one month.
   */
  { server: "src/lib/performance-labels.ts", handset: "mbos-app/src/engines/performance-labels.ts" },
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
 * ONE FIELD, FOUR LINKS, AND EVERY ONE OF THEM SILENT WHEN IT BREAKS.
 *
 * §11.6's gate is `has(i.gstin) && i.gstVerified === true` — the number
 * somebody wrote down AND somebody else saying they checked it, which is the
 * whole reason `validateGstin` exists on the web: the salesman who collected
 * the number must not be the man who certifies it.
 *
 * The verdict lives on `customers.gst_verified` and for a full release it
 * reached no handset: not on the wire, not in the handset's schema, not read
 * by the handler. So `i.gstVerified` was `undefined` on every phone in the
 * field, `undefined === true` is false, and a SHOP LEAD COULD NEVER ONCE REACH
 * SAMPLE/TRIAL from the handset. The refusal read "Get their GST number — the
 * back office checks it", over a number already typed in and already verified
 * at a desk, for ever. Nothing failed at either end: the gate was working
 * exactly as written against a fact that never arrived, which is the same
 * shape as every other bug on this wire.
 *
 * The two tests above would catch this field being dropped from `openLeads` or
 * being read ahead of the server sending it, because they compare the two
 * lists wholesale. What they cannot say is why THIS one matters, or that it is
 * a one-way field: nothing on the handset writes it, and the inbound lead
 * payload deliberately does not name it, so a device sending one has it
 * stripped by `safeParse` without a word. A schema that grew a `gstVerified`
 * would hand the certification back to the man collecting the number and look
 * like a feature while it did it.
 * ------------------------------------------------------------------------- */

test("the office's GST verdict reaches the gate, and no handset may write it", () => {
  const service = readFileSync(SERVICE, "utf8");
  const pull = readFileSync("mbos-app/src/sync/pull.ts", "utf8");

  assert.ok(
    payloadColumns(service, "openLeads").includes("gstVerified"),
    "openLeads no longer sends gstVerified — every shop lead on every handset " +
      "is refused Sample/Trial again, in words naming a GST number that is there",
  );

  assert.ok(
    fieldsRead(pull, "upsertLeads").includes("gstVerified"),
    "upsertLeads no longer reads gstVerified, so the office's verdict arrives " +
      "and is dropped on the floor",
  );

  /* READ is not KEPT. A hand-rolled handler types its column list out, so the
     cast can name a field the INSERT and the ON CONFLICT clause never mention
     — which reads exactly like a field that is stored and is a column of
     nulls. Both halves, because the second is what a pull after the first one
     writes. */
  const at = pull.indexOf("function upsertLeads(");
  const body = pull.slice(at, pull.indexOf("\n}", at));
  assert.ok(
    /INSERT INTO leads \([^)]*\bgstVerified\b/.test(body),
    "upsertLeads reads gstVerified and does not insert it",
  );
  assert.ok(
    /gstVerified = excluded\.gstVerified/.test(body),
    "upsertLeads inserts gstVerified and does not update it on conflict, so " +
      "the verdict is whatever it was the first time this lead arrived",
  );

  assert.ok(
    handsetTables().get("leads")?.has("gstVerified"),
    "the handset's leads table has no gstVerified column, so the gate reads " +
      "undefined and refuses every shop lead at Sample/Trial",
  );

  /* ARRIVING IS NOT BEING READ, and that is the last link in this chain — the
     one that would fail silently with every other assertion above it green.
     The column can be on the wire, in the table and kept by the upsert, and
     the gate still reads `undefined` unless `leadGateInput` hands it over: a
     shop lead refused at Sample/Trial for want of a verdict the phone is
     holding, with nothing on either end saying so. */
  const funnel = readFileSync("mbos-app/src/data/lead-funnel.ts", "utf8");
  assert.ok(
    /gstVerified:/.test(funnel),
    "leadGateInput does not pass gstVerified to the gate, so the office's " +
      "verdict lands on the phone and the gate still reads undefined",
  );

  /* ONE WAY. The lead payload is what a handset may assert about a lead, and
     this is the one fact about a lead that is not its to assert. */
  const actions = readFileSync("src/lib/actions/mbos.ts", "utf8");
  assert.ok(
    !/\bgstVerified\s*:/.test(actions),
    "src/lib/actions/mbos.ts now names gstVerified on a payload the handset " +
      "sends. The verdict is the back office's — a phone that can certify its " +
      "own GST is the self-certification validateGstin exists to end",
  );
});

/* ---------------------------------------------------------------------------
 * AND THE GST VERDICT WAS ONE OF ELEVEN FACTS THAT NEVER ARRIVED.
 *
 * The test above is about one field and the same chain broke on twenty. The
 * gate engine is mirrored byte for byte, so the handset has known all
 * twenty-three rungs and every condition on them since the funnel shipped —
 * and held almost none of the facts those conditions read. `countingOrderCount`
 * was `undefined`, `undefined >= 1` is false, and EVERY RUNG ABOVE NEGOTIATION
 * was structurally unreachable from a phone: First order refused itself in the
 * words "There is no order on this account yet", over a shop that had ordered
 * three times, with the office's own screen showing the rung open. Delivery,
 * Payment, Second order, the whole distributor ladder and the two review gates
 * were the same.
 *
 * FOUR LINKS PER FIELD AND EVERY ONE OF THEM SILENT WHEN IT BREAKS: the server
 * has to send it, the handler has to READ it, the handler has to KEEP it — the
 * INSERT and the `ON CONFLICT` clause are two separate assertions, because a
 * hand-rolled handler types its column list out and a field read and not kept
 * reads exactly like a column of nulls — and the table has to have somewhere to
 * put it. A fifth is asserted separately below: arriving is not being READ BY
 * THE GATE.
 *
 * Adding a column to `openLeads` without the other three is worse than not
 * adding it: a column the handset cannot hold throws inside `applyPull`, which
 * is ONE transaction, so it rolls back the whole pull — the customers, the
 * products, the price list, the journey, the configuration, all of it.
 * ------------------------------------------------------------------------- */

/** Wire name → why the gate or §7 cannot do its job without it. */
const LEAD_GATE_FACTS: Record<string, string> = {
  countingOrderCount:
    "First order, Second order and Customer all count orders; without it the " +
    "three of them refuse a shop that has ordered",
  deliveredOrderCount: "Delivery reads it — the material has not reached them yet, for ever",
  confirmedPaymentCount: "Payment reads it — accounts have not found the money, for ever",
  distributorCount:
    "§23 — a third-party shop may not be sent a sample until somebody bills " +
    "it, and the office had already said who",
  distributorCustomerId: "and WHO bills it, for the column this table has had all along",
  distributorName: "the name beside that id, because the handset holds no customer of its own for it",
  distributorProfile:
    "§11 — the thirty answers the distributor ladder is gated on. Absent, " +
    "Management review lists all thirty as missing on an application that is complete",
  managementReviewApproved: "§12 — the sales manager putting them forward, which is step 0",
  distributorApprovalApproved: "§12 — management appointing them, which is step 1",
  commercialTermsAgreed: "§12 — the discount, the credit limit and the territory",
  agreementOnFile: "§12 — the signed agreement, derived from the library rather than a tick",
  figuresConfirmedAt:
    "§5.3 — the day somebody last said the four conversion figures hold. The " +
    "phone judges staleness against its own clock, so what crosses is the day",
  qualificationReview: "§5.3 — a manager who marked the checklist incomplete is listened to",
  buyer: "§4.2 — who places the order, which is the eighth qualification condition",
  priority: "what the office thinks this lead is worth beside the others",
  holdResumeDate: "when a parked lead comes back",
  holdReasonCode: "the CODE behind the hold sentence — a label cannot be counted",
  sourceDetail: "where the lead came from, in more words than manual",
  hasCommitment:
    "§7 — a commitment is a day AND a size, and it is what escalates the sales " +
    "manager's verb in Negotiation from supporting to closing",
  hasOrder: "§7 — the other half of that fork",
  backOfficeAmId: "§7 — the seat a back-office vantage is resolved from",
};

test("every fact the lead gates read reaches the handset, and is kept there", () => {
  const service = readFileSync(SERVICE, "utf8");
  const pull = readFileSync("mbos-app/src/sync/pull.ts", "utf8");
  const sent = new Set(payloadColumns(service, "openLeads"));
  const read = new Set(fieldsRead(pull, "upsertLeads"));
  const columns = handsetTables().get("leads") ?? new Set<string>();

  const at = pull.indexOf("function upsertLeads(");
  const body = pull.slice(at, pull.indexOf("\n}", at));
  const inserted = new Set(
    (body.match(/INSERT INTO leads \(([^)]*)\)/)?.[1] ?? "")
      .split(",")
      .map((c) => c.trim()),
  );
  const kept = new Set(
    [...body.matchAll(/(\w+) = excluded\.\1/g)].map((m) => m[1]),
  );

  const faults: string[] = [];
  for (const [field, why] of Object.entries(LEAD_GATE_FACTS)) {
    if (!sent.has(field)) faults.push(`openLeads does not send ${field} — ${why}`);
    if (!read.has(field)) faults.push(`upsertLeads does not read ${field} — ${why}`);
    if (!inserted.has(field)) faults.push(`upsertLeads reads ${field} and never inserts it`);
    if (!kept.has(field)) {
      faults.push(
        `upsertLeads inserts ${field} and does not update it on conflict, so ` +
          "it is whatever it was the first time this lead arrived",
      );
    }
    if (!columns.has(field)) {
      faults.push(
        `the handset's leads table has no ${field} column — the server sends ` +
          "it, applyPull throws on the unknown column, and ONE transaction " +
          "rolls back the ENTIRE pull",
      );
    }
  }

  assert.deepEqual(
    faults,
    [],
    "every one of these is silent at both ends and shows up as a rung a " +
      `salesman cannot climb with no way to find out why:\n  ${faults.join("\n  ")}`,
  );
});

/* ---------------------------------------------------------------------------
 * ARRIVING IS NOT BEING READ, and that is the link that fails with every other
 * assertion above it green.
 *
 * A fact can be on the wire, in the table and kept by the upsert, and the gate
 * still read `undefined` — because `leadGateInput` is what hands it over, and a
 * field nobody added there is a phone holding the answer and refusing the rung
 * anyway. That is exactly the shape of the original bug, one file further in.
 * ------------------------------------------------------------------------- */

test("every fact the handset holds is handed to the gate", () => {
  const funnel = readFileSync("mbos-app/src/data/lead-funnel.ts", "utf8");
  const at = funnel.indexOf("export async function leadGateInput(");
  assert.ok(at > -1, "leadGateInput is gone from lead-funnel.ts");
  const body = funnel.slice(at, funnel.indexOf("\n}", at));

  /*
   * The GATE's own field names, which are not always the wire's. `figuresStale`
   * is worked out here from `figuresConfirmedAt` against this phone's clock,
   * and `initialStockOrderPlaced` is derived from the order count rather than
   * sent — §21 says the initial stock order IS an order on the account, and a
   * boolean beside an order book that disagrees with it is how the two come
   * apart.
   */
  const missing = [
    "countingOrderCount",
    "deliveredOrderCount",
    "confirmedPaymentCount",
    "initialStockOrderPlaced",
    "distributorCount",
    "distributorProfile",
    "managementReviewApproved",
    "distributorApprovalApproved",
    "commercialTermsAgreed",
    "agreementOnFile",
    "figuresStale",
    "qualificationReview",
    "buyer",
  ].filter((f) => !new RegExp(`^\\s*${f}:`, "m").test(body));

  assert.deepEqual(
    missing,
    [],
    "leadGateInput does not pass these to the gate, so the office's answers " +
      "land on the phone and the rung stays shut over conditions the salesman " +
      `has already satisfied: ${missing.join(", ")}`,
  );
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
 * AND SO IS THE ONE THAT DECIDES WHETHER A TRAIL IS BELIEVED.
 *
 * `mbos.location.trailStalledAfterMisses` is how many of its own position
 * intervals a handset may spend recording nothing before it concludes the
 * background task the OS accepted is dead, falls back to taking fixes while the
 * app is open, and reports what it is really doing. `mbosConfigPayload` ships
 * every `mbos.*` key, so the registry entry is the whole of the publishing
 * half — and the reading half is one string inside `sync/trail.ts`.
 *
 * Get either wrong and NOTHING FAILS, in the same silence the dictation key
 * above hides in: `getConfig` falls through to the handset's compiled default,
 * the watchdog goes on running at a number nobody chose, and a manager who
 * changes it on the Settings screen changes it in the office and nowhere else.
 * ------------------------------------------------------------------------- */

test("the trail watchdog's window is spelled the same on both sides", () => {
  const KEY = "mbos.location.trailStalledAfterMisses";

  const registry = readFileSync("src/lib/config/registry.ts", "utf8");
  const at = registry.indexOf(`key: "${KEY}"`);
  assert.ok(
    at > -1,
    `${KEY} has left the registry, so no office can change how long a dead trail is believed`,
  );
  const entry = registry.slice(at);

  const trail = readFileSync("mbos-app/src/sync/trail.ts", "utf8");
  assert.ok(
    trail.includes(`'${KEY}'`),
    `the handset no longer reads ${KEY} — the watchdog will run on its compiled default for ever`,
  );

  /* And the two DEFAULTS agree. The handset's exists only for a phone that has
   * never bootstrapped; a different number there is a second policy, held by
   * exactly the handsets nobody has ever configured. */
  const declared = entry.slice(0, entry.indexOf("},")).match(/default:\s*(\d+)/);
  assert.ok(declared, `${KEY} has no default in the registry`);

  const config = readFileSync("mbos-app/src/data/config.ts", "utf8");
  const fallback = config.slice(config.indexOf(`'${KEY}'`)).match(/:\s*(\d+)/);
  assert.ok(fallback, `${KEY} has no fallback on the handset`);
  assert.equal(
    fallback[1],
    declared[1],
    "the handset's fallback and the registry's default are two different policies",
  );
});

/* ---------------------------------------------------------------------------
 * AND SO IS THE ONE THAT DECIDES WHETHER A DAY MAY OPEN AT ALL.
 *
 * `mbos.location.startOfDayGate` is the most consequential setting on this
 * wire: at `block` it refuses to open a salesman's day on a phone that cannot
 * show it will record the trail. A gate that locks a workforce out of its own
 * attendance is the last thing that should run on a number nobody chose — and
 * that is exactly what a misspelling produces here, in silence. `getConfig`
 * falls through to the handset's compiled default, every phone runs at a level
 * no office picked, and a manager who turns the gate down on the Settings
 * screen turns it down in the office and nowhere else. Nothing goes red at
 * either end.
 *
 * The two defaults have to agree for the same reason the trail watchdog's do,
 * with more at stake: a handset that has never bootstrapped is precisely the
 * untested, never-configured phone this gate was built for, and a fallback of
 * `off` would wave exactly those through.
 * ------------------------------------------------------------------------- */

test("the start-of-day gate is spelled the same on both sides", () => {
  const KEY = "mbos.location.startOfDayGate";

  const registry = readFileSync("src/lib/config/registry.ts", "utf8");
  const at = registry.indexOf(`key: "${KEY}"`);
  assert.ok(
    at > -1,
    `${KEY} has left the registry, so no office can decide whether a day may open`,
  );
  const entry = registry.slice(at, at + registry.slice(at).indexOf("},"));

  const gate = readFileSync("mbos-app/src/data/day-gate.ts", "utf8");
  assert.ok(
    gate.includes(`'${KEY}'`),
    `the handset no longer reads ${KEY} — the gate will run at its compiled level for ever`,
  );

  const declared = entry.match(/default:\s*"([a-z]+)"/);
  assert.ok(declared, `${KEY} has no default in the registry`);

  const config = readFileSync("mbos-app/src/data/config.ts", "utf8");
  const fallback = config.slice(config.indexOf(`'${KEY}'`)).match(/:\s*'([a-z]+)'/);
  assert.ok(fallback, `${KEY} has no fallback on the handset`);
  assert.equal(
    fallback[1],
    declared[1],
    "the handset's fallback and the registry's default are two different policies, " +
      "and the handsets holding the fallback are the ones nobody has configured",
  );

  /* The level the client ASKED for is a decision, not a default — `block` is
     what Mahek chose after a salesman lost a full day's trail to a battery
     manager, and it is the one value that must not drift quietly. */
  assert.equal(declared[1], "block", "the gate shipped as `block` on the client's own decision");
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

/* ---------------------------------------------------------------------------
 * A HANDLER THE HANDSET NEVER CALLS IS A FEATURE NOBODY CAN USE.
 *
 * `dispatchItem` is the whole list of things a salesman can send us, and it is
 * the one place the two halves of a feature are named in the same vocabulary.
 * A `case` with no matching `entityType:` on the handset means the server side
 * was finished and the phone side never arrived — and nothing anywhere goes
 * red, because both halves compile perfectly on their own.
 *
 * That is exactly what happened to `internal_note`. §R had a table, a role
 * list and a bootstrap that narrowed by role from the day the module shipped,
 * and `handleInternalNote` sat waiting for a payload that no handset ever
 * sent: a read path over a table nothing could put a row in. It was found by
 * reading the dispatcher against the handset by hand, which is not a plan.
 * ------------------------------------------------------------------------- */

/**
 * Handled on the server, deliberately never sent by a phone, and why.
 *
 * Empty today — and it is here rather than absent because the honest answer to
 * a future mismatch is sometimes "the office sends this one", and that answer
 * should have to be written down next to the reason.
 */
const SERVER_ONLY: Record<string, string> = {};

test("every entity the sync dispatcher handles is one a handset can send", () => {
  const actions = readFileSync("src/lib/actions/mbos.ts", "utf8");
  const dispatcher = actions.slice(actions.indexOf("async function dispatchItem"));
  const body = dispatcher.slice(0, dispatcher.indexOf("\n}\n"));

  const handled = [...body.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]);
  assert.ok(handled.length > 15, `expected the whole dispatcher, found ${handled.length} cases`);

  /* What the handset actually enqueues, read as text for the same reason this
     whole file reads text: the two projects are joined only inside a phone. */
  const sent = new Set<string>();
  for (const file of ["mbos-app/src/data", "mbos-app/app"]) {
    for (const found of readdirSyncDeep(file)) {
      for (const m of readFileSync(found, "utf8").matchAll(/entityType: ['"]([a-z_]+)['"]/g)) {
        sent.add(m[1]);
      }
    }
  }
  assert.ok(sent.size > 15, `expected the handset's writes, found ${sent.size} entity types`);

  const stranded = handled.filter((e) => !sent.has(e) && !SERVER_ONLY[e]);
  assert.deepEqual(
    stranded,
    [],
    "the server can save these and no handset ever sends one — build the screen, " +
      `or record it in SERVER_ONLY with a reason: ${stranded.join(", ")}`,
  );

  /* And the other direction, which fails LOUDER but only at runtime: a handset
     sending an entity the dispatcher does not know gets a rejection reading
     "MahekOne does not know how to save a ..." — after the salesman has done
     the work. */
  const unknown = [...sent].filter((e) => !handled.includes(e));
  assert.deepEqual(
    unknown,
    [],
    `a handset sends these and the server would refuse them: ${unknown.join(", ")}`,
  );
});

/* ---------------------------------------------------------------------------
 * A MIRRORED LIST NOTHING IMPORTS IS THE SAME BUG ONE LEVEL DOWN.
 *
 * The test above asks whether the two halves of a WRITE meet. This one asks
 * something narrower and, as it turned out, just as expensive: the funnel's
 * vocabulary is copied onto the handset byte for byte, so a list can be
 * compiled into every APK and read by no screen. §10.4's eleven communication
 * actions sat in `engines/funnel/lead-labels.ts` in exactly that state — legal
 * TypeScript, clean lint, every test green, and a salesman in the shop who
 * could not send the current price list.
 *
 * It is pinned for this one list rather than for every export of that file,
 * because several of the others are genuinely mid-build and a test that fails
 * on work in progress is a test somebody turns off. Widening it is the right
 * move once they land.
 */
test("the handset reads §10.4's eleven rather than carrying them unused", () => {
  const readers = [...readdirSyncDeep("mbos-app/src"), ...readdirSyncDeep("mbos-app/app")]
    .filter((f) => !f.endsWith("engines/funnel/lead-labels.ts"))
    .filter((f) => readFileSync(f, "utf8").includes("COMMUNICATION_ACTIONS"));

  assert.ok(
    readers.length > 0,
    "COMMUNICATION_ACTIONS is mirrored onto the handset and nothing there imports it — " +
      "the eleven buttons exist in the bundle and on no screen",
  );
});

function readdirSyncDeep(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) readdirSyncDeep(path, out);
    else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) out.push(path);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * THE MIGRATION IS THE ONLY PLACE THE OLD VOCABULARY STILL EXISTS.
 *
 * `telecaller` and `accounts` are gone from the enum, so a literal left behind
 * anywhere in the source is either dead or wrong — and the failure it produces
 * is the quiet kind. `role === "accounts"` is now permanently false rather than
 * a type error, because these are compared against `string` in several places
 * (`can(role: string)` used to be one), so nothing catches it but a grep.
 * ------------------------------------------------------------------------- */

test("no source file still names a role that no longer exists", () => {
  /*
   * EVERY file under src/, not a hand-kept list — and including SQL.
   *
   * The first version of this test read seven files it knew about and missed
   * the one that mattered: `sales-target-service.ts` compares `u.role =
   * 'telecaller'` inside a `sql` template, and Postgres refuses an enum label
   * that does not exist. `/accounts/targets` answered 500 — not a wrong list,
   * a dead page — and nothing but the link crawler saw it. TypeScript cannot:
   * the literal is inside a string.
   */
  const offenders: string[] = [];
  for (const file of readdirSyncDeep("src")) {
    if (file.includes(".test.")) continue;
    const src = readFileSync(file, "utf8");
    let inBlock = false;
    for (const [i, line] of src.split("\n").entries()) {
      const opens = line.includes("/*");
      const closes = line.includes("*/");
      const wasInBlock = inBlock;
      if (opens && !closes) inBlock = true;
      if (closes) inBlock = false;
      /* Prose is allowed to remember them — the paragraphs explaining WHY the
       * vocabulary changed are the most valuable thing in these files, and a
       * test that forbade the word would delete the reasoning to satisfy
       * itself. Block comments are tracked rather than matched line by line,
       * because those sentences run long and only the first carries a `*`. */
      if (wasInBlock || (opens && !closes)) continue;
      const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      /* `'accounts'` is still a live APP id, so only the unambiguous one is
       * matched by name; the app-shaped comparisons are caught by the role
       * column being named beside them. */
      /* One deliberate exception, marked at its own line rather than listed
       * here: `{{telecaller}}` is a WhatsApp template variable and keeping the
       * word is the point of it. An opt-out that has to be written beside the
       * code is one whose reason is read; a list in this file is one nobody
       * revisits. */
      if (/role-name-ok/.test(src.split("\n")[i - 1] ?? "")) continue;
      /*
       * CASE-INSENSITIVE, and that is not tidiness.
       *
       * It matched lower case only, so the Admin Console's own user drawer
       * carried `select: ["Telecaller", "Manager", "Accounts", "Admin"]` —
       * the whole dead vocabulary, capitalised — long after the roles went.
       * Picking either dead option lowercased it and handed it to
       * `setUserRole`, which writes straight to a Postgres enum: a refused
       * write surfacing as "The role did not change", with nothing saying
       * why. Two of the four options on that form could not work, and the
       * guard written to catch exactly this could not see them.
       *
       * `accounts` stays case-sensitive and anchored to a role comparison:
       * "Accounts" is a live app NAME, and matching it loosely would fire on
       * every honest mention of the app.
       */
      if (/["']telecaller["']/i.test(code) || /\brole\s*=\s*'accounts'/.test(code)) {
        offenders.push(`${file}:${i + 1} ${line.trim().slice(0, 90)}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these name a role that no longer exists — in TypeScript it is silently false, in SQL it is a 500:\n  ${offenders.join("\n  ")}`,
  );
});


/* ---------------------------------------------------------------------------
 * A DELTA MUST SEND WHAT THE BOOTSTRAP SENDS.
 *
 * The test above pins a payload against the handset's schema, function by
 * function, by NAME — and every name in `WIRE` is a bootstrap one. The delta's
 * channels were anonymous `sql` templates inside `buildPull`'s `Promise.all`,
 * so they were in no list and nothing compared the two.
 *
 * The customers channel had drifted eleven columns apart. Nothing failed,
 * because `upsert` writes exactly the columns that arrive: a missing one is
 * not written as null, it is not written at all, so the bootstrap's value sits
 * on the row being right about the day the salesman signed in. `pullCursor` is
 * set once and cleared nowhere, so that is the life of the installation.
 *
 * The fix was one function for both. This is what stops somebody re-inlining
 * it — the one change that would put the two back out of step, and the one
 * nothing else in the suite can see.
 * ------------------------------------------------------------------------- */
test("the delta reads customers through the same function the bootstrap does", () => {
  const src = readFileSync(SERVICE, "utf8");
  const start = src.indexOf("export async function buildPull");
  assert.ok(start > 0, "buildPull not found");
  const body = src.slice(start);

  assert.ok(
    /changedCustomersForDevice\(/.test(body),
    "buildPull no longer calls changedCustomersForDevice — a delta that builds its own customer projection is how eleven columns stopped reaching handsets in the field",
  );

  /* A projection of its own is the regression. `from customers c` is what one
   * looks like; the id lookup that feeds the shared function lives in
   * `changedCustomersForDevice`, above `buildPull`, so it is not in this
   * slice. */
  assert.equal(
    (body.match(/from customers c\b/g) ?? []).length,
    0,
    "buildPull selects from customers directly — it must go through customersForDevice, or the delta and the bootstrap drift apart silently",
  );

  const helper = src.slice(
    src.indexOf("async function changedCustomersForDevice"),
    src.indexOf("async function customersForDevice"),
  );
  assert.ok(
    /return customersForDevice\(/.test(helper),
    "changedCustomersForDevice must hand its ids to customersForDevice so there is one column list",
  );
});

/* ---------------------------------------------------------------------------
 * THE BOOK THE HANDSET IS ALLOWED TO HOLD, spelled the same at both ends.
 *
 * A pull adds and updates; only a tombstone removes. Tombstones are written
 * when somebody EDITS an allocation, so a book that shrank any other way — a
 * role changed, an account reassigned, a customer's city corrected — left the
 * phone holding shops the server would no longer send, indefinitely, with
 * nothing on any screen looking wrong. An associate with no territory at all
 * is the clearest case: the server correctly sends him NO customers and his
 * handset went on showing a book it had downloaded under an older rule.
 *
 * `bookIds` closes it, and like everything else on this wire the two halves
 * are joined by a spelling and nothing else. Get it wrong and nothing fails:
 * the field is simply absent, `reconcileBook` reads that as "an older server
 * that does not speak this", touches nothing — which is the correct reading of
 * absence and the wrong outcome here — and the stale book stays exactly where
 * it was.
 * ------------------------------------------------------------------------- */

test("the book-reconcile field is spelled the same on both sides", () => {
  const service = readFileSync(SERVICE, "utf8");
  assert.ok(
    /bookIds:\s*ids/.test(service),
    "the server no longer states the whole book, so no handset can let go of a shop it should not hold",
  );

  const pull = readFileSync("mbos-app/src/sync/pull.ts", "utf8");
  assert.ok(
    pull.includes("pull.bookIds"),
    "the handset no longer reads bookIds — a shrinking book will never reach it",
  );

  /* ABSENT IS NOT EMPTY, and the safety of the whole thing is that line. A
   * handset meeting a deployment that predates this must touch nothing;
   * reading silence as "you may hold nothing" would wipe every book in the
   * field on the first pull. `Array.isArray` is what tells them apart, and a
   * truthiness check — which is the obvious way to write this and is wrong —
   * would treat the real empty answer as absence and never clear anything. */
  assert.ok(
    /if\s*\(!Array\.isArray\(bookIds\)\)\s*return 0;/.test(pull),
    "reconcileBook must separate an absent list from an empty one with Array.isArray",
  );
});

/* ---------------------------------------------------------------------------
 * EVERY KEY THE HANDSET ASKS FOR, NOT JUST THE ONES SOMEBODY REMEMBERED.
 *
 * The two tests above each pin one key by name, which is worth having and is
 * not the shape of the bug. `getConfig` answers a key the office has never
 * heard of with the handset's own compiled default and no error anywhere —
 * so a key that was never added to the registry behaves EXACTLY like one that
 * was, right up until a manager changes it on the Settings screen and nothing
 * on any phone moves. Nobody reports that as a bug; they report that the
 * setting does not work, months later, if at all.
 *
 * `mbos.location.trackEveryMinutes` is how this was found. It is read by
 * `minGapMs()` in `sync/trail.ts` — the authority on what is actually WRITTEN
 * to the trail — and it had never been published at all. AGENTS.md's own
 * account of the three-second incident says "`mbos.location.trackEveryMinutes`
 * said five and the handset asked for five". It said nothing. The compiled
 * default happened to be five, which is precisely why nobody noticed, and it
 * means the trail cadence has never once been something the office could
 * change.
 *
 * Publishing it was necessary and was NOT sufficient, which is the part worth
 * carrying forward: the key then existed, the office could set it, and the
 * trail was still wrong — because the unit was MINUTES and the fixes it was
 * throttling arrive every three SECONDS, so the nearest the office could set
 * was twenty times too coarse. This test can prove a key is reachable. It
 * cannot prove the number it carries can express the answer. It is
 * `mbos.location.trailKeepEverySeconds` now, and `checkConsistency` is what
 * holds the pair together.
 *
 * OUTSTANDING held the seven that were already like that when this test was
 * written, each with the reason it was still on the list. IT IS EMPTY, and the
 * seven turned out to be three different faults rather than seven missing
 * entries. Two were MISSPELLINGS of keys that already existed and were already
 * enforced — `mbos.expenses.maxClaimAgeDays` in front of
 * `mbos.expenses.backdatedDaysAllowed`, and `mbos.tasks.escalateAfterHours` in
 * front of `mbos.tasks.escalationHours` — which is the worst shape this bug
 * takes: the office CAN change the setting, the phone goes on running the
 * compiled number, and both halves look correct read on their own. Four were
 * the route engine's arguments, published together under `mbos-route` because
 * one of four is half a control. The last was
 * `mbos.attendance.baseLocation`, which needed a decision rather than an
 * entry: it is the centre the published geofence radius is measured from, and
 * a radius with no centre was the half-control argument again, one setting
 * along.
 *
 * The list stays because it is the only thing that lets a genuinely undecided
 * key be recorded instead of forgotten — but an empty one is what this test is
 * for, and an addition to it should be argued for rather than typed.
 * ------------------------------------------------------------------------- */

/*
 * COMPUTED INTO THE PAYLOAD RATHER THAN STORED, which is a different thing
 * from missing and must not be confused with it. `mbos.ai.dictation` is an
 * ANSWER — whether this deployment can hear, worked out from the voice
 * settings and the provider keys, neither of which may cross the wire — so
 * there is nothing for a manager to type and a registry entry would be a
 * second, editable copy of a conclusion. `mbos-service.ts` writes it into the
 * payload and the test above pins its spelling.
 */
/* `mbos.ai.visitAssistant` is the same kind of answer: whether the visit
   assistant can run, worked out from `visitIntel.enabled` and the model keys.
   The test below pins its spelling at both ends. */
const INJECTED = new Set(["mbos.ai.dictation", "mbos.ai.visitAssistant"]);

test("the visit assistant's answer is written under the key the handset reads", () => {
  /* Joined only by a spelling, and a wrong one fails SILENTLY: `getConfig`
     falls back to unavailable and no handset ever draws the card. */
  const server = readFileSync("src/lib/services/mbos-service.ts", "utf8");
  const handset = readFileSync("mbos-app/src/components/visit-assistant.tsx", "utf8");
  const defaults = readFileSync("mbos-app/src/data/config.ts", "utf8");
  assert.ok(server.includes('out["mbos.ai.visitAssistant"]'));
  assert.ok(handset.includes("'mbos.ai.visitAssistant'"));
  assert.ok(
    defaults.includes("'mbos.ai.visitAssistant': { available: false }"),
    "unavailable until the office says otherwise",
  );
});

const OUTSTANDING: Record<string, string> = {};

test("every mbos.* key the handset reads is one the office can publish", () => {
  const sources = [
    ...readdirSyncDeep("mbos-app/src"),
    ...readdirSyncDeep("mbos-app/app"),
  ].filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"));
  const asked = new Map<string, string>();
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/getConfig<[^>]*>\(\s*'(mbos\.[A-Za-z0-9._]+)'/g)) {
      asked.set(m[1]!, file);
    }
  }
  assert.ok(asked.size > 20, "found almost no getConfig calls — the scan is broken, not the code");

  const registry = readFileSync("src/lib/config/registry.ts", "utf8");
  const missing: string[] = [];
  for (const [key, file] of asked) {
    if (OUTSTANDING[key] || INJECTED.has(key)) continue;
    if (!registry.includes(`key: "${key}"`)) {
      missing.push(`${key} — read in ${file.replace(/^.*mbos-app\//, "mbos-app/")}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    "these keys are read by the handset and declared nowhere, so they run on a " +
      "compiled default that no office can change and nothing says so:\n" +
      missing.join("\n"),
  );
});

test("nothing lingers on the outstanding list after it has been published", () => {
  const registry = readFileSync("src/lib/config/registry.ts", "utf8");
  const published = Object.keys(OUTSTANDING).filter((k) => registry.includes(`key: "${k}"`));
  assert.deepEqual(
    published,
    [],
    "these are in the registry now and should come off OUTSTANDING, or the list " +
      "stops meaning anything: " + published.join(", "),
  );
});

/* ---------------------------------------------------------------------------
 * THE THIRD WORD, AND WHY IT COULD NOT BE PINNED UNTIL NOW.
 *
 * `POST /api/mbos/positions` answers with a `tracking` word, or with none, and
 * that word is the only thing `flush()` may branch on. Two of the three have
 * always existed. The third, `partial`, is the fix for a data-loss bug with the
 * worst possible shape: a batch the server could only partly file came back
 * looking delivered, so the handset deleted rows the office had never stored —
 * a salesman's fixes destroyed on his own phone by a successful upload, with
 * every layer reporting 200 all the way down.
 *
 * The obvious alternative was worse. Answering `no-session-yet` for a mixed
 * batch keeps the rows and stops the drain, and the drain is oldest-first, so
 * ONE permanently unfileable fix in the oldest five hundred holds up everything
 * behind it until `queueRetentionDays` ages it out — and the phones with an
 * unfileable tail are exactly the phones in the incident. A handful of lost
 * fixes becomes a week of lost days.
 *
 * WHY IT IS PINNED AS TEXT. The route's answer is a string in a Next.js handler
 * and the handset's reading is a string in a project this `tsconfig.json`
 * excludes; the two are joined only inside a phone, exactly like the schema
 * rule at the top of this file. A word the ROUTE can answer and the HANDSET
 * does not know is read as "delivered" and deletes the batch, which is the bug
 * itself arriving under a new name.
 *
 * THE OTHER DIRECTION IS DELIBERATELY NOT AN ERROR. A word the handset knows
 * and the route does not answer yet is the SAFE deploy order and the whole
 * reason any of this can ship before a single APK is updated — an APK cannot be
 * recalled, so the phone has to be able to learn a word first. `AHEAD_OF_THE_
 * ROUTE` is where such a word is recorded rather than forgotten, and the test
 * below empties it, in the same idiom as `OUTSTANDING` above.
 * ------------------------------------------------------------------------- */

const POSITIONS_ROUTE = "src/app/api/mbos/positions/route.ts";
const FLUSH_ENGINE = "mbos-app/src/engines/flush-answer.ts";

/**
 * Words the handset can read that the route cannot yet answer.
 *
 * EMPTY, and that is the state it is supposed to be in. `partial` sat here
 * while the server half was on its own branch; that branch has landed, the
 * route answers the word, and the test after this one is what took it off —
 * a list that keeps a word the route now says is a list that stops meaning
 * anything, and the next entry is then read as noise.
 */
const AHEAD_OF_THE_ROUTE = new Set<string>([]);

/** Every `tracking: "…"` literal the route can put in an answer. */
function routeWords(): Set<string> {
  const src = readFileSync(POSITIONS_ROUTE, "utf8");
  return new Set([...src.matchAll(/tracking:\s*"([a-z-]+)"/g)].map((m) => m[1]!));
}

/** Every word `decideFlush` compares against. */
function handsetWords(): Set<string> {
  const src = readFileSync(FLUSH_ENGINE, "utf8");
  return new Set(
    [...src.matchAll(/answer\.tracking\s*===\s*'([a-z-]+)'/g)].map((m) => m[1]!),
  );
}

test("every tracking word the route can answer is one the handset reads", () => {
  const route = routeWords();
  const handset = handsetWords();
  assert.ok(route.size >= 2, "found almost no tracking answers — the scan is broken, not the route");
  assert.ok(handset.size >= 2, "found almost no tracking branches — the scan is broken, not the engine");

  const unread = [...route].filter((w) => !handset.has(w));
  assert.deepEqual(
    unread,
    [],
    "the route can answer these and the handset has never heard of them, so it " +
      "reads them as a clean delivery and DELETES the batch — which is the " +
      "data-loss bug `partial` was added to fix, wearing a new word: " +
      unread.join(", "),
  );
});

test("a word the handset learned first is recorded rather than forgotten", () => {
  const route = routeWords();
  const early = [...handsetWords()].filter((w) => !route.has(w));
  const unrecorded = early.filter((w) => !AHEAD_OF_THE_ROUTE.has(w));
  assert.deepEqual(
    unrecorded,
    [],
    "the handset branches on these and the route never says them, which is " +
      "either the safe deploy order or a word that has quietly died. Say which " +
      "by putting it in AHEAD_OF_THE_ROUTE with a reason: " + unrecorded.join(", "),
  );

  const landed = [...AHEAD_OF_THE_ROUTE].filter((w) => route.has(w));
  assert.deepEqual(
    landed,
    [],
    "the route answers these now, so they should come off AHEAD_OF_THE_ROUTE " +
      "or the list stops meaning anything: " + landed.join(", "),
  );
});

test("partial keeps the rows it was not told about, and does not stop the drain", () => {
  const src = readFileSync(FLUSH_ENGINE, "utf8");
  const branch = src.slice(src.indexOf("answer.tracking === 'partial'"));
  const body = branch.slice(0, branch.indexOf("\n  }"));

  assert.ok(
    /carryOn:\s*remove\.length\s*>\s*0/.test(body),
    "partial must carry on to the next batch whenever something moved. A flat " +
      "`carryOn: false` here is `no-session-yet` wearing a different word, and " +
      "it head-of-line blocks the whole queue behind one unfileable fix for " +
      "`queueRetentionDays`.",
  );
  assert.ok(
    !/remove:\s*\[\.\.\.sentIds\]/.test(body),
    "partial must delete only what the server named. Deleting the batch is the " +
      "original bug: rows the office never stored, gone from the phone.",
  );
});

/* ---------------------------------------------------------------------------
 * A NUMBER IS NOT A BOOLEAN, and SQLite cannot tell you which it meant.
 *
 * Every flag on the handset is an `INTEGER NOT NULL DEFAULT 0`, because SQLite
 * has no boolean type. `insertAndQueue` writes the row through `toColumns`,
 * which converts a real boolean to 0/1 for the database — and enqueues the row
 * OBJECT, unconverted, as the wire payload. So the two halves agree only while
 * the caller passes a genuine boolean. A caller that hand-converts to `1`
 * itself stores an identical row and sends a number, and `z.boolean()` refused
 * the payload with "expected boolean, received number".
 *
 * That is not a theoretical drift. `openDay` did exactly this, so every
 * expense day a handset opened was refused; an expense day is the DEPENDENCY
 * of every travel leg, so each leg was refused behind it; and a visit is only
 * reachable through an open leg. One hand-converted flag took the whole field
 * workflow down, and the only trace was six rejection rows nobody was reading.
 *
 * Neither half of this can be checked by a compiler. `insertAndQueue` takes
 * `Record<string, unknown>`, so a number is as type-correct as a boolean; and
 * the server's schema lives in a different project. So it is checked here, as
 * text, on both sides — the server must ACCEPT what a phone can say, and the
 * phone must not say it in the first place.
 * ------------------------------------------------------------------------- */

const SYNC_ACTIONS = "src/lib/actions/mbos.ts";
const HANDSET_DATA = "mbos-app/src/data";

test("the sync schemas accept a boolean as a handset can express one", () => {
  const src = readFileSync(SYNC_ACTIONS, "utf8");
  const offenders = src
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    /* `z.union([z.boolean(), …])` is a deliberate mixed field and is left
       alone; what must not appear is a bare boolean standing on its own as a
       payload field, which is the shape a phone cannot satisfy. */
    .filter(({ line }) => /z\.boolean\(\)\s*\.(nullish|optional|nullable)\(\)/.test(line));

  assert.deepEqual(
    offenders,
    [],
    `${SYNC_ACTIONS} has ${offenders.length} payload field(s) demanding a strict boolean. ` +
      "SQLite holds 0/1, so use `wireBoolean` — see its own note for why this is " +
      "the server's job rather than the handset's: " +
      offenders.map((o) => `${o.n}: ${o.line}`).join(" | "),
  );
});

test("no queued row hand-converts a boolean to 0/1", () => {
  const offenders: string[] = [];

  for (const file of readdirSync(HANDSET_DATA)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const src = readFileSync(`${HANDSET_DATA}/${file}`, "utf8");

    /* Only the QUEUED writers matter. A raw `INSERT INTO … VALUES (?)` builds
       its payload separately and is free to pass 0/1 to SQLite, which is what
       SQLite wants; it is the row object that doubles as the wire payload
       where the two meanings collide. */
    for (const call of ["insertAndQueue({", "updateAndQueue({"]) {
      let at = src.indexOf(call);
      while (at !== -1) {
        const end = src.indexOf("\n  });", at);
        const block = src.slice(at, end === -1 ? src.length : end);
        for (const [i, line] of block.split("\n").entries()) {
          if (!/\?\s*1\s*:\s*0|\?\s*0\s*:\s*1/.test(line)) continue;
          const n = src.slice(0, at).split("\n").length + i;
          offenders.push(`${file}:${n}: ${line.trim()}`);
        }
        at = src.indexOf(call, at + 1);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} queued row(s) convert a boolean to 0/1 by hand. The row ` +
      "object IS the wire payload — pass a real boolean and let `toColumns` " +
      "convert it for SQLite: " +
      offenders.join(" | "),
  );
});

/* ---------------------------------------------------------------------------
 * §16 — THE CHASE COUNT, AND THE ONE CHANNEL THIS FILE'S FIRST TEST CANNOT
 * SEE.
 *
 * `samples` is not in `WIRE` and never can be. `upsertSamples` in
 * `sync/pull.ts` is one of the three HAND-ROLLED handlers — it types its
 * column list out, because almost nothing on that row is the same word on both
 * sides: `quantityCans` lands in `cans`, `feedbackNotes` lands in `reason`,
 * `requestedDate` becomes an instant, and `state` is derived where the office
 * did not send one. The column-name check above compares a payload's keys
 * against a table's columns and would report every one of those as a fault.
 *
 * What it buys in flexibility it pays for in silence, and the bill is the
 * shape `upsertTasks` already sent once: a typed list CANNOT FAIL on a field
 * the server does not send. It reads `undefined`, the `ON CONFLICT` clause
 * writes that `undefined` over whatever was on the row, and a note the
 * salesman typed is gone with nothing logged at either end.
 *
 * So the chase count is pinned at all five links by hand: the office SELECTS
 * it, the handset READS it, INSERTS it, KEEPS it on conflict, and has a column
 * for it to land in. Four of the five passing and one failing is the state
 * that loses data rather than the state that throws.
 * ------------------------------------------------------------------------- */

const CHASE_COLUMNS = ["reviewChaseCount", "lastReviewChaseAt"] as const;

const PULL = "mbos-app/src/sync/pull.ts";

function upsertSamplesBlock(): string {
  const src = readFileSync(PULL, "utf8");
  const at = src.indexOf("async function upsertSamples");
  assert.ok(at > -1, "upsertSamples is gone from sync/pull.ts — this test needs updating with it");
  const end = src.indexOf("\n  return rows.length;", at);
  assert.ok(end > at, "upsertSamples no longer ends the way this test reads it");
  return src.slice(at, end);
}

test("the sample chase count is sent, read, inserted and kept", () => {
  const service = readFileSync(SERVICE, "utf8");
  const samplesQuery = service.slice(service.indexOf("async function openSamples"));
  const select = samplesQuery.slice(0, samplesQuery.indexOf("from mbos_samples"));
  const block = upsertSamplesBlock();
  const tables = handsetTables();
  const local = tables.get("samples");
  assert.ok(local, "the handset has no `samples` table");

  const faults: string[] = [];
  for (const column of CHASE_COLUMNS) {
    if (!select.includes(`as "${column}"`)) {
      faults.push(`${column}: openSamples does not select it, so the handset reads undefined`);
    }
    if (!block.includes(`${column}?:`)) {
      faults.push(`${column}: upsertSamples does not declare it on the payload`);
    }
    /* The INSERT's own column list, which is the half that decides whether a
       first pull of a sample carries the number at all. */
    if (!new RegExp(`INSERT INTO samples[\\s\\S]*?\\b${column}\\b[\\s\\S]*?VALUES`).test(block)) {
      faults.push(`${column}: upsertSamples does not insert it`);
    }
    /* AND THE HALF THAT LOSES IT. Without this line every later pull writes
       the column's previous value back unchanged — or, where the payload key
       is missing, writes `undefined` over a number the office raised. */
    if (!block.includes(`${column} = excluded.${column}`)) {
      faults.push(`${column}: upsertSamples does not keep it on conflict, so it never updates`);
    }
    if (!local.has(column)) {
      faults.push(`${column}: the handset's samples table has no column for it`);
    }
  }

  assert.deepEqual(
    faults,
    [],
    "§16's chase count joins the office to the phone through five links and " +
      "every one of them is a spelling:\n  " + faults.join("\n  "),
  );
});

test("the handset's chase columns carry no default", () => {
  const schema = readFileSync(HANDSET_SCHEMA, "utf8");
  for (const column of CHASE_COLUMNS) {
    const line = schema
      .split("\n")
      .find((l) => l.includes(`ADD COLUMN ${column} `));
    assert.ok(line, `${column} is not added by any migration`);
    /*
     * NULLABLE AND UNDEFAULTED, and this is the whole reason the migration is
     * written the way it is. `DEFAULT 0` backfills every sample already on the
     * phone with the one value that means "nobody has asked" — which is
     * exactly the fact a screen must not assert about a sample the office has
     * chased three times and has not yet told this handset about. Null says
     * the true thing: nothing has told us. `chaseCountOf` answers null for it
     * and no caller may default it back.
     */
    assert.ok(
      !/DEFAULT/i.test(line) && !/NOT NULL/i.test(line),
      `${column} must stay nullable with no default — zero chases and "this phone ` +
        `has not been told" are different facts, and a default destroys the second`,
    );
  }
});

/* ---------------------------------------------------------------------------
 * §9 — A FIELD CHECKED IN THE SHOP, and the quietest failure on this wire.
 *
 * `leadSchema` is a plain `z.object`, and a plain `z.object` STRIPS what it
 * does not declare — no refusal, no log, nothing named in a rejection. So a
 * handset that posts `fieldChecks` against a schema that has never heard of
 * them gets `accepted` back, the salesman's nine answers are gone by the time
 * the handler reads `parsed.data`, and the office has a lead nobody appears to
 * have checked.
 *
 * This belongs HERE rather than beside the column checks above because
 * `fieldChecks` has no handset COLUMN — it is an upward payload written into
 * `lead_verification_corrections`, which is a table the phone does not hold.
 * ------------------------------------------------------------------------- */

test("§9's field checks survive the wire in both directions", () => {
  const actions = readFileSync(SYNC_ACTIONS, "utf8");
  const schema = actions.slice(actions.indexOf("const leadSchema = z.object("));
  const declared = schema.slice(0, schema.indexOf("\n});"));

  assert.ok(
    /\bfieldChecks:\s*z\s*$|\bfieldChecks:\s*z/m.test(declared),
    "leadSchema no longer declares `fieldChecks`, so every check a salesman " +
      "makes standing in a shop is stripped by safeParse and the sync still " +
      "answers accepted",
  );

  /* The handset's own shape, so the two cannot drift into different words for
     one answer. `field-check.ts` is pure and compiled by both projects' test
     runners; what is NOT shared is this schema, and a key renamed at one end
     is a field silently dropped at the other. */
  const engine = readFileSync("mbos-app/src/engines/field-check.ts", "utf8");
  const type = engine.slice(engine.indexOf("export type FieldCheck = {"));
  const keys = [...type.slice(0, type.indexOf("\n};")).matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 5, "FieldCheck has almost no fields — the scan is broken, not the code");

  /* `changedById` and `changedByName` are deliberately NOT read off the
     payload: a device somebody owns may name anybody, and the row is read back
     months later as "who checked this". The server writes the principal. */
  const fromThePhone = keys.filter((k) => k !== "changedById" && k !== "changedByName");
  const missing = fromThePhone.filter((k) => !new RegExp(`\\b${k}:`).test(declared));
  assert.deepEqual(
    missing,
    [],
    "the handset puts these on a field check and leadSchema does not name them, " +
      `so safeParse removes them without a word: ${missing.join(", ")}`,
  );

  /* AND THE REFUSAL, which is the server half of the screen's own. A
     correction with no value or no reason is one person's word against
     another's with nothing to settle it — refused here as well as on the
     handset, because a sync endpoint accepts a payload from a device somebody
     owns and a form is not a rule. The database says the same thing in
     `lead_verification_corrections_corrected_says_why`; what this adds is a
     sentence somebody can act on instead of a constraint violation. */
  assert.match(
    actions,
    /for \(const c of p\.fieldChecks \?\? \[\]\) \{[\s\S]*?c\.verdict !== "corrected"[\s\S]*?kind: "rejected"/,
    "handleLeadUpdate no longer refuses a correction carrying no value or no reason",
  );
});

/* ---------------------------------------------------------------------------
 * AND THE LIST THAT ANSWERS "WHERE DID THIS ONE COME FROM".
 *
 * `leads.sources` is a configured list the office publishes and the handset's
 * new-lead form draws a picker from, joined — like `mbos.ai.dictation` above —
 * by a spelling and nothing else. It is NOT covered by the `mbos.*` scan
 * further up this file, which matches on that prefix alone, and the funnel's
 * settings were deliberately named for the FEATURE rather than for the app.
 *
 * Get any of the three links wrong and NOTHING FAILS. `getConfig` falls
 * through to the handset's compiled copy, the picker draws five codes the
 * office does not have, and every lead a salesman raises is filed under a
 * channel nothing can count — which is the bug that list's own comment in
 * `data/config.ts` records having already happened once.
 * ------------------------------------------------------------------------- */

test("the lead sources list is spelled the same on both sides", () => {
  const KEY = "leads.sources";

  const registry = readFileSync("src/lib/config/registry.ts", "utf8");
  assert.ok(
    registry.includes(`key: "${KEY}"`),
    `${KEY} is not in the registry, so no office can edit it and every handset ` +
      "runs on a compiled list",
  );

  /*
   * THE PREFIX IS THE LINK, and it is the half that is easy to lose. This loop
   * sent `mbos.*` alone once, so not one funnel setting ever reached a phone —
   * silently, because a defaulted value is a plausible value.
   */
  const service = readFileSync(SERVICE, "utf8");
  const payload = service.slice(service.indexOf("export async function mbosConfigPayload"));
  assert.match(
    payload.slice(0, payload.indexOf("\n}")),
    /key\.startsWith\("leads\."\)/,
    "mbosConfigPayload no longer publishes the `leads.` prefix — every funnel " +
      "setting falls back to the handset's compiled default and nothing says so",
  );

  const config = readFileSync("mbos-app/src/data/config.ts", "utf8");
  assert.ok(
    config.includes(`getConfig<LeadSource[]>('${KEY}')`),
    `the handset no longer reads ${KEY}, so its picker draws codes the office ` +
      "has never heard of and every lead is filed under a channel nobody can count",
  );
  assert.ok(
    config.includes(`'${KEY}':`),
    `${KEY} has no entry in the handset's DEFAULTS, so a handset that has not ` +
      "bootstrapped offers no sources at all",
  );
});

/* ---------------------------------------------------------------------------
 * §5.5 — A COMMITMENT IS A DATE AND A QUANTITY, AND THE OTHER TWO THIRDS OF IT
 * LIVED IN A KEY-VALUE STORE.
 *
 * Mahek's own answer, and it overrules §9 where the two differ: "they will
 * order some time next week" is not a commitment anybody can plan a godown
 * around, and a promise with no size on it cannot be held against the order
 * that eventually answers it. The blocker beside it says whose work it is that
 * the order has not happened — four codes for four different desks, plus the
 * ordinary answer that nothing is in the way.
 *
 * `recordExpectedOrder` has collected all four since the commitment sheet
 * shipped and could send only two. There was no column on `customers` for the
 * quantity until `0151` and none for the blocker until `0156`, no field on
 * `leadSchema` for either, and no column on the handset — so the two it could
 * not send were kept in `kv` under `lead.commitment.<id>`, where no sync
 * touches them. That was the RIGHT answer while it held, and the reason is the
 * one this test exists to keep true: a field `leadSchema` does not declare is
 * stripped by zod IN SILENCE. No refusal, no log, no rejection row — the
 * salesman types the size in, the app says saved, and the column stays null
 * for ever. `mbos-payload-contract.test.ts` refuses such a field for exactly
 * that reason and is what held the handset back.
 *
 * Both ends landed together, which is the only way this may ever be done, and
 * the links are the same five every other field on this wire has: the server
 * SENDS it, the handler READS it, the INSERT and the `ON CONFLICT` clause KEEP
 * it — two assertions, because a hand-rolled handler types its column list out
 * and a field read and never kept reads exactly like a column of nulls — and
 * the table has somewhere to PUT it. Two of them travel back up as well, so
 * `leadSchema` has to declare them or the wire is one-way again.
 * ------------------------------------------------------------------------- */

/** Wire name → what a lead loses if this link breaks. */
const LEAD_COMMITMENT_FACTS: Record<string, string> = {
  expectedOrderQuantityCans:
    "§5.5 — HOW MUCH they said they would take. Without it a commitment is a " +
    "day with no size on it, which is a follow-up rather than a forecast, and " +
    "no order can be measured against what was promised",
  expectedOrderBlockerCode:
    "§5.5 — WHAT IS IN THE WAY, as a code. Without it 'how much are we " +
    "forecasting behind credit terms this quarter' is a grep over sentences " +
    "nobody typed the same way twice, and four problems with four owners " +
    "count as one number",
  createdAt:
    "when the lead was actually RAISED. The handset binds the moment of the " +
    "pull into clientCreatedAt, so an age read off that says 'today' on a " +
    "four-year-old lead and says something else again after a reinstall",
  backOfficeAmName:
    "§7 — WHO holds the back office seat. The id alone is unrenderable here, " +
    "because this app holds no user table, so a screen can say the seat is " +
    "filled and never by whom",
};

test("a commitment's size, its blocker and a lead's two missing facts survive the wire", () => {
  const service = readFileSync(SERVICE, "utf8");
  const pull = readFileSync("mbos-app/src/sync/pull.ts", "utf8");
  const sent = new Set(payloadColumns(service, "openLeads"));
  const read = new Set(fieldsRead(pull, "upsertLeads"));
  const columns = handsetTables().get("leads") ?? new Set<string>();

  const at = pull.indexOf("function upsertLeads(");
  const body = pull.slice(at, pull.indexOf("\n}", at));
  const inserted = new Set(
    (body.match(/INSERT INTO leads \(([^)]*)\)/)?.[1] ?? "")
      .split(",")
      .map((c) => c.trim()),
  );
  const kept = new Set([...body.matchAll(/(\w+) = excluded\.\1/g)].map((m) => m[1]));

  const faults: string[] = [];
  for (const [field, why] of Object.entries(LEAD_COMMITMENT_FACTS)) {
    if (!sent.has(field)) faults.push(`openLeads does not send ${field} — ${why}`);
    if (!read.has(field)) faults.push(`upsertLeads does not read ${field} — ${why}`);
    if (!inserted.has(field)) {
      faults.push(
        `upsertLeads reads ${field} and never inserts it, which reads on every ` +
          `screen exactly like a column of nulls — ${why}`,
      );
    }
    if (!kept.has(field)) {
      faults.push(
        `upsertLeads inserts ${field} and does not update it on conflict, so it ` +
          "is whatever it was the first time this lead arrived — and a lead is " +
          "on the phone long before anybody records a commitment against it",
      );
    }
    if (!columns.has(field)) {
      faults.push(
        `the handset's leads table has no ${field} column — the server sends it, ` +
          "applyPull throws on the unknown column, and ONE transaction rolls " +
          "back the ENTIRE pull",
      );
    }
  }

  assert.deepEqual(faults, [], `\n  ${faults.join("\n  ")}`);
});

test("the commitment the salesman records reaches the office, and its blocker is checked against the stored list", () => {
  const actions = readFileSync(SYNC_ACTIONS, "utf8");
  const funnel = readFileSync("mbos-app/src/data/lead-funnel.ts", "utf8");

  /* UP AS WELL AS DOWN, which is the half `gstVerified` deliberately does not
     have. The salesman is the one standing in the shop being told the number,
     so the schema has to name both or `safeParse` strips them without a word
     and the office keeps a date with no size on it. */
  for (const field of ["expectedOrderQuantityCans", "expectedOrderBlockerCode"]) {
    assert.ok(
      new RegExp(`\\b${field}: z\\.`).test(actions),
      `leadSchema no longer declares ${field}, so zod strips it in silence — ` +
        "the salesman types it in, the app says saved, and the column stays null",
    );
    assert.ok(
      new RegExp(`\\b${field}:`).test(funnel),
      `recordExpectedOrder no longer puts ${field} on the patch, so the office ` +
        "hears a commitment with a piece missing and nothing anywhere says so",
    );
  }

  /* AND THE `kv` WORKAROUND IS GONE. Left in place it would be a second home
     for one fact — a size on the row and a size in the store, disagreeing the
     first time a manager corrects one at a desk. */
  assert.ok(
    !/lead\.commitment\./.test(funnel),
    "the lead.commitment.<id> key is back in lead-funnel.ts. Both halves now " +
      "have a column, so a second copy in `kv` is one that can disagree with " +
      "the row the office and the phone both read",
  );

  /* THE CODE IS CHECKED AGAINST THE STORED LIST, never an enum typed out
     beside the handler. A hard-coded list beside a configured one is two
     definitions waiting to disagree, and the disagreement arrives the day a
     manager rewords a blocker on the Settings screen. */
  assert.match(
    actions,
    /\["leads\.orderBlockers"\]/,
    "handleLeadUpdate no longer checks the blocker against leads.orderBlockers. " +
      "A list retyped beside the handler is one that stops matching the office's " +
      "the day somebody rewords a code, and the stored value then resolves to nothing",
  );

  /* AND THE HANDSET HAS THE LIST BEFORE ITS FIRST BOOTSTRAP. A missing DEFAULTS
     entry here is invisible rather than loud: `getConfig` answers `undefined`,
     the picker draws no chips, and the sheet becomes a title and a button that
     can only ever say "Pick one" — on a deployment that published the list. */
  const config = readFileSync("mbos-app/src/data/config.ts", "utf8");
  assert.ok(
    config.includes("'leads.orderBlockers':"),
    "leads.orderBlockers has no entry in the handset's DEFAULTS, so a handset " +
      "that has not bootstrapped offers no blockers at all and a commitment " +
      "cannot be recorded",
  );
});

/* ---------------------------------------------------------------------------
 * THE ADDRESS, WHICH WENT UP AND NEVER CAME BACK.
 *
 * `lead-intake.ts` writes `customers.address` and `leadSchema` accepts it from
 * the handset, so a salesman standing outside a shop could send one. Nothing
 * ever sent it the other way: `openLeads` did not select it, so an address
 * corrected at a desk reached the phone on no pass, ever, and what he
 * navigated from instead was a pin or a city — on a book where roughly half
 * the shops have no pin at all.
 *
 * Five links and every one of them is a spelling, like the chase count above:
 * the office SELECTS it, `upsertLeads` READS it, INSERTS it, KEEPS it on
 * conflict, and the table has somewhere to put it. Four passing and one
 * failing is the state that loses data rather than the state that throws.
 * ------------------------------------------------------------------------- */

test("a lead's address survives all five links of the wire", () => {
  const service = readFileSync(SERVICE, "utf8");
  const pull = readFileSync(PULL, "utf8");
  const at = pull.indexOf("function upsertLeads(");
  const body = pull.slice(at, pull.indexOf("\n}", at));

  const faults: string[] = [];
  if (!payloadColumns(service, "openLeads").includes("address")) {
    faults.push(
      "openLeads does not select `address`, so the handset reads undefined and " +
        "an address corrected at a desk reaches the phone on no pass",
    );
  }
  if (!fieldsRead(pull, "upsertLeads").includes("address")) {
    faults.push("upsertLeads does not declare `address` on the payload it reads");
  }
  if (!(body.match(/INSERT INTO leads \(([^)]*)\)/)?.[1] ?? "").split(",").map((c) => c.trim()).includes("address")) {
    faults.push(
      "upsertLeads does not insert `address`, which on every screen reads " +
        "exactly like a shop nobody wrote an address for",
    );
  }
  if (!body.includes("address = excluded.address")) {
    faults.push(
      "upsertLeads does not keep `address` on conflict, so it is whatever it " +
        "was the first time this lead arrived and a correction never lands",
    );
  }
  if (!(handsetTables().get("leads") ?? new Set()).has("address")) {
    faults.push("the handset's leads table has no `address` column");
  }

  assert.deepEqual(faults, [], `\n  ${faults.join("\n  ")}`);
});

/* ---------------------------------------------------------------------------
 * §8 AND §5.2 — THE TWO CHANNELS THAT ONLY EVER RAN ONE WAY.
 *
 * `mbos_lead_validations` and `lead_verification_corrections` are both written
 * from the handset and were both sent down by nothing, so a salesman saw the
 * calls he had made himself and none of the office's, and saw his own figures
 * silently replaced with no record anywhere of who replaced them or why.
 *
 * These are column-name checks like the `WIRE` test above them, and they are
 * NOT redundant with it: that one asks whether a column the office sends has
 * somewhere to land, which is the failure that throws. This asks the opposite
 * — whether the column is sent at all — which is an ABSENCE, is a fault in no
 * file, and can only be caught against a second list. It is the same shape as
 * the eleven columns `customersForDevice` sent and its delta did not.
 * ------------------------------------------------------------------------- */

/** Wire name → what the lead record loses if the office stops sending it. */
const VALIDATION_FACTS: Record<string, string> = {
  calledAt: "WHEN the office rang. Two calls is common and the first is usually the one that matters, so a list with no dates cannot be read in order",
  reached: "whether anybody picked up. A verdict off a call that never connected is a verdict about nothing",
  verdict: "what the office concluded, which is what moves the lead",
  verdictReason: "WHY it was turned down. Without it the salesman who raised it raises the next one exactly like it",
  confirmedRequirement: "what the shop told the OFFICE it wants, beside what it told him. The two disagreeing is the single most useful thing this call produces",
  confirmedMonthlyVolumeLitres: "the volume the shop gave the office, which is a number somebody will quote back at him",
  confirmedCompetitor: "whose product the shop told the office it uses, which is the fact a negotiation starts from",
  confirmedPotentialPaise: "what the office was told this shop could be worth",
  /* §8's OTHER TWELVE. The table has had a column for each of them since the
     call was built; the wire declared five, so a call the office made reached
     the phone a third told and a call the phone made was stripped by zod on the
     way up — silently, with an accepted item coming back. */
  salesmanVisited: "whether the shop says our man came at all. It is the question §8 exists for, and a check on a salesman's own work that never reaches a record is no check",
  mahekExplained: "whether Mahek was explained properly. No amount of GPS proves it, which is why somebody has to ring and ask",
  productUnderstood: "whether any of it landed. A visit the shop cannot describe afterwards is a visit that sold nothing",
  currentProduct: "what they are using TODAY, in their own words — the thing a first order has to displace",
  growthPotential: "whether the monthly figure could grow, said as a sentence. The number beside it is what somebody guessed; this is what the shop said",
  priceConcern: "whether price is the objection. Answered into a free-text impression it is a sentence; here it is the count §8 exists to produce",
  genuineInterest: "whether they actually want to try it. It is the last question of the section and the one a sample is worth risking on",
  creditConcern: "whether the CREDIT terms are the objection rather than the price. A shop happy with the price and stuck on the terms is a different offer entirely",
  competitorConcern: "what holds them to whoever supplies them now. Knowing the incumbent's name says nothing about how hard they are to displace",
  readyForTrial: "whether the SHOP said it was ready for a trial. §5.4 decides a sample on this answer and on nothing else",
  readyForCommercial: "whether they are ready to talk terms, which is what authorises a commercial conversation",
  readyForOrder: "whether they are ready to order. Absent, the next call has to ask the whole of §8 again",
  calledByName: "WHO made the call. An id is unrenderable here — this app holds no user table — and the answer to a figure he disagrees with is to ring that person",
  clientCreatedAt: "NOT NULL on the handset, so a row the office authored cannot be inserted without it",
  deviceId: "NOT NULL on the handset, and it is also which door wrote the row",
};

/** Wire name → what the record loses without it. */
const FIELD_CHECK_FACTS: Record<string, string> = {
  field: "WHICH finding was checked. Without it a check cannot be drawn beside the value it is about, which is the whole of what makes it readable",
  verdict: "which of the three answers. A confirmation, a correction and 'we asked and could not establish it' are three different facts about one figure",
  original: "what the salesman had when he was asked. The before/after PAIR is the point — the correction alone is a fact about the shop and not about how the record came to say what it says",
  corrected: "what he was told instead",
  reason: "why the two differ. A correction with nothing behind it is one man's word against another's with nothing to settle it",
  changedByName: "WHO checked it, readable after the account is gone",
  changedAt: "WHEN. A field checked last March and one checked yesterday are not the same assurance",
  validationId: "WHICH DOOR — null is a check made standing in the shop and an id is one made on the office's call, and they read differently to the man deciding whether to argue with the figure",
};

test("the office's verification call and every check on a finding reach the handset", () => {
  const service = readFileSync(SERVICE, "utf8");
  const pull = readFileSync(PULL, "utf8");
  const tables = handsetTables();
  const faults: string[] = [];

  const channels: { fn: string; table: string; facts: Record<string, string> }[] = [
    { fn: "leadValidations", table: "lead_validations", facts: VALIDATION_FACTS },
    { fn: "leadFieldChecks", table: "lead_field_checks", facts: FIELD_CHECK_FACTS },
  ];

  for (const { fn, table, facts } of channels) {
    const sent = new Set(payloadColumns(service, fn));
    const local = tables.get(table);
    if (!local) {
      faults.push(`the handset has no \`${table}\` table for ${fn} to fill`);
      continue;
    }
    for (const [field, why] of Object.entries(facts)) {
      if (!sent.has(field)) faults.push(`${fn} does not send ${field} — ${why}`);
      if (!local.has(field)) {
        faults.push(
          `${table} has no ${field} column — the office sends it, applyPull throws ` +
            "on the unknown column, and ONE transaction rolls back the ENTIRE pull",
        );
      }
    }
    /* APPLIED, not merely sent. A channel built and applied by nothing is the
       state `leads` and `samples` sat in for as long as they existed: on the
       bootstrap, on no delta, and read by no upsert at all. */
    if (!pull.includes(`upsert('${table}',`)) {
      faults.push(
        `sync/pull.ts never upserts \`${table}\`, so the rows arrive and are ` +
          "dropped on the floor — the exact failure that left MBOS with no " +
          "reference data at all while everything the salesman authored worked",
      );
    }
  }

  /* THE GUARD ON THE OWNED ONE. `lead_validations` is written by the handset
     too, so a call sitting in the outbox is a fact the office has not heard
     yet and nothing arriving may write over it. `leads` and `samples` carry
     the same clause for the same reason. */
  assert.ok(
    /lead_validations\.syncState = 'synced'/.test(pull),
    "the lead_validations upsert has lost its `syncState = 'synced'` guard, so " +
      "a pull can write the office's answer over a call still waiting in the outbox",
  );

  /* AND THE OFFICE'S ROWS LAND IN THE HANDSET'S OWN TABLE, which is what keeps
     a call made on this phone from being drawn twice: `handleLeadValidation`
     keeps the id the handset minted, so the row comes back as itself. */
  assert.ok(
    /insert\(mbosLeadValidations\)[\s\S]{0,200}id: item\.entityId/.test(
      readFileSync(SYNC_ACTIONS, "utf8"),
    ),
    "handleLeadValidation no longer stores the handset's own entityId as the row " +
      "id, so a call made on the phone comes back down as a SECOND row and the " +
      "record shows every handset-made call twice",
  );
});

/* ---------------------------------------------------------------------------
 * AND THE SAME SEVENTEEN GOING UP, which is four links rather than one.
 *
 * The test above walks the DOWN direction. This one walks the up: the office's
 * zod schema has to DECLARE each answer, the insert beside it has to NAME each
 * one, the handset has to agree it can carry each, and `validationsFor` has to
 * read each back. Every link fails silently on its own and each in its own
 * shape — zod strips an undeclared field and answers `accepted`, a declared
 * field no insert names is stored nowhere at all, a column missing from
 * `CARRIED` is a question the form simply stops drawing, and one missing from
 * the read is an answer that arrived and no screen shows. That split cost five
 * columns once already, in `0157`, where the schema and the `columns` map both
 * picked them up for free and the one hand-typed `values` list did not.
 * ------------------------------------------------------------------------- */

const HANDSET_VALIDATIONS = "mbos-app/src/data/validations.ts";

/** Answer column → what a lead's record loses where the link is broken. */
const ANSWER_COSTS: Record<string, string> = {
  salesmanVisited: "nobody can tell a shop that says our man never came from one nobody asked",
  mahekExplained: "the one question no GPS can answer goes unrecorded",
  productUnderstood: "a visit the shop cannot describe afterwards reads as a visit that worked",
  currentProduct: "what a first order has to displace is unknown to whoever makes the next call",
  growthPotential: "the shop's own words about whether the figure could grow are lost behind somebody's guess",
  priceConcern: "how many were lost on price stops being a question anybody can ask",
  genuineInterest: "a sample goes out on the salesman being ready to ask rather than on the shop wanting it",
  creditConcern: "a shop stuck on the terms is filed as a shop stuck on the price",
  competitorConcern: "how hard the incumbent is to displace is never written down",
  readyForTrial: "§5.4 decides a sample on this and would be deciding it on nothing",
  readyForCommercial: "a commercial conversation is opened on nobody's word",
  readyForOrder: "the next call asks the whole of §8 over again",
  confirmedRequirement: "the contradiction this call exists to produce cannot be seen",
  confirmedCompetitor: "the fact a negotiation starts from is lost",
  salesmanFeedback: "how the shop found our man is lost",
  qualityFeedback: "a quality objection is unreadable as anything but prose",
  dispatchFeedback: "a service objection is unreadable as anything but prose",
};

test("every answer §8 asks survives the round trip, at both ends", () => {
  const actions = readFileSync(SYNC_ACTIONS, "utf8");
  const handset = readFileSync(HANDSET_VALIDATIONS, "utf8");
  const faults: string[] = [];

  /* The schema and the insert, read as the two TEXT regions they are: the zod
     object, and the `.values({…})` of the insert `handleLeadValidation` makes.
     Both are in one file and neither is reachable from a type. */
  const schemaAt = actions.indexOf("const leadValidationSchema = z.object({");
  assert.ok(schemaAt > -1, "leadValidationSchema is gone — this test needs updating with it");
  const schema = actions.slice(schemaAt, actions.indexOf("\n});", schemaAt));

  const insertAt = actions.indexOf(".insert(mbosLeadValidations)");
  assert.ok(insertAt > -1, "handleLeadValidation no longer inserts into mbosLeadValidations");
  const insert = actions.slice(insertAt, actions.indexOf("onConflictDoNothing", insertAt));

  /* The handset's two halves: the list saying what it can carry, and the one
     query that reads a call back for the record page. */
  const carriedAt = handset.indexOf("const CARRIED");
  assert.ok(carriedAt > -1, "the handset's CARRIED list is gone — the form's filter reads it");
  const carried = handset.slice(carriedAt, handset.indexOf("]);", carriedAt));

  const readAt = handset.indexOf("FROM lead_validations");
  assert.ok(readAt > -1, "validationsFor no longer selects from lead_validations");
  const readBack = handset.slice(handset.lastIndexOf("SELECT", readAt), readAt);

  for (const [column, cost] of Object.entries(ANSWER_COSTS)) {
    if (!new RegExp(`\\n\\s*${column}:`).test(schema)) {
      faults.push(
        `leadValidationSchema does not declare ${column} — zod strips it in SILENCE ` +
          `and answers the handset "accepted", so ${cost}`,
      );
    }
    if (!new RegExp(`\\n\\s*${column}: p\\.`).test(insert)) {
      faults.push(
        `handleLeadValidation never writes ${column} — declared and unwritten is the ` +
          `worse of the two, because the payload arrives and the column stays null: ${cost}`,
      );
    }
    if (!carried.includes(`'${column}'`)) {
      faults.push(
        `the handset's CARRIED list has no ${column}, so \`answerableQuestions\` drops ` +
          `its question and the form never draws the box: ${cost}`,
      );
    }
    if (!new RegExp(`\\b${column}\\b`).test(readBack)) {
      faults.push(
        `validationsFor never reads ${column} back, so the answer arrives on the phone ` +
          `and no screen can show it: ${cost}`,
      );
    }
  }

  assert.deepEqual(faults, [], `\n  ${faults.join("\n  ")}`);
});


/* ---------------------------------------------------------------------------
 * THE TWO STAGE COLUMNS, AND THE ONE WRITER THAT KEPT THEM OUT OF STEP.
 *
 * The handset holds the rung twice: `funnelStage` is the truth about where a
 * lead stands, and `stage` is the six-word legacy column the filter chips
 * select on and the visit cap reads. `legacyStageFor` is the one place they are
 * kept in step — its own header says so — and every writer of that column calls
 * it except one. `upsertLeads` called `localStage`, which knows the six legacy
 * rungs and nothing else, so ALL SEVENTEEN funnel rungs fell through to `New`.
 *
 * The chips filing a lead wrongly is the half that merely looks wrong. The half
 * that bit is the cap: a shop at `first_order`, or one we have been selling to
 * for a year, read as `New`, so the record demanded a Prospect-or-not decision
 * about a customer and REFUSED TO CLOSE THE VISIT until it got one. Invisible
 * in testing because a lead moved on the phone reads correctly and only the
 * same lead after a sync does not.
 * ------------------------------------------------------------------------- */

test("the pull writes the legacy stage column through the one function that keeps it in step", () => {
  const pull = readFileSync(PULL, "utf8");
  const at = pull.indexOf("function upsertLeads(");
  const body = pull.slice(at, pull.indexOf("\n}", at));

  assert.ok(
    /legacyStageFor\(l\.stage,/.test(body),
    "upsertLeads no longer writes `stage` through legacyStageFor. `localStage` " +
      "knows the six legacy rungs only, so every one of the seventeen funnel " +
      "rungs lands as `New` — the chips file them all together, and the visit " +
      "cap demands a Prospect-or-not decision about shops we already sell to " +
      "and blocks the visit until it gets one",
  );
  assert.ok(
    !/\blocalStage\(/.test(body),
    "upsertLeads is calling localStage again somewhere. There is one writer of " +
      "this column per fact and it is legacyStageFor; a second reading of the " +
      "rung is a lead that reads one way on the phone and another after a sync",
  );
  /* The sales type comes off the SAME ROW, because "on the book" is answered
     five rungs differently on the three ladders — a distributor at
     `initial_stock_order` and a direct customer at `first_order` are not the
     same word, and passing null would flatten both. */
  assert.ok(
    /legacyStageFor\(l\.stage, localSalesType\(l\.salesType\)\)/.test(body),
    "upsertLeads is not passing the lead's own sales type to legacyStageFor, so " +
      "every ladder is read as the legacy one and the rungs that only exist on " +
      "the distributor ladder file themselves under the wrong chip",
  );
});
