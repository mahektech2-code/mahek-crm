import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OWNED_TABLES, REFERENCE_TABLES } from '../db/schema';

/**
 * A TOMBSTONE MAY ONLY EVER DELETE REFERENCE DATA.
 *
 * `applyDeletions` runs `DELETE FROM ${d.entity}` with a table name that came
 * OFF THE WIRE, guarded by one hand-typed set called `DELETABLE`. The guard is
 * real and is currently correct. What was missing is anything checking it
 * against the two lists that state the rule it exists to keep.
 *
 * `OWNED_TABLES` and `REFERENCE_TABLES` in `db/schema.ts` say which is which —
 * "work the salesman authored, a sync never deletes from these" against
 * "replaced wholesale by a pull". They are prose with no caller: a grep across
 * the whole app finds no importer, so they read as authority and enforce
 * nothing, which is the shape AGENTS.md names about `runHourly` and the one
 * this codebase keeps finding.
 *
 * So the lists become the authority and `DELETABLE` is checked against them.
 * The cost of the rule breaking is not a crash: it is a salesman's visit,
 * order or unsent expense leg deleted by the office naming a table in a
 * tombstone, with the outbox emptied of work nobody can recover and no error
 * anywhere. That is precisely the class of failure a hand-typed set of table
 * names invites, because adding a table to a pull and adding it to the right
 * list are two separate acts by two different people.
 *
 * It reads the set as TEXT rather than importing it, because `pull.ts` imports
 * expo-sqlite at module scope and cannot be loaded under `tsx --test` — the
 * same reason the wire contract is checked this way.
 */

function deletableSet(): string[] {
  const src = readFileSync('src/sync/pull.ts', 'utf8');
  const line = /const DELETABLE = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(line, 'DELETABLE is not where this test expects it in sync/pull.ts');
  return [...line[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

test('every table a tombstone may delete is reference data', () => {
  const owned = new Set<string>(OWNED_TABLES);
  const offenders = deletableSet().filter((t) => owned.has(t));
  assert.deepEqual(
    offenders,
    [],
    'a tombstone naming one of these would delete work the salesman authored, ' +
      'including rows still waiting in the outbox: ' + offenders.join(', '),
  );
});

test('every table a tombstone may delete is named as reference data', () => {
  /* Not merely "not owned". A table in NEITHER list is one nobody has decided
     about, and deciding by omission is how the wrong one gets added. */
  const reference = new Set<string>(REFERENCE_TABLES);
  const unnamed = deletableSet().filter((t) => !reference.has(t));
  assert.deepEqual(
    unnamed,
    [],
    'these are deletable by a tombstone and are in neither list, so nobody has ' +
      'said whether losing one costs the salesman anything: ' + unnamed.join(', '),
  );
});

test('the two lists do not overlap', () => {
  /* A table in both is a table with two answers to "may a pull delete this",
     and the reader who picks the wrong one loses somebody's morning. */
  const owned = new Set<string>(OWNED_TABLES);
  const both = REFERENCE_TABLES.filter((t) => owned.has(t));
  assert.deepEqual(both, [], 'owned and reference at once: ' + both.join(', '));
});

test('it recognises the shape it is looking for', () => {
  /* The guard has to be able to fail. `visits` is the clearest owned table
     there is — a visit is a salesman's own record of work he really did. */
  assert.ok(OWNED_TABLES.includes('visits'), 'visits should be owned');
  assert.ok(!deletableSet().includes('visits'), 'visits must never be deletable');
  assert.ok(deletableSet().length > 0, 'the set was read as empty, so the tests above are vacuous');
});
