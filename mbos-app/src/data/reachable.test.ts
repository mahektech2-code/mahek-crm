import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Can a salesman actually GET to what we built?
 *
 * This is the one class of defect in this app that nothing else can see. An
 * exported function with no caller is perfectly legal TypeScript and perfectly
 * clean lint — it is exported, so no unused-symbol rule fires, and `tsc` has
 * no opinion about whether anybody imports it. So a feature can be finished in
 * `src/data/`, be given a server handler, be given a wire payload, pass every
 * test in the suite, and simply have no screen. Nothing goes red. Nothing
 * looks wrong. The work is done and the salesman cannot reach it.
 *
 * That is not hypothetical. `markDeposited` and `markBounced` were complete on
 * both ends for months — validated by the server, recording who banked it,
 * notifying on a bounce — with no button anywhere in the app, so cash in hand
 * could only ever grow and a bounced cheque could not be reported at all.
 * `listTours` meant a salesman asked to work away for a week and the manager's
 * answer arrived on his phone, was stored, and was never shown to him.
 * `validationsFor`, `listOrders`, `orderLines`, `listPayments`, `touchLead`
 * and `daysAwaitingAnswer` were all the same shape.
 *
 * WHAT THIS DOES NOT COVER, so nobody reads a green run as more than it is:
 * it proves a function is NAMED somewhere outside its own definition, not that
 * the naming is on a path a person can walk. A function called only by another
 * dead function passes. It is the cheap half of the question, and the cheap
 * half is what was missing.
 *
 * `src/data/` was the only folder swept at first — the seam where a feature
 * meets a screen. `native/` and `lib/` were added once leaving them out turned
 * out to cost something; see `EXPORT_DIRS`. Engines are still left out: they
 * are pure and exercised by their own tests.
 */

const ROOT = join(import.meta.dirname, '..');

/**
 * Deliberately not reached yet, and why.
 *
 * A name goes in here only with a reason somebody can disagree with. That is
 * the entire point: the alternative is not "no allowlist", it is what this
 * app had before, which is the same list held nowhere and known to nobody.
 * Wiring one of these up means deleting its line.
 */
const PARKED: Record<string, string> = {
  holidaysOn:
    'The office publishes the holiday calendar and the handset stores it, but no ' +
    'screen shows it — the leave form does not say which days are already holidays. ' +
    '`isHoliday` beside it IS used, to decide whether a day counts as worked.',
  getAllConfig:
    'A diagnostic dump of the whole pulled configuration. The Sync screen shows ' +
    'counts and timings rather than values; this is for whoever debugs a handset ' +
    'that is behaving as though it received something else.',
  configAge:
    'How stale the pulled configuration is. Worth a line on the Sync screen the ' +
    'day somebody is caught out by a setting that changed in the office an hour ago.',
  followUpCounts:
    'Replaced on Home by followUpsOwed in data/customers.ts, which counts by shop, ' +
    'keeps missed follow-ups and matches the Customers filter the tile opens. Left ' +
    'for the owner of data/visits.ts to delete.',
  listCustomers:
    'Superseded by the paged reads the Customers tab uses — the whole book at once ' +
    'is what froze that screen on a handset holding 1,076 shops. Kept because a ' +
    'full read is still the right shape for an export, which does not exist yet.',
  customersWithoutGps:
    'Shops with no coordinate, which route optimisation and visit validation both ' +
    'need. Its own docstring says no screen calls it yet and caps the read for when ' +
    'one does: 487 of 1,076 shops on a real handset have no pin, so capturing them ' +
    'is a field task somebody should be given a list for.',
  samplesFor:
    "The funnel module's per-customer read. The customer record's Samples tab still " +
    'reads `customerSamples` from `data/requests.ts` over the same table; one of ' +
    'the two should go, and picking which is a decision about that screen.',
  productLines:
    'The handset copy of the office rule for which order lines are product rows. ' +
    'No screen calls it yet, but `product-lines-mirror.test.ts` holds it to the ' +
    'office copy line for line, so deleting it would delete that guard too.',
  wireStage:
    'The legacy-stage word the lead card once wrote back. Its only caller, ' +
    '`setStage`, went with the dead lead code; it stays, with its tests, until ' +
    'the legacy-stage reader is retired alongside `localStage` below.',
  localStage:
    'Maps a funnel rung onto the six legacy stages. Nothing writes through it any ' +
    'more — the pull and the visit save both carry the funnel stage — but the ' +
    'legacy-stage reader on the lead card still needs retiring before this can go.',
  recentVisits:
    "This shop's last twenty visits. The customer record shows the shared timeline " +
    'instead, which carries the CRM\'s calls beside the salesman\'s visits — a ' +
    'strictly better answer, and the reason nothing reaches for this one.',
};

/* ------------------------------------------------------------ the sources */

/** Comments carry prose, and prose names functions it does not call. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules') sourceFiles(path, out);
    } else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Where an exported function has to be reached FROM somewhere else.
 *
 * `src/data/` was the only one, on the reasoning above. `native/` and `lib/`
 * joined it after the cost of leaving them out turned up: `releaseService`
 * ("Sign-out: stop, and stop waking up as well") and `clearPushToken`
 * ("Called on sign-out") were both finished, both documented as wired, and
 * neither had a caller — so signing out left the phone tracking and receiving
 * that salesman's pushes. A native wrapper with no caller is a capability the
 * app believes it has. The allowlist that came with widening is the price,
 * and every entry in it carries its reason.
 */
const EXPORT_DIRS = ['data', 'native', 'lib'];

/* Everything that can call something: every source file in `src/` and `app/`. */
const FILES = [...sourceFiles(ROOT), ...sourceFiles(join(ROOT, '..', 'app'))];

const BODIES = new Map(FILES.map((f) => [f, stripComments(readFileSync(f, 'utf8'))]));

/** Every `export function` in the swept folders, as file -> names. */
function dataExports(): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const file of EXPORT_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)))) {
    const raw = readFileSync(file, 'utf8');
    for (const m of raw.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)) {
      out.push({ file, name: m[1] });
    }
  }
  return out;
}

/**
 * Mentions of `name` anywhere in the tree that are not its own definition.
 *
 * A name inside QUOTES is not one of them. TypeScript has no way to call a
 * function by writing its name as a string, so a quoted hit is always some
 * other vocabulary that happens to share a word — `phone-setup.tsx` carries an
 * action called `'acknowledge'` and `data/notifications.ts` exports a function
 * called `acknowledge`, and nothing whatever connects the two. Counted as a
 * caller it would take a genuinely unreachable function off the allowlist,
 * which is the one direction this sweep must not fail in: the allowlist is
 * where somebody reads the reason, and a name silently leaving it is a feature
 * quietly declared reachable by a coincidence of spelling.
 */
function callers(name: string, definedIn: string): number {
  let hits = 0;
  const word = new RegExp(`\\b${name}\\b`, 'g');
  for (const [file, body] of BODIES) {
    for (const m of body.matchAll(word)) {
      const before = body.slice(Math.max(0, m.index - 40), m.index);
      if (file === definedIn && /export\s+(async\s+)?function\s*$/.test(before)) continue;

      const quote = body[m.index - 1];
      const after = body[m.index + name.length];
      if ((quote === "'" || quote === '"' || quote === '`') && after === quote) continue;

      hits++;
    }
  }
  return hits;
}

/* ------------------------------------------------------------- the checks */

test('every function in src/data is reached by something', () => {
  const unreachable: string[] = [];

  for (const { file, name } of dataExports()) {
    if (PARKED[name]) continue;
    if (callers(name, file) === 0) {
      unreachable.push(`${file.replace(ROOT, 'src')} :: ${name}`);
    }
  }

  assert.deepEqual(
    unreachable,
    [],
    'These are finished and no screen can reach them. Wire one up, delete it, or ' +
      'add it to PARKED with a reason:\n' +
      unreachable.map((u) => '  ' + u).join('\n'),
  );
});

test('nothing sits in PARKED after it has been wired up', () => {
  /* The allowlist rots in the direction nobody notices: a name stays on it
     long after somebody built the screen, and the next person reads the reason
     as current. */
  const stale: string[] = [];
  const known = new Map(dataExports().map((e) => [e.name, e.file]));

  for (const name of Object.keys(PARKED)) {
    const file = known.get(name);
    if (!file) {
      stale.push(`${name} — no longer exists in src/data; drop it from PARKED`);
    } else if (callers(name, file) > 0) {
      stale.push(`${name} — something calls it now; drop it from PARKED`);
    }
  }

  assert.deepEqual(stale, [], 'PARKED is out of date:\n' + stale.map((s) => '  ' + s).join('\n'));
});

test('the sweep is not vacuously passing', () => {
  /* A regex that quietly matched nothing would make both tests above green
     while checking nothing at all. This is the guard on the guard. */
  const exports = dataExports();
  assert.ok(exports.length > 80, `expected the whole data layer, found ${exports.length} exports`);
  assert.ok(
    exports.some((e) => e.name === 'markDeposited'),
    'markDeposited should be among the exports — it is the reason this test exists',
  );
  assert.ok(BODIES.size > 40, `expected the whole source tree, found ${BODIES.size} files`);

  /* And it can tell a real caller from a mention in a comment: `collectPayment`
     is called from the pay screen, and a name that appears only in prose is
     not a caller. */
  assert.ok(callers('collectPayment', join(ROOT, 'data', 'payments.ts')) > 0);
  assert.equal(callers('aFunctionNobodyHasEverWritten', 'nowhere'), 0);
});
