/**
 * SAFE MIGRATION RUNNER — temporary, standalone, not wired into the app.
 *
 * WHY THIS EXISTS: `drizzle-kit migrate` / `drizzle-orm`'s own `migrate()`
 * (see scripts/migrate-deploy.mjs's own header, which independently documents
 * the same fault) decide what is "pending" by comparing each journal entry's
 * `when` against the SINGLE newest `created_at` already in
 * `drizzle.__drizzle_migrations` — not by checking each migration's hash. A
 * database can be missing thirty real migrations and `drizzle-kit` will not
 * notice, because everything below that one watermark row silently reads as
 * "already applied". That mechanism also has no way to skip a migration in
 * the middle of the sequence while continuing to apply the ones after it,
 * which this specific database's history now requires.
 *
 * This script never calls `drizzle-kit migrate` or `drizzle-orm`'s
 * `migrate()`. It reads `drizzle/meta/_journal.json` directly, decides what
 * is pending by checking each migration's own SHA-256 hash against
 * `drizzle.__drizzle_migrations` (real per-row membership, not a watermark),
 * and runs each migration in its own transaction.
 *
 * THREE MIGRATIONS ARE HANDLED SPECIALLY, and the routing for all three is
 * decided in ONE place — `routeMigration()` — by an exact tag match verified
 * against a hash PINNED IN THIS FILE, not by trusting a filename string alone:
 *
 *   0015_clear_demo_data.sql    — MANDATORY SKIP. Deletes real business data
 *                                 (24 DELETE statements). Its SQL is never
 *                                 read into anything this script can execute.
 *   0043_vikram_admin_role.sql  — MANDATORY SKIP. Promotes a specific user to
 *                                 admin — an access decision reserved for a
 *                                 human, not a migration. Same guarantee.
 *   0046_daily_call_list.sql    — SUBSTITUTE. Its real SQL drops and recreates
 *                                 `queue_snapshots`, destroying 29 real
 *                                 historical rows. A reviewed, preservation-
 *                                 safe replacement (hardcoded below, never
 *                                 derived from the file) runs in its place.
 *                                 The tracking row still records the ORIGINAL
 *                                 file's real hash, so drizzle's own tooling
 *                                 keeps seeing a truthful, if annotated,
 *                                 history — this substitution is the one
 *                                 documented, deliberate exception in the
 *                                 whole run.
 *
 * `routeMigration()` returns a closed, discriminated union. A "skip-mandatory"
 * decision carries NO sql field at all — there is no field in that object a
 * caller could read SQL out of even by mistake. A "substitute" decision's
 * `statements` come only from the SUBSTITUTE_SQL constant below; the real
 * file's content is used only to verify its hash and is then discarded. The
 * only way any file's own SQL ever reaches the database is the "execute"
 * branch, which 0015/0043/0046 can never produce.
 *
 * USAGE (this script is never run by anything automatically):
 *   npx tsx --env-file=.env.local scripts/safe-migrate.ts --dry-run
 *   npx tsx --env-file=.env.local scripts/safe-migrate.ts --apply
 *
 * --dry-run makes NO database connection at all — it can only show the
 * static routing plan (execute / skip / substitute), never "already applied",
 * since that requires reading the tracking table.
 * --apply is the only mode that touches the database, and only after every
 * precondition below passes.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Fixed locations. Read-only inputs — this script never writes to any of
// these paths.
// ---------------------------------------------------------------------------
const DRIZZLE_DIR = path.resolve(__dirname, "..", "drizzle");
const JOURNAL_PATH = path.join(DRIZZLE_DIR, "meta", "_journal.json");
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

// ---------------------------------------------------------------------------
// Wrong-database protection. Checked before the URL is even connected with,
// and again against the live connection once open.
// ---------------------------------------------------------------------------
const EXPECTED_DB = { host: "127.0.0.1", port: "5432", database: "mahekone" };

// ---------------------------------------------------------------------------
// Mandatory skips — identified by exact journal tag AND a pinned SHA-256 of
// the real file, computed once during this review and never recomputed from
// "whatever is on disk right now" as the sole check. If the file on disk does
// not hash to this exact value, the runner refuses to guess what changed and
// stops instead (see verifyPinnedFile below).
// ---------------------------------------------------------------------------
const MANDATORY_SKIPS: Record<string, { expectedHash: string; reason: string }> = {
  "0015_clear_demo_data": {
    expectedHash: "f1edaa52e08585a3bce80b6ff3d36ac1ed7db1b902ccdc8df69f0c9a4dfae618",
    reason: "SKIP — destructive migration (deletes real business data across 24 tables)",
  },
  "0043_vikram_admin_role": {
    expectedHash: "5fc425c78c86b61fe400923d6270f3ed35d772e0ac3cd37a8991c20db4230791",
    reason: "SKIP — existing role-changing migration (promotes a user to admin; reserved for a human decision)",
  },
};

// ---------------------------------------------------------------------------
// The ONE substitute. Every statement here is hardcoded, reviewed, and
// unrelated to the original file's text — nothing here is derived from
// reading 0046_daily_call_list.sql. It only ADDS columns/constraints/an index
// and never touches a row. No DELETE, no DROP TABLE, no data-changing
// statement of any kind appears below.
// ---------------------------------------------------------------------------
const SUBSTITUTE_0046_TAG = "0046_daily_call_list";
const SUBSTITUTE_0046_EXPECTED_HASH =
  "bded368d9e7373421e9b2b1bd067d487e7deccaec57a990bea3f232d39a2f2a9";
const SUBSTITUTE_0046_REASON =
  "EXECUTE SAFE REPLACEMENT — original SQL blocked (would DROP/CREATE queue_snapshots and destroy 29 existing rows)";
const SUBSTITUTE_0046_STATEMENTS: readonly string[] = [
  `ALTER TABLE queue_snapshots ADD COLUMN score integer`,
  `ALTER TABLE queue_snapshots ADD COLUMN reasons jsonb`,
  `ALTER TABLE queue_snapshots ADD COLUMN rank integer`,
  `ALTER TABLE queue_snapshots ADD COLUMN generated_at timestamptz`,
  `ALTER TABLE queue_snapshots ALTER COLUMN generated_at SET DEFAULT now()`,
  `ALTER TABLE queue_snapshots ALTER COLUMN user_id SET NOT NULL`,
  `ALTER TABLE queue_snapshots DROP CONSTRAINT queue_snapshots_day_customer_id_pk`,
  `ALTER TABLE queue_snapshots ADD CONSTRAINT queue_snapshots_pkey PRIMARY KEY (day, user_id, customer_id)`,
  `CREATE INDEX IF NOT EXISTS queue_snapshots_user_day_idx ON queue_snapshots (user_id, day)`,
];
// Deliberately absent: any statement touching the user_id/customer_id FOREIGN
// KEY constraints. Not altering them is what leaves the existing
// `ON DELETE SET NULL` behavior on `user_id` exactly as it is today, instead
// of the original migration's `ON DELETE CASCADE`.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  entries: JournalEntry[];
}

type RoutingDecision =
  | { kind: "skip-mandatory"; reason: string }
  | { kind: "substitute"; reason: string; statements: readonly string[] }
  | { kind: "execute"; statements: readonly string[] }
  | { kind: "fatal"; reason: string };

interface PlannedMigration {
  tag: string;
  when: number;
  fileHash: string;
  decision: RoutingDecision;
}

// ---------------------------------------------------------------------------
// Pure helpers — no I/O side effects beyond what is explicitly passed in.
// ---------------------------------------------------------------------------
function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function splitStatements(rawSql: string): string[] {
  return rawSql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readJournal(): Journal {
  if (!existsSync(JOURNAL_PATH)) {
    throw new FatalPreflightError(`Cannot read migration journal at ${JOURNAL_PATH}`);
  }
  let parsed: Journal;
  try {
    parsed = JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
  } catch (e) {
    throw new FatalPreflightError(`Migration journal is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new FatalPreflightError("Migration journal has no entries — migration order cannot be determined.");
  }
  return parsed;
}

function readMigrationFileRaw(tag: string): string {
  const filePath = path.join(DRIZZLE_DIR, `${tag}.sql`);
  if (!existsSync(filePath)) {
    throw new FatalPreflightError(`Mandatory migration file is missing: ${filePath}`);
  }
  return readFileSync(filePath, "utf8");
}

/**
 * Finds exactly one journal entry for a given tag. Zero or more than one is
 * treated as an identification ambiguity — a condition this runner refuses to
 * resolve by guessing.
 */
function findExactlyOneEntry(journal: Journal, tag: string): JournalEntry {
  const matches = journal.entries.filter((e) => e.tag === tag);
  if (matches.length === 0) {
    throw new FatalPreflightError(`Expected migration "${tag}" not found in journal — cannot proceed.`);
  }
  if (matches.length > 1) {
    throw new FatalPreflightError(
      `Migration "${tag}" is AMBIGUOUS — ${matches.length} journal entries share this tag. Refusing to guess.`,
    );
  }
  return matches[0];
}

/**
 * A mandatory-skip or substitute tag is only ever treated as such if the
 * REAL file on disk hashes to the exact value pinned in this script. If it
 * does not — the file changed since this review, or the tag was reused for
 * something else — this is an identification ambiguity and the runner stops
 * rather than silently skip (or substitute for) the wrong migration.
 */
function verifyPinnedFile(tag: string, expectedHash: string, actualHash: string): void {
  if (actualHash !== expectedHash) {
    throw new FatalPreflightError(
      `Refusing to proceed: "${tag}.sql" does not match the hash this runner was reviewed against.\n` +
        `  expected: ${expectedHash}\n` +
        `  actual:   ${actualHash}\n` +
        `This could mean the file changed since this runner was written. Identification is ambiguous — stopping.`,
    );
  }
}

class FatalPreflightError extends Error {}

/**
 * THE ONE place that decides what happens to a migration. Notice the return
 * type: "skip-mandatory" carries no SQL field of any kind — there is nothing
 * in that object to execute even by accident. "substitute" carries only the
 * hardcoded SUBSTITUTE_0046_STATEMENTS constant, never anything derived from
 * `rawFileContent`. Only "execute" ever carries statements taken from the
 * file itself, and 0015/0043/0046 can never reach that branch.
 */
function routeMigration(tag: string, fileHash: string, rawFileContent: string): RoutingDecision {
  const mandatorySkip = MANDATORY_SKIPS[tag];
  if (mandatorySkip) {
    verifyPinnedFile(tag, mandatorySkip.expectedHash, fileHash);
    return { kind: "skip-mandatory", reason: mandatorySkip.reason };
  }

  if (tag === SUBSTITUTE_0046_TAG) {
    verifyPinnedFile(tag, SUBSTITUTE_0046_EXPECTED_HASH, fileHash);
    return { kind: "substitute", reason: SUBSTITUTE_0046_REASON, statements: SUBSTITUTE_0046_STATEMENTS };
  }

  // Every other migration: execute its real, unmodified file content,
  // split only on drizzle's own statement-breakpoint marker.
  return { kind: "execute", statements: splitStatements(rawFileContent) };
}

/**
 * Builds the full, ordered plan from the journal — the one source of truth
 * both --dry-run and --apply read from, so they can never disagree about what
 * SHOULD happen to a given migration (only whether it turns out to already be
 * applied, which --apply alone can know).
 */
function buildPlan(journal: Journal): PlannedMigration[] {
  return journal.entries.map((entry) => {
    const rawFileContent = readMigrationFileRaw(entry.tag);
    const fileHash = sha256Hex(rawFileContent);
    const decision = routeMigration(entry.tag, fileHash, rawFileContent);
    return { tag: entry.tag, when: entry.when, fileHash, decision };
  });
}

// ---------------------------------------------------------------------------
// Preflight — no database required. Run before ANYTHING else, in both modes.
// ---------------------------------------------------------------------------
function preflightFilesystem(): { journal: Journal; plan: PlannedMigration[] } {
  if (!existsSync(DRIZZLE_DIR) || readdirSync(DRIZZLE_DIR).length === 0) {
    throw new FatalPreflightError(`Migration directory cannot be read or is empty: ${DRIZZLE_DIR}`);
  }
  const journal = readJournal();

  // Ambiguity check for all three specially-handled tags, independent of
  // whatever routeMigration() will later decide for them.
  findExactlyOneEntry(journal, "0015_clear_demo_data");
  findExactlyOneEntry(journal, "0043_vikram_admin_role");
  findExactlyOneEntry(journal, SUBSTITUTE_0046_TAG);

  const plan = buildPlan(journal);
  return { journal, plan };
}

// ---------------------------------------------------------------------------
// Preflight — database identity + tracking table + 0046's expected old shape.
// Only ever called from --apply.
// ---------------------------------------------------------------------------
async function preflightDatabase(sql: postgres.Sql): Promise<void> {
  const row = await sql<{ db: string; host: string | null; port: number | null }[]>`
    select
      current_database() as db,
      host(inet_server_addr()) as host,
      inet_server_port() as port
  `;
  const identity = row[0];
  if (!identity || identity.db !== EXPECTED_DB.database) {
    throw new FatalPreflightError(
      `Database identity mismatch: connected to "${identity?.db}", expected "${EXPECTED_DB.database}". Stopping — will not guess or switch databases.`,
    );
  }
  if (identity.host && identity.host !== EXPECTED_DB.host) {
    throw new FatalPreflightError(
      `Database host mismatch: connected via "${identity.host}", expected "${EXPECTED_DB.host}". Stopping.`,
    );
  }
  if (identity.port && String(identity.port) !== EXPECTED_DB.port) {
    throw new FatalPreflightError(
      `Database port mismatch: connected via "${identity.port}", expected "${EXPECTED_DB.port}". Stopping.`,
    );
  }

  const trackingTable = await sql<{ exists: boolean }[]>`
    select exists (
      select 1 from information_schema.tables
       where table_schema = ${MIGRATIONS_SCHEMA} and table_name = ${MIGRATIONS_TABLE}
    ) as exists
  `;
  if (!trackingTable[0]?.exists) {
    throw new FatalPreflightError(
      `Migration tracking table ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} is missing. Refusing to guess how to proceed.`,
    );
  }
}

/**
 * 0046's expected PRE-substitution shape: the OLD two-column primary key must
 * still exist. Checked ONLY immediately before actually attempting the 0046
 * substitute — never as a blanket precondition on every invocation — because
 * on a SECOND run made after 0046 has already succeeded, the primary key will
 * correctly already be the new one, and 0046's hash will already be in the
 * tracking table so this function is never even called. Reaching here with
 * an unexpected shape means something outside this runner's model has
 * happened, so it stops rather than guesses.
 */
async function verify0046PreConditionOrStop(sql: postgres.Sql): Promise<void> {
  let pkRows: { conname: string }[];
  try {
    pkRows = await sql<{ conname: string }[]>`
      select conname from pg_constraint
       where conrelid = 'public.queue_snapshots'::regclass and contype = 'p'
    `;
  } catch (e) {
    throw new FatalPreflightError(
      `Could not inspect queue_snapshots (does the table exist?): ${(e as Error).message}`,
    );
  }
  const pkName = pkRows[0]?.conname;
  if (pkRows.length !== 1 || pkName !== "queue_snapshots_day_customer_id_pk") {
    throw new FatalPreflightError(
      `queue_snapshots does not have the expected pre-0046 primary key (found: ${pkName ?? "none"}). ` +
        `Refusing to guess — the 0046 substitute was reviewed against a specific expected starting shape.`,
    );
  }
}

// ---------------------------------------------------------------------------
// --dry-run: pure, no database connection of any kind.
// ---------------------------------------------------------------------------
function runDryRun(): void {
  console.log("SAFE MIGRATION RUNNER — DRY RUN (no database connection, no writes)\n");
  const { plan } = preflightFilesystem();

  for (const item of plan) {
    switch (item.decision.kind) {
      case "skip-mandatory":
        console.log(`${item.tag} -> SKIP — ${item.decision.reason}`);
        break;
      case "substitute":
        console.log(`${item.tag} -> ${item.decision.reason}`);
        break;
      case "execute":
        console.log(`${item.tag} -> EXECUTE`);
        break;
      case "fatal":
        console.log(`${item.tag} -> FATAL — ${item.decision.reason}`);
        break;
    }
  }

  console.log(
    "\nNote: this is the STATIC plan only. Whether a migration is already applied can only be known by " +
      "querying the tracking table, which --dry-run deliberately never connects to. --apply re-checks every " +
      "migration's real hash against drizzle.__drizzle_migrations before deciding to run it.",
  );
}

// ---------------------------------------------------------------------------
// --apply: the only mode that touches the database.
// ---------------------------------------------------------------------------
async function runApply(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new FatalPreflightError("DATABASE_URL is not set.");

  console.log("SAFE MIGRATION RUNNER — APPLY MODE\n");
  const { plan } = preflightFilesystem();

  const sql = postgres(url, { max: 1 });
  try {
    await preflightDatabase(sql);
    console.log(`Preflight passed. Connected to ${EXPECTED_DB.database}@${EXPECTED_DB.host}:${EXPECTED_DB.port}.\n`);

    const appliedRows = await sql<{ hash: string }[]>`
      select hash from ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)}
    `;
    const appliedHashes = new Set(appliedRows.map((r) => r.hash));

    for (const item of plan) {
      if (appliedHashes.has(item.fileHash)) {
        console.log(`${item.tag} -> already applied (hash present) — skipping`);
        continue;
      }

      if (item.decision.kind === "skip-mandatory") {
        console.log(`${item.tag} -> SKIP — ${item.decision.reason}`);
        continue;
      }

      if (item.decision.kind === "fatal") {
        console.error(`${item.tag} -> FATAL — ${item.decision.reason}`);
        process.exitCode = 1;
        return;
      }

      const label = item.decision.kind === "substitute" ? item.decision.reason : "EXECUTE";
      console.log(`${item.tag} -> ${label}`);

      if (item.decision.kind === "substitute") {
        await verify0046PreConditionOrStop(sql);
      }

      try {
        await sql.begin(async (tx) => {
          for (const statement of item.decision.kind === "execute" || item.decision.kind === "substitute"
            ? item.decision.statements
            : []) {
            await tx.unsafe(statement);
          }
          await tx`
            insert into ${tx(MIGRATIONS_SCHEMA)}.${tx(MIGRATIONS_TABLE)} (hash, created_at)
            values (${item.fileHash}, ${item.when})
          `;
        });
        console.log(`  committed.`);
      } catch (e) {
        console.error(`\nMIGRATION FAILED: ${item.tag}`);
        const real = (e as { cause?: unknown })?.cause ?? e;
        for (const key of [
          "message",
          "code",
          "detail",
          "hint",
          "position",
          "schema_name",
          "table_name",
          "column_name",
          "constraint_name",
          "where",
        ]) {
          const value = (real as Record<string, unknown>)?.[key];
          if (value !== undefined) console.error(`  ${key}:`, value);
        }
        console.error((e as Error)?.stack ?? e);
        console.error(
          "\nTransaction rolled back. No tracking row was written for this migration. Stopping — " +
            "nothing after this migration was attempted. Re-run --apply after investigating; already-applied " +
            "migrations (by hash) will be skipped automatically.",
        );
        process.exitCode = 1;
        return;
      }
    }

    console.log("\nAll migrations processed without a fatal error.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// Entry point. No flag => print usage and do nothing. This file performs no
// action whatsoever merely by being imported or created.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isApply = args.includes("--apply");

  if (isDryRun === isApply) {
    console.log(
      "Usage:\n" +
        "  npx tsx --env-file=.env.local scripts/safe-migrate.ts --dry-run   (no database connection, shows the plan)\n" +
        "  npx tsx --env-file=.env.local scripts/safe-migrate.ts --apply     (connects and applies pending migrations)\n\n" +
        "Exactly one of --dry-run or --apply is required. No action was taken.",
    );
    process.exitCode = isDryRun && isApply ? 1 : 0;
    return;
  }

  try {
    if (isDryRun) {
      runDryRun();
    } else {
      await runApply();
    }
  } catch (e) {
    if (e instanceof FatalPreflightError) {
      console.error(`PREFLIGHT FAILED: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

main();
