import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * A TABLE MUST ACTUALLY HAVE THE COLUMNS ITS SCHEMA CLAIMS.
 *
 * `mbosColumns()` is spread into two dozen tables and declares six columns.
 * `mbos_lead_validations` spread it and, for fifty-odd migrations, had three of
 * them: `0102` wrote its own column list and left out `client_created_at`,
 * `server_created_at` and `device_id`. Drizzle believed the declaration and the
 * database disagreed, and NOTHING FAILED — because every reader named the
 * columns it wanted and none of them named those three.
 *
 * A divergence in a schema is only a bug once somebody writes the query that
 * trusts it. Here that was a new pull channel built from the declared shape:
 * `column k.client_created_at does not exist`, eleven integration tests down,
 * and the failure surfacing in CI rather than in any local run — because a
 * developer's database is built from the same migrations and is wrong in
 * exactly the same way. Only a query that asks for the column can tell.
 *
 * So this asks. It is an INTEGRATION test on purpose: the fault is by
 * definition invisible to `tsc`, which reads the declaration, and to any grep,
 * which reads the migration that happened to create the table rather than the
 * fifty that have altered it since.
 */

const HELPER_COLUMNS = [
  "id",
  "client_created_at",
  "server_created_at",
  "created_by_id",
  "updated_at",
  "updated_by_id",
  "device_id",
] as const;

/** Every `pgTable` in the schema that spreads the helper. Read as text,
    because the runtime objects cannot say which of their columns came from
    a spread and which were written out beside it. */
function tablesUsingHelper(): string[] {
  const src = readFileSync("src/db/schema.ts", "utf8");
  const found: string[] = [];
  const re = /pgTable\(\s*"([a-z_]+)"\s*,\s*\{\s*\.\.\.mbosColumns\(\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) found.push(m[1]!);
  return found;
}

describe("the MBOS column helper", () => {
  after(async () => {
    await db.$client.end();
  });

  test("is not vacuous — the helper is actually spread into tables", () => {
    /* If the pattern ever stops matching, every assertion below passes over an
       empty list and this file becomes decoration. */
    assert.ok(
      tablesUsingHelper().length >= 20,
      "no tables matched the mbosColumns() spread — the regex has gone stale",
    );
  });

  test("every table that spreads it has all six columns in the database", async () => {
    const diverged: string[] = [];

    for (const table of tablesUsingHelper()) {
      const rows = await db.execute<{ column_name: string }>(sql`
        select column_name
          from information_schema.columns
         where table_schema = 'public'
           and table_name = ${table}
      `);
      const have = new Set(rows.map((r: { column_name: string }) => r.column_name));

      /* A table the migrations never created at all is a different fault and
         one this test must not report as a missing column. */
      if (have.size === 0) {
        diverged.push(`${table}: the table does not exist`);
        continue;
      }

      const missing = HELPER_COLUMNS.filter((c) => !have.has(c));
      if (missing.length) diverged.push(`${table}: missing ${missing.join(", ")}`);
    }

    assert.deepEqual(
      diverged,
      [],
      "these tables declare mbosColumns() and the database disagrees, so any " +
        "query built from the declaration throws at runtime and nowhere else:\n  " +
        diverged.join("\n  "),
    );
  });
});
