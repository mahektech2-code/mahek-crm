/**
 * Running the schema migrations — the loop alone, with no expo import, so it
 * can be tested against real SQLite (`node:sqlite`) rather than reproduced.
 *
 * **A BLOCK IS APPLIED AND RECORDED IN ONE TRANSACTION.** The loop used to run
 * every block with no transaction and write `user_version` once, at the very
 * end. So a block that failed left the blocks before it applied and the
 * version unmoved, and every later launch re-ran them from the top and died on
 * the first one — `duplicate column name: location`, on a white screen, for
 * ever. No later build could get past it, because the failure happened before
 * any screen could draw. Now the version moves block by block, inside the same
 * transaction as the block, so a failure costs that block alone and the next
 * launch resumes exactly where it stopped.
 *
 * **A HANDSET ALREADY STUCK IS RECOVERED, not just a future one protected.**
 * Its database holds statements the old loop applied without recording, so on
 * the way through, a statement whose effect is already present — a column
 * that exists, a table or an index that exists — is treated as done. That is
 * only ever true of a statement that genuinely ran: every one of these
 * migrations is a single statement, and an `ADD COLUMN` or a `CREATE` cannot
 * half-succeed.
 *
 * **A PRAGMA RUNS OUTSIDE THE TRANSACTION.** `journal_mode = WAL` is refused
 * inside one, and `foreign_keys` is silently ignored there. Both are
 * idempotent, so running them again on a resumed block costs nothing.
 */

export type MigrationDb = {
  exec(sql: string): Promise<void>;
  userVersion(): Promise<number>;
};

const PRAGMA = /^\s*PRAGMA\b/i;
const ADD_COLUMN = /\bADD\s+COLUMN\b/i;
const CREATE = /^\s*CREATE\s+(UNIQUE\s+)?(TABLE|INDEX|VIEW|TRIGGER)\b/i;

/** The statement's effect is already in the database, so it counts as run. */
export function alreadyApplied(stmt: string, error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error);
  if (ADD_COLUMN.test(stmt) && /duplicate column name/i.test(message)) return true;
  if (CREATE.test(stmt) && /already exists/i.test(message)) return true;
  return false;
}

export async function runMigrations(db: MigrationDb, migrations: string[][]): Promise<void> {
  const current = await db.userVersion();

  for (let v = current; v < migrations.length; v++) {
    const block = migrations[v];
    for (const stmt of block.filter((s) => PRAGMA.test(s))) await db.exec(stmt);

    await db.exec('BEGIN');
    try {
      for (const stmt of block.filter((s) => !PRAGMA.test(s))) {
        try {
          await db.exec(stmt);
        } catch (e) {
          if (!alreadyApplied(stmt, e)) throw e;
        }
      }
      /* PRAGMA will not take a bound parameter. The value is a loop index,
         never user input, so the interpolation is safe here and nowhere else. */
      await db.exec(`PRAGMA user_version = ${v + 1}`);
      await db.exec('COMMIT');
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => {});
      throw e;
    }
  }
}
