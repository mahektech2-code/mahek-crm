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
  /*
   * drizzle-orm wraps the real driver error as `DrizzleQueryError(query,
   * params, cause)` — the fields that actually say WHY (code, detail, the
   * table/column Postgres is complaining about) live on `.cause`, not on the
   * wrapper itself, which is why an earlier version of this script printed
   * only the restated query text and nothing about the reason.
   */
  const real = err?.cause ?? err;
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
    if (real && real[key] !== undefined) console.error(`${key}:`, real[key]);
  }
  console.error(err?.stack ?? err);

  /*
   * "already exists" (42P07 relation, 42701 column, 42710 object) is the one
   * failure shape where the fix depends on facts this script cannot see from
   * the migration file alone — whether the thing sitting there already
   * matches what the migration would have created, or is a stale leftover, or
   * holds real rows. The transaction that failed has already rolled back by
   * the time we get here, but the connection itself is still live, so ask
   * Postgres what is actually there instead of guessing from the SQL text.
   */
  if (real?.code && ["42P07", "42701", "42710"].includes(real.code)) {
    const name = /"([^"]+)"/.exec(real.message)?.[1];
    if (name) {
      console.error(`\n--- diagnostic: what "${name}" actually looks like ---`);
      try {
        const cols = await sql`
          select column_name, data_type, is_nullable, column_default
          from information_schema.columns
          where table_name = ${name}
          order by ordinal_position
        `;
        console.error("columns:", JSON.stringify(cols, null, 2));
        const [{ n }] = await sql`select count(*)::int as n from ${sql(name)}`;
        console.error("row count:", n);
      } catch (diagErr) {
        console.error("diagnostic query itself failed:", diagErr?.message ?? diagErr);
      }
    }
  }

  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
