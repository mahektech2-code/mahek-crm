import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';
import { alreadyApplied, runMigrations, type MigrationDb } from './migrate';

/**
 * The migration loop against REAL SQLite, because the bug it fixes lived in
 * how SQLite answers a half-applied schema — a white screen on a handset that
 * re-ran `ALTER TABLE sync_queue ADD COLUMN location` on every launch.
 */

function open() {
  const sqlite = new DatabaseSync(':memory:');
  const db: MigrationDb = {
    exec: async (sql) => {
      sqlite.exec(sql);
    },
    userVersion: async () => (sqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
  };
  const columns = (table: string) =>
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  return { sqlite, db, columns };
}

test('a fresh install runs every block and lands on SCHEMA_VERSION', async () => {
  const { db } = open();
  await runMigrations(db, MIGRATIONS);
  assert.equal(await db.userVersion(), SCHEMA_VERSION);
});

test('a handset stuck by the old loop is recovered rather than failing on the first ALTER', async () => {
  const { db, columns } = open();
  /* What the old loop left behind: every block applied, the version never
     written because a later block threw before the single write at the end. */
  for (const block of MIGRATIONS) for (const stmt of block) await db.exec(stmt);
  await db.exec('PRAGMA user_version = 4');
  assert.ok(columns('sync_queue').includes('location'));

  await runMigrations(db, MIGRATIONS);
  assert.equal(await db.userVersion(), SCHEMA_VERSION);
});

test('a failing block rolls back alone, and the version stops at the block before it', async () => {
  const { db, columns } = open();
  const migrations = [
    ['CREATE TABLE a (id TEXT)'],
    ['ALTER TABLE a ADD COLUMN b TEXT', 'ALTER TABLE nope ADD COLUMN c TEXT'],
  ];

  await assert.rejects(runMigrations(db, migrations), /no such table: nope/);
  assert.equal(await db.userVersion(), 1);
  /* The first statement of the failed block is NOT left behind. */
  assert.deepEqual(columns('a'), ['id']);

  /* Fixed in the next build: it resumes at block 1, not block 0. */
  await runMigrations(db, [migrations[0], ['ALTER TABLE a ADD COLUMN b TEXT']]);
  assert.equal(await db.userVersion(), 2);
  assert.deepEqual(columns('a'), ['id', 'b']);
});

test('only a statement whose effect is present counts as already applied', () => {
  assert.ok(alreadyApplied('ALTER TABLE t ADD COLUMN x TEXT', new Error('duplicate column name: x')));
  assert.ok(alreadyApplied('CREATE INDEX i ON t(x)', new Error('index i already exists')));
  assert.ok(alreadyApplied('CREATE UNIQUE INDEX i ON t(x)', new Error('index i already exists')));
  assert.ok(!alreadyApplied('ALTER TABLE t ADD COLUMN x TEXT', new Error('no such table: t')));
  assert.ok(!alreadyApplied("UPDATE t SET x = 'a'", new Error('duplicate column name: x')));
  assert.ok(!alreadyApplied('DELETE FROM t', new Error('already exists')));
});
