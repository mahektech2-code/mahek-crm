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
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");

const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

/**
 * WHAT WAS APPLIED, not merely that nothing threw.
 *
 * "migrations applied successfully" is printed just as cheerfully when the
 * migrator applied nothing at all, and applying nothing is a real and silent
 * failure mode here rather than a hypothetical one: drizzle decides what is
 * pending by comparing each journal entry's `when` against the newest
 * `created_at` in `__drizzle_migrations`, so a single row carrying a
 * timestamp above the journal's own values makes every later migration
 * invisible, for ever, with a green deploy on top of it.
 *
 * That is not theoretical. A development database in this repo sits with 77 of
 * 97 entries applied and a watermark above all twenty of the rest; nothing
 * about it looks wrong until a query hits a column that was never added.
 *
 * So the counts are read either side and the difference is named. It costs two
 * `count(*)`s on a table with a hundred rows.
 */
const journal = JSON.parse(readFileSync("./drizzle/meta/_journal.json", "utf8"));
const expected = journal.entries.length;

async function appliedCount() {
  const [row] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
  return row?.n ?? 0;
}

try {
  /* The table may not exist on a database that has never been migrated, and
     that is the ordinary first deploy rather than a fault. */
  let before = 0;
  try {
    before = await appliedCount();
  } catch {
    before = 0;
  }

  await migrate(db, { migrationsFolder: "./drizzle" });

  const after = await appliedCount();
  const ran = after - before;
  console.log(
    ran === 0
      ? `migrations applied successfully — nothing was pending (${after} of ${expected} in the journal)`
      : `migrations applied successfully — ${ran} applied, now ${after} of ${expected} in the journal`,
  );

  /*
   * The journal is the source of truth for what SHOULD exist. Fewer rows than
   * entries means some were skipped rather than run, and the deploy must say
   * so rather than let a missing column be discovered by a user.
   *
   * It WARNS rather than fails: a database legitimately ahead of an older
   * branch, or one repaired by hand, would otherwise block a deploy that has
   * nothing wrong with it. What matters is that it stops being invisible.
   */
  if (after < expected) {
    console.error(
      `::warning::${expected - after} migration(s) in the journal have never been applied to this database. ` +
        `That is the watermark trap: drizzle compares each entry's \`when\` against the newest ` +
        `\`created_at\` in __drizzle_migrations, so entries older than that row are skipped in silence. ` +
        `Check for a column or table a later migration should have added before trusting this deploy.`,
    );
  }
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
