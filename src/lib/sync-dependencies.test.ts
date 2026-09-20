import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/* ---------------------------------------------------------------------------
 * A DEPENDENCY IS LOOKED UP BY THE PREFIX OF ITS ID, and a prefix the
 * dispatcher has never heard of is a permanent rejection of real work.
 *
 * Every id the handset mints is `mbos_<prefix>_<uuid>`, and when one item
 * names another as a dependency the server has only that string to go on:
 * `entityOfClientId` reads the prefix off it and `DEPENDENCY_TABLES` says
 * which table to look in. A prefix with no entry is not answered "wait" — it
 * is answered `blocked`, "not a kind of record MahekOne holds", which the
 * handset files under rejections and never sends again.
 *
 * The travel module shipped that way. A leg opened from a visit depends on its
 * expense day, and neither `expday` nor `leg` was in the map — so the first
 * leg of the first field day on that build was refused three minutes after
 * the day it depended on had been accepted. It hid because a day and its leg
 * usually arrive in ONE batch, where the "accepted earlier in this batch"
 * shortcut answers before the map is asked; only a check-in that synced its
 * day ahead of the journey reached the lookup, which is the ordinary order of
 * a morning rather than the exception.
 *
 * Nothing else can see this. The map is a literal in a `server-only` file, the
 * prefixes are string arguments scattered across a project `tsconfig.json`
 * excludes, and the two meet only inside the dispatcher on a real payload. So
 * this test reads both as text and asserts the one thing that matters: every
 * prefix the handset can mint either has a table to be looked up in, or is
 * named below with the reason nothing will ever depend on it.
 * ------------------------------------------------------------------------- */

const DISPATCHER = "src/lib/actions/mbos.ts";
const SERVER_SCHEMA = "src/db/schema.ts";
const HANDSET_SRC = "mbos-app/src";

/**
 * Prefixes the handset mints for rows that nothing is ever queued AGAINST.
 * Each carries its reason, because the alternative is not "no allowlist" — it
 * is the list this map already had, held nowhere and known to nobody. An entry
 * here that turns up in `DEPENDENCY_TABLES`, or stops being minted at all, is
 * a stale reason and fails below.
 */
const NEVER_A_DEPENDENCY: Record<string, string> = {
  competitor: "a sighting is filed against a visit or a lead; nothing is filed against it",
  samplefb: "trial feedback rides inside the sample's own record on the wire",
  expsubmit: "a submission is the last word about a day; nothing follows it",
  media: "a photograph is bound to its parent by name, through a queue of its own",
  tl: "the handset's own timeline rows never go up",
  le: "lead events are a local log, written beside the outbox and never sent",
  q: "the outbox item itself",
  notif: "notifications come down and never go up",
  line: "an order line rides inside its order",
  lcm: "a lead communication is sent, and nothing is ever sent against it",
};

function handsetFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return handsetFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** Every `newId('x')` and `stamp('x')` in the handset's own source. */
function mintedPrefixes(): Set<string> {
  const found = new Set<string>();
  for (const file of handsetFiles(HANDSET_SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\b(?:newId|stamp)\('([a-z_]+)'\)/g)) found.add(m[1]);
  }
  return found;
}

/** prefix -> table, read off the dispatcher's own literal. */
function dependencyTables(): Map<string, string> {
  const src = readFileSync(DISPATCHER, "utf8");
  const block = src.match(/const DEPENDENCY_TABLES[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, "DEPENDENCY_TABLES is gone from actions/mbos.ts — this test needs updating with it");
  /* The quoted half only, so a comment mentioning a table cannot read as an
     entry. */
  return new Map([...block[1].matchAll(/^\s*(\w+):\s*"(\w+)"/gm)].map((m) => [m[1], m[2]]));
}

test("every prefix the handset mints is either looked up somewhere or named as never a dependency", () => {
  const minted = mintedPrefixes();
  const tables = dependencyTables();
  assert.ok(minted.size > 15, `only ${minted.size} prefixes found — the search shape changed`);
  assert.ok(tables.size > 10, `only ${tables.size} dependency tables parsed — the map's shape changed`);

  const faults: string[] = [];
  for (const prefix of [...minted].sort()) {
    const mapped = tables.has(prefix);
    const excused = prefix in NEVER_A_DEPENDENCY;
    if (!mapped && !excused) {
      faults.push(
        `mbos_${prefix}_… has no entry in DEPENDENCY_TABLES and no reason in NEVER_A_DEPENDENCY`,
      );
    }
    if (mapped && excused) {
      faults.push(`${prefix} is in DEPENDENCY_TABLES, so its NEVER_A_DEPENDENCY reason is stale`);
    }
  }
  for (const prefix of Object.keys(NEVER_A_DEPENDENCY)) {
    if (!minted.has(prefix)) {
      faults.push(`${prefix} is excused but the handset no longer mints it — drop the reason`);
    }
  }

  assert.deepEqual(
    faults,
    [],
    "A dependency on a prefix the map does not know is rejected for good, not retried:\n  " +
      faults.join("\n  "),
  );
});

test("every key in the map is a prefix the handset actually mints", () => {
  /* The map was keyed `attendance` for as long as it existed, and the handset
     has only ever stamped `att` — an entry that could never match, which cost
     nothing until an approval named a day as its subject. */
  const minted = mintedPrefixes();
  const dead = [...dependencyTables().keys()].filter((k) => !minted.has(k));
  assert.deepEqual(
    dead,
    [],
    "These keys match no id the handset can send, so they look up nothing:\n  " + dead.join("\n  "),
  );
});

test("every table the map names exists in the server schema", () => {
  const schema = readFileSync(SERVER_SCHEMA, "utf8");
  const missing = [...new Set(dependencyTables().values())].filter(
    (table) => !schema.includes(`pgTable(\n  "${table}"`) && !schema.includes(`pgTable("${table}"`),
  );
  assert.deepEqual(
    missing,
    [],
    "A lookup against a table that does not exist throws inside the push loop:\n  " +
      missing.join("\n  "),
  );
});

test("the prefix is read off a client id the way the handset spells one", () => {
  const src = readFileSync(DISPATCHER, "utf8");
  const fn = src.match(/function entityOfClientId[\s\S]*?const match = (\/.*?\/)\.exec\(id\)/);
  assert.ok(fn, "entityOfClientId no longer reads its prefix with a regex literal");
  const re = new RegExp(fn[1].slice(1, -1));
  const prefixOf = (id: string) => re.exec(id)?.[1] ?? null;

  /* A uuid whose first group is all letters is the one that tempts a greedy
     `[a-z_]+` to swallow past the prefix — and `lead_validation` is the one
     that proves a prefix may itself carry an underscore. */
  assert.equal(prefixOf("mbos_expday_650f3992-6835-4900-8369-3bb8912f905c"), "expday");
  assert.equal(prefixOf("mbos_att_abcdefab-cdef-4abc-8def-abcdefabcdef"), "att");
  assert.equal(prefixOf("mbos_lead_validation_abcdefab-cdef-4abc-8def-abcdefabcdef"), "lead_validation");
  /* An office id is not a client id, and the dispatcher must not guess. */
  assert.equal(prefixOf("cus_6e404e12-3cb"), null);
});
