import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';
import { createSerialiser } from './serialise';

/**
 * One connection, opened once, migrated on open.
 *
 * `user_version` is what makes a handset that skipped two releases arrive at
 * the same schema as one that took every release in turn — the migrations run
 * from wherever it actually is, not from wherever we assume it is.
 */

let db: SQLite.SQLiteDatabase | null = null;

export async function openDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  const handle = await SQLite.openDatabaseAsync('mbos.db');
  await migrate(handle);
  db = handle;
  return handle;
}

/** For tests and for sign-out, which throws the whole store away. */
export function resetHandle() {
  db = null;
}

async function migrate(handle: SQLite.SQLiteDatabase) {
  const row = await handle.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;

  for (let v = current; v < MIGRATIONS.length; v++) {
    for (const stmt of MIGRATIONS[v]) {
      await handle.execAsync(stmt);
    }
  }
  /* PRAGMA will not take a bound parameter. The value is a module constant,
     never user input, so the interpolation is safe here and nowhere else. */
  await handle.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/* ------------------------------------------------------------ identifiers */

/**
 * A client-generated identifier, minted on the device before anything reaches
 * a server.
 *
 * This is the identity, not a placeholder the server later replaces. It is
 * what lets an offline visit own an offline order that owns an offline
 * payment, with all three referring to each other correctly while none of them
 * exists anywhere but this handset.
 */
export function newId(entity: string): string {
  return `mbos_${entity}_${Crypto.randomUUID()}`;
}

/**
 * A hash of the payload, used in the idempotency key.
 *
 * The key is `<entityId>:<op>:<payloadHash>`, which makes replaying a request
 * whose response we never saw safe — and on a 2G connection in a market that
 * is most of them.
 */
export async function payloadHash(payload: unknown): Promise<string> {
  const json = JSON.stringify(payload);
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, json);
}

/* ------------------------------------------------------------ conveniences */

export async function all<T>(sql: string, params: SQLite.SQLiteBindValue[] = []): Promise<T[]> {
  const handle = await openDb();
  return handle.getAllAsync<T>(sql, params);
}

export async function one<T>(sql: string, params: SQLite.SQLiteBindValue[] = []): Promise<T | null> {
  const handle = await openDb();
  return handle.getFirstAsync<T>(sql, params);
}

export async function run(sql: string, params: SQLite.SQLiteBindValue[] = []): Promise<void> {
  const handle = await openDb();
  await handle.runAsync(sql, params);
}

/**
 * A transaction, and only ever one at a time.
 *
 * Saving a visit is one of these and it matters: the visit, its order, its
 * payment, its reminder, its timeline event and its queue items either all
 * land or none do. A half-saved visit is how field data goes wrong in a way
 * nobody can reconstruct afterwards.
 *
 * The serialising is not optional. There is a single SQLite connection and no
 * nested transactions, so two async flows opening one on the same handle throw
 * `cannot start a transaction within a transaction` — and then `cannot
 * rollback - no transaction is active` as the loser unwinds, which reads like
 * an unrelated second bug and is really the wreckage of the first. Signing in
 * causes exactly that: the pull opens one while the background sync, started a
 * moment earlier, opens its own. See `serialise.test.ts`.
 */
const serialiser = createSerialiser();

export async function tx<T>(fn: (h: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  const handle = await openDb();
  /* `withTransactionAsync` resolves to void, so the result is carried out in a
     closure rather than through the return — losing it silently is exactly the
     kind of bug a cast would have hidden. */
  return serialiser.run(
    () => fn(handle),
    (body) => handle.withTransactionAsync(body),
  );
}

/** Small key/value store for cursors, the device id and the session. */
export async function getKv(key: string): Promise<string | null> {
  const row = await one<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setKv(key: string, value: string): Promise<void> {
  await run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}
