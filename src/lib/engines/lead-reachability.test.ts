import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Can a PERSON actually get to the lead pipeline's own work?
 *
 * This is the server-side counterpart of `mbos-app/src/data/reachable.test.ts`,
 * written for the same class of defect and after the same thing happened here.
 * An exported server action with no caller is perfectly legal TypeScript and
 * perfectly clean lint — it is exported, so no unused-symbol rule fires, and
 * `tsc` has no opinion about whether anybody imports it. So a feature can be
 * finished in `lib/actions/`, be audited, be notified, be covered by an
 * integration test, and simply have no screen. Nothing goes red. Nothing looks
 * wrong. The work is done and nobody in the building can do it.
 *
 * It is worse than idle code here than it is on the handset, because §28 is a
 * system of GATES. A gate added while the action that satisfies it has no
 * screen does not merely fail to help: it FREEZES the funnel on deploy, with a
 * refusal telling a salesman to do something the app gives him no way to do.
 * That has already shipped once in this module, which is why this file exists
 * rather than a note in a review.
 *
 * THREE QUESTIONS, because the promise can be broken at three different
 * depths:
 *
 *   1. A server action nothing on a screen imports. An action reached only
 *      from another action is NOT reachable by a person — that is a call
 *      between two pieces of server code, and if the outer one has no screen
 *      either then the pair of them are unreachable together. So this one
 *      looks for the name under `src/components/` or `src/app/` and nowhere
 *      else: those two directories are the whole surface a human can touch,
 *      the second including the route handlers a handset posts to.
 *   2. An engine export nothing imports. The engines are pure and are pinned
 *      by their own tests, so an unimported one passes every check in the
 *      suite while deciding nothing about anything.
 *   3. A `lead_` table nothing writes. A migration that shipped a promise: the
 *      column list reads like a feature, the read path may even exist, and no
 *      row will ever arrive in it.
 *
 * WHAT A GREEN RUN DOES NOT MEAN, so nobody reads it as more than it is: this
 * proves a symbol is NAMED somewhere outside its own definition, not that the
 * naming sits on a path somebody can walk. An action imported by a screen that
 * is itself linked from nowhere passes. It is the cheap half of the question,
 * and the cheap half is what was missing.
 */

const SRC = join(import.meta.dirname, "..", "..");

/**
 * Deliberately not reached yet, and why.
 *
 * A name goes in here only with a reason somebody can disagree with. That is
 * the entire point: the alternative to an allowlist is not "no allowlist", it
 * is the silent list this codebase already had — held nowhere, known to
 * nobody, and discovered by a salesman standing in a shop. Wiring one of these
 * up means deleting its line, and the second test below fails if you forget.
 */
const PARKED: Record<string, string> = {
  STANDARD_ROUTE_REASON:
    "Consumed inside its own file, by `managementRouteReason` one function " +
    "below it. It is exported so that whoever reads a stored `routeReason` off " +
    "an appointment row can compare against the constant rather than typing " +
    '"standard" into a screen — which is the drift this module keeps a whole ' +
    "engine to avoid. A constant with one internal caller is not the shape " +
    "this sweep was written for; an ACTION with one internal caller is.",

  /* ---------------------------------------------------------------------
   * THE DISTRIBUTOR APPOINTMENT CHAIN — parked on Mahek's own instruction,
   * and this is the one case where a missing screen is the right answer.
   *
   * Asked directly whether Mahek appoints distributors through MahekOne, the
   * answer was no: it is done outside the system. So the nine-rung ladder was
   * retired for NEW leads (`SALES_TYPES` carries that decision and the single
   * line that reverses it), and the leads already on it get a migration action
   * and a worklist rather than a way to climb further.
   *
   * Building screens for these three would be building doors onto a process
   * the company does not run. That is worse than leaving them unreachable: a
   * button that submits a candidate to a management review nobody performs
   * produces a queue that never empties, which is exactly the dead end the
   * retirement was meant to end.
   *
   * They are kept rather than deleted because the leads already on that ladder
   * still carry rows these functions wrote, and because the decision is a
   * business one that can change. If Mahek ever formalises appointments, these
   * are the three that need doors — and this sweep will say so the moment the
   * entries below are removed.
   * ------------------------------------------------------------------- */
  createDistributorSalesman:
    "Records a distributor's OWN salesman (§23's Rahul — a name on a row, not " +
    "a MahekOne login). It belongs to the appointment flow that is not run " +
    "here. Note this one is the likeliest of the three to need a door before " +
    "the others: a third-party lead names the distributor's salesman who " +
    "services it, and that chain is recorded from the first visit.",

  nurtureKey:
    "USED, and inside its own file — `tasksDueFor` builds every task's " +
    "`sourceId` with it, which is §13's raise-once guarantee working exactly " +
    "as written. It is exported so that anything reading a stored " +
    "`mbos_tasks.source_id` back can rebuild the key rather than retyping the " +
    "colon-separated format, which is the drift this engine exists to avoid. " +
    "Same shape as STANDARD_ROUTE_REASON above: a helper with one internal " +
    "caller is not what this sweep is for.",

  previousStage:
    "The ladder engine's symmetric counterpart to `nextStage`, and genuinely " +
    "called by nothing. Kept rather than deleted because a map that answers " +
    "'what comes next' and cannot answer 'what came before' is a half map, and " +
    "because reverting a lead IS a real path — `advanceLeadStage` writes a " +
    "`reverted` transition behind `lead.override`. That path picks its target " +
    "rung some other way today. WORTH A LOOK rather than a deletion: if a " +
    "revert should mean 'back one rung' rather than 'to whichever rung " +
    "somebody chose', this is the function it should be reading.",
};

/* ------------------------------------------------------------ the sources */

/**
 * Comments carry prose, and this codebase's prose names functions constantly —
 * every paragraph in every header explains itself by pointing at the function
 * next door. Left in, `assignLeadManager` would read as reached because
 * `schema.ts` explains a column by naming it, which is precisely the opposite
 * of a caller.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
    } else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) {
      out.push(path);
    }
  }
  return out;
}

/** Everything a person can touch: the screens, and the routes a handset posts to. */
const SCREENS = new Map(
  [...sourceFiles(join(SRC, "components")), ...sourceFiles(join(SRC, "app"))].map((f) => [
    f,
    stripComments(readFileSync(f, "utf8")),
  ]),
);

/** The whole server tree, for the engine question, which is a narrower one. */
const SERVER = new Map(
  sourceFiles(join(SRC, "lib")).map((f) => [f, stripComments(readFileSync(f, "utf8"))]),
);

const EVERYWHERE = new Map([...SCREENS, ...SERVER]);

/**
 * Mentions of `name` that are not its own definition.
 *
 * A name inside QUOTES is not one of them. TypeScript has no way to call a
 * function by writing its name as a string, so a quoted hit is some other
 * vocabulary that happens to share a word — an audit action, a config key, a
 * column. Counted as a caller it would take a genuinely unreachable function
 * off the list, which is the one direction this sweep must not fail in.
 */
function mentions(name: string, bodies: Map<string, string>, definedIn: string): string[] {
  const hits: string[] = [];
  const word = new RegExp(`\\b${name}\\b`, "g");

  for (const [file, body] of bodies) {
    if (file === definedIn) continue;
    for (const m of body.matchAll(word)) {
      const quote = body[m.index - 1];
      const after = body[m.index + name.length];
      if ((quote === "'" || quote === '"' || quote === "`") && after === quote) continue;
      hits.push(file);
      break;
    }
  }
  return hits;
}

type Exported = { file: string; name: string };

function exportsIn(files: string[]): Exported[] {
  const out: Exported[] = [];
  for (const file of files) {
    const body = stripComments(readFileSync(file, "utf8"));
    for (const m of body.matchAll(/^export (?:async function|function|const) ([A-Za-z0-9_]+)/gm)) {
      out.push({ file, name: m[1] });
    }
  }
  return out;
}

/**
 * The lead pipeline's write surface, enumerated rather than listed.
 *
 * A hard-coded list of nine filenames is a list that goes stale the first time
 * somebody adds a tenth — and the tenth is exactly the one whose screen has
 * not been built yet, because it is the newest. `lead*` and `distributor*`
 * catch every file the module has, and every file it is going to have.
 */
function actionFiles(): string[] {
  const dir = join(SRC, "lib", "actions");
  return readdirSync(dir)
    .filter((f) => /^(lead|distributor).*\.ts$/.test(f) && !f.includes(".test."))
    .map((f) => join(dir, f));
}

function engineFiles(): string[] {
  const dir = join(SRC, "lib", "engines");
  return readdirSync(dir)
    .filter((f) => /^lead-.*\.ts$/.test(f) && !f.includes(".test."))
    .map((f) => join(dir, f));
}

function rel(file: string): string {
  return file.replace(SRC, "src");
}

/* ------------------------------------------------------------- the checks */

test("every lead server action is reachable from a screen", () => {
  const unreachable: string[] = [];

  for (const { file, name } of exportsIn(actionFiles())) {
    if (PARKED[name]) continue;
    if (mentions(name, SCREENS, file).length === 0) {
      unreachable.push(`${rel(file)} :: ${name}`);
    }
  }

  assert.deepEqual(
    unreachable,
    [],
    "These server actions are finished and nothing under src/components or " +
      "src/app imports them, so no person in the building can run one. An " +
      "action reached only from another action does not count — that is two " +
      "pieces of server code talking, not a door. Build the screen, delete the " +
      "action, or add it to PARKED with a reason:\n" +
      unreachable.map((u) => "  " + u).join("\n"),
  );
});

test("every lead engine export is imported by something", () => {
  const unused: string[] = [];

  for (const { file, name } of exportsIn(engineFiles())) {
    if (PARKED[name]) continue;
    if (mentions(name, EVERYWHERE, file).length === 0) {
      unused.push(`${rel(file)} :: ${name}`);
    }
  }

  assert.deepEqual(
    unused,
    [],
    "These engine exports are pure, tested, and imported by nothing — so the " +
      "rule they hold decides nothing about any lead. Their own tests will go " +
      "on passing for ever. Wire one to the screen or service that should be " +
      "asking it, or add it to PARKED with a reason:\n" +
      unused.map((u) => "  " + u).join("\n"),
  );
});

test("every lead_ table is written by something", () => {
  const schema = readFileSync(join(SRC, "db", "schema.ts"), "utf8");
  const unwritten: string[] = [];

  /* The SQL name is what the migration shipped, so that is what is matched;
     the const beside it is what a query actually writes through. */
  for (const m of schema.matchAll(
    /export const ([A-Za-z0-9_]+) = pgTable\(\s*"((?:lead_|mbos_lead_)[a-z_]+)"/g,
  )) {
    const [, constant, table] = m;
    const write = new RegExp(`(insert|update)\\(\\s*${constant}\\b`);
    const writers = [...SERVER].filter(([, body]) => write.test(body));
    if (writers.length === 0) unwritten.push(`${table} (${constant})`);
  }

  assert.deepEqual(
    unwritten,
    [],
    "These tables exist in the schema and nothing under src/lib inserts or " +
      "updates them — a migration that shipped a promise. The read path may " +
      "even be built, and it will return an empty list for ever:\n" +
      unwritten.map((u) => "  " + u).join("\n"),
  );
});

test("nothing sits in PARKED after it has been wired up", () => {
  /* An allowlist rots in the direction nobody notices: a name stays on it long
     after somebody built the screen, and the next reader takes the reason as
     current. A stale exemption is how a guard stops being one. */
  const stale: string[] = [];
  const known = new Map(
    [...exportsIn(actionFiles()), ...exportsIn(engineFiles())].map((e) => [e.name, e.file]),
  );

  for (const name of Object.keys(PARKED)) {
    const file = known.get(name);
    if (!file) {
      stale.push(`${name} — no longer exported by the lead module; drop it from PARKED`);
    } else if (mentions(name, EVERYWHERE, file).length > 0) {
      stale.push(`${name} — something imports it now; drop it from PARKED`);
    }
  }

  assert.deepEqual(stale, [], "PARKED is out of date:\n" + stale.map((s) => "  " + s).join("\n"));
});

test("the sweep is not vacuously passing", () => {
  /* A regex that quietly matched nothing would make every test above green
     while checking nothing at all — which is the same failure the whole file
     is about, one level up. This is the guard on the guard. */
  const actions = exportsIn(actionFiles());
  const engines = exportsIn(engineFiles());

  assert.ok(actionFiles().length >= 8, `expected the lead action files, found ${actionFiles().length}`);
  assert.ok(actions.length > 25, `expected the lead write surface, found ${actions.length} exports`);
  assert.ok(engines.length > 15, `expected the lead engines, found ${engines.length} exports`);
  assert.ok(SCREENS.size > 100, `expected the whole screen tree, found ${SCREENS.size} files`);

  assert.ok(
    actions.some((a) => a.name === "advanceLeadStage"),
    "advanceLeadStage should be among the actions — it is the write §28 gates",
  );

  /* And it can tell a real caller from a mention in prose: `advanceLeadStage`
     is imported by the record screen, and a name that appears only inside a
     comment is not a caller. */
  assert.ok(
    mentions("advanceLeadStage", SCREENS, join(SRC, "lib", "actions", "leads.ts")).length > 0,
  );
  assert.equal(mentions("aFunctionNobodyHasEverWritten", EVERYWHERE, "nowhere").length, 0);
});
