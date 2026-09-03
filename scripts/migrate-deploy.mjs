/**
 * `drizzle-kit migrate`'s CLI wraps every batch in a spinner and, on a
 * failure, prints nothing at all — not the message, not the Postgres code,
 * not even a stack. Two prior incidents were only root-caused by manually
 * diffing the migration journal against `main`, because the CLI itself gave
 * no error text to work from (see AGENTS.md, "CI's spinner UI does not flush
 * error text").
 *
 * This calls the exact same underlying migrator — `PgDialect.migrate`, one
 * transaction over every journal entry newer than the watermark, same as
 * `drizzle-kit migrate` runs — directly, so a real failure prints the
 * Postgres error's code, table, column and constraint instead of dying
 * silently. Nothing about WHICH migrations run or how they are batched
 * changes; only what happens when one of them fails.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");

const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("migrations applied successfully");
} catch (err) {
  console.error("MIGRATION FAILED");
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
    if (err && err[key] !== undefined) console.error(`${key}:`, err[key]);
  }
  console.error(err?.stack ?? err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
