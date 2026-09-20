import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../db/schema';
import { leadBookQuery, rungCountsQuery } from './lead-query';

/**
 * The lead book's reads, against a REAL SQLite carrying the REAL schema.
 *
 * `schema.ts` is a list of strings with no Expo import anywhere in it, so the
 * migrations this runs are the migrations a handset runs — the same reason
 * `customer-query.test.ts` next door exists, and a stronger one here. Two of
 * these statements cannot be checked by reading them: the view clause carries
 * two `IN` lists whose parameters have to land in the right slots, and the
 * owed expression leans on SQLite's own answer to `min` with a NULL in it,
 * which is NULL for the whole call rather than the smallest of the rest. Get
 * either wrong and nothing throws — the list is simply empty, or sorted by
 * nonsense, on a phone, in a market, with no console attached. AGENTS.md has
 * the longer version of that lesson under `buildPull`.
 */

const TODAY = '2026-09-20';

function handset(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const step of MIGRATIONS) for (const stmt of step) db.exec(stmt);
  return db;
}

type Row = {
  id: string;
  stage?: string;
  funnelStage?: string | null;
  salesType?: string | null;
  archived?: number;
  nextActionDate?: string | null;
  nextFollowUpDate?: string | null;
  holdResumeDate?: string | null;
};

function seed(db: DatabaseSync, rows: Row[]) {
  const ins = db.prepare(
    `INSERT INTO leads (id, name, stage, funnelStage, salesType, archived,
                        nextActionDate, nextFollowUpDate, holdResumeDate,
                        clientCreatedAt, deviceId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'test')`,
  );
  for (const r of rows) {
    ins.run(
      r.id,
      r.id,
      r.stage ?? 'New',
      r.funnelStage ?? null,
      r.salesType ?? null,
      r.archived ?? 0,
      r.nextActionDate ?? null,
      r.nextFollowUpDate ?? null,
      r.holdResumeDate ?? null,
    );
  }
}

function ids(db: DatabaseSync, q: { sql: string; params: string[] }): string[] {
  return (db.prepare(q.sql).all(...q.params) as { id: string }[]).map((r) => r.id);
}

/* ------------------------------------------------------------- the rungs */

test('a chip catches the funnel rung AND the six-word column under it', () => {
  const db = handset();
  seed(db, [
    /* The rung this whole change exists for: `sample_review` could be reached
       from no chip at all, because the old query read `stage`. */
    { id: 'reviewing', funnelStage: 'sample_review', salesType: 'direct', stage: 'Qualified' },
    /* And the old book, which carries no rung. Emptying every chip of it would
       be the worse half of this change by far — the leads are still there, on
       no chip, findable only on All. */
    { id: 'legacy', funnelStage: null, stage: 'Qualified' },
    { id: 'elsewhere', funnelStage: 'negotiation', salesType: 'direct', stage: 'Negotiation' },
  ]);

  assert.deepEqual(ids(db, leadBookQuery({ view: 'qualified', today: TODAY })).sort(), [
    'legacy',
    'reviewing',
  ]);
});

test('All is the archive flag and nothing else, so nothing can hide from it', () => {
  const db = handset();
  seed(db, [
    { id: 'open', funnelStage: 'sample_trial', salesType: 'direct' },
    { id: 'filed', funnelStage: 'negotiation', salesType: 'direct', archived: 1 },
  ]);
  assert.deepEqual(ids(db, leadBookQuery({ view: 'all', today: TODAY })), ['open']);
  assert.deepEqual(ids(db, leadBookQuery({ view: 'archived', today: TODAY })), ['filed']);
});

test('on the book is Converted, not the Negotiation band it sits in', () => {
  const db = handset();
  seed(db, [
    { id: 'second', funnelStage: 'second_order', salesType: 'direct' },
    { id: 'first', funnelStage: 'first_order', salesType: 'direct' },
  ]);
  assert.deepEqual(ids(db, leadBookQuery({ view: 'converted', today: TODAY })), ['second']);
  assert.deepEqual(ids(db, leadBookQuery({ view: 'negotiation', today: TODAY })), ['first']);
});

test('a rung narrows the band it was picked under', () => {
  const db = handset();
  seed(db, [
    { id: 'trial', funnelStage: 'sample_trial', salesType: 'direct' },
    { id: 'review', funnelStage: 'sample_review', salesType: 'direct' },
  ]);
  assert.deepEqual(
    ids(db, leadBookQuery({ view: 'qualified', rung: 'sample_trial', today: TODAY })),
    ['trial'],
  );
});

test('the rung chips count the whole band, never the rung already picked', () => {
  const db = handset();
  seed(db, [
    { id: 'trial-1', funnelStage: 'sample_trial', salesType: 'direct' },
    { id: 'trial-2', funnelStage: 'sample_trial', salesType: 'direct' },
    { id: 'review', funnelStage: 'sample_review', salesType: 'direct' },
    /* A lead with no rung contributes nothing: its rung IS the chip above. */
    { id: 'legacy', funnelStage: null, stage: 'Qualified' },
  ]);
  const q = rungCountsQuery({ view: 'qualified', rung: 'sample_review', today: TODAY })!;
  const counts = (db.prepare(q.sql).all(...q.params) as { rung: string; count: number }[]).map(
    (r) => ({ rung: r.rung, count: r.count }),
  );
  assert.deepEqual(counts, [
    { rung: 'sample_trial', count: 2 },
    { rung: 'sample_review', count: 1 },
  ]);
  /* All and Archived have no band to break down, so they are not asked. */
  assert.equal(rungCountsQuery({ view: 'all', today: TODAY }), null);
});

/* ------------------------------------------------------------ what is owed */

test('overdue is the earliest of the three days, whichever column holds it', () => {
  const db = handset();
  seed(db, [
    /* §24's action alone — every lead anybody has moved up a rung. Keyed on
       the diary, this one was invisible. */
    { id: 'action-late', nextActionDate: '2026-09-14' },
    /* The diary alone — the whole legacy book, which §24 never applied to. */
    { id: 'promise-late', nextFollowUpDate: '2026-09-18' },
    /* A park whose day has gone. Nobody has to record an outcome for a hold
       to still be waiting. */
    { id: 'hold-late', funnelStage: 'on_hold', holdResumeDate: '2026-09-19' },
    /* A resume date on a lead that is no longer parked is a day already
       honoured, and must not go on being owed for ever. */
    { id: 'came-back', funnelStage: 'negotiation', salesType: 'direct', holdResumeDate: '2026-09-01' },
    { id: 'due-today', nextActionDate: TODAY },
    { id: 'this-week', nextFollowUpDate: '2026-09-24' },
    { id: 'later', nextFollowUpDate: '2026-10-30' },
    { id: 'nothing' },
  ]);

  /* Ordered by the day itself, which is also the order the list draws them in. */
  assert.deepEqual(ids(db, leadBookQuery({ when: 'overdue', today: TODAY })), [
    'action-late',
    'promise-late',
    'hold-late',
  ]);
  assert.deepEqual(ids(db, leadBookQuery({ when: 'today', today: TODAY })), ['due-today']);
  assert.deepEqual(ids(db, leadBookQuery({ when: 'week', today: TODAY })), ['this-week']);
  /* "Nothing promised" is nothing in ANY of the three, which is what makes the
     chip mean what it says. `came-back` has a stale resume date and belongs
     here; `later` has a real promise and does not. */
  assert.deepEqual(ids(db, leadBookQuery({ when: 'none', today: TODAY })).sort(), [
    'came-back',
    'nothing',
  ]);
});

test('a lead owing nothing sorts under every lead that owes something', () => {
  const db = handset();
  seed(db, [
    { id: 'no-date' },
    { id: 'far-off', nextFollowUpDate: '2027-01-01' },
    { id: 'soon', nextActionDate: '2026-09-21' },
  ]);
  assert.deepEqual(ids(db, leadBookQuery({ today: TODAY })), ['soon', 'far-off', 'no-date']);
});

test('the earliest day wins even when the other column is empty', () => {
  const db = handset();
  seed(db, [
    /* SQLite's own `min(a, b)` answers NULL if either is — the trap the owed
       expression floors its way around. Without the floor this lead sorts and
       filters as though nothing were owed at all. */
    { id: 'action-only', nextActionDate: '2026-09-21' },
    { id: 'both', nextActionDate: '2026-09-28', nextFollowUpDate: '2026-09-22' },
  ]);
  assert.deepEqual(ids(db, leadBookQuery({ when: 'week', today: TODAY })), ['action-only', 'both']);
});

/* ---------------------------------------------------------------- search */

test('the search runs in SQLite and stacks with both chip rows', () => {
  const db = handset();
  seed(db, [
    { id: 'Patil Hardware', funnelStage: 'negotiation', salesType: 'direct', nextActionDate: '2026-09-10' },
    { id: 'Patil Paints', funnelStage: 'negotiation', salesType: 'direct', nextActionDate: '2026-10-10' },
    { id: 'Shah Traders', funnelStage: 'negotiation', salesType: 'direct', nextActionDate: '2026-09-10' },
  ]);
  assert.deepEqual(
    ids(db, leadBookQuery({ view: 'negotiation', when: 'overdue', today: TODAY }, 'Patil')),
    ['Patil Hardware'],
  );
});
