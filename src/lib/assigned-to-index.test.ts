import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* ---------------------------------------------------------------------------
 * THE SCOPE PREDICATE IS WRITTEN DOWN TWICE, AND THE COPY IS SILENT WHEN IT
 * DRIFTS.
 *
 * `ASSIGNED_TO_SQL` in `access-control.ts` is the first arm of `scopedToUsers`,
 * which is the first clause of every scoped list in the CRM and the Accounts
 * app. It is a CASE expression rather than a column, so the only way to index
 * it is an expression index — and Postgres uses an expression index only where
 * the query's expression MATCHES the index's.
 *
 * So `drizzle/0138_stop_scanning_the_book.sql` carries a copy of that constant,
 * and the copy is load bearing in the worst possible way: edit the constant and
 * nothing breaks, nothing logs, no test goes red, every list goes on returning
 * exactly the rows it returned before — and every one of them has quietly gone
 * back to the sequential scan of 5,925 rows that the index was built to remove.
 * A regression that costs only performance is a regression nobody reports,
 * because there is nothing to report: the screen is right, it is just slower
 * than it was, by an amount no one person notices.
 *
 * This test is the thing that makes the edit loud. It reads BOTH files as text
 * — the schema is a string in one and SQL in the other, and nothing else can
 * join them — and fails the build when the two stop agreeing.
 *
 * It is a TEXT comparison after whitespace is flattened, deliberately. Postgres
 * matches on the parsed tree, so indentation genuinely does not matter; what
 * does matter is that a person changing the constant is stopped, and being
 * stopped by a strict comparison they then have to mirror is exactly the
 * outcome wanted. A clever test that tried to decide which edits were harmless
 * would be a second implementation of the planner's matching rules, and would
 * be wrong in the direction that lets a real drift through.
 * ------------------------------------------------------------------------- */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

const MIGRATION = "drizzle/0138_stop_scanning_the_book.sql";

/** Flatten every run of whitespace, so only the words and symbols are compared. */
function flatten(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function constantExpression(): string {
  const source = readFileSync(join(repo, "src/lib/access-control.ts"), "utf8");
  const match = source.match(/export const ASSIGNED_TO_SQL = sql`([\s\S]*?)`;/);
  assert.ok(
    match,
    "ASSIGNED_TO_SQL is no longer a plain sql`…` template in access-control.ts. " +
      "It is copied into " +
      MIGRATION +
      " as an expression index, so if it stops being readable as text this test " +
      "has to be taught the new shape rather than deleted.",
  );
  return flatten(match[1]);
}

function indexExpression(): string {
  const source = readFileSync(join(repo, MIGRATION), "utf8");
  const match = source.match(
    /CREATE INDEX IF NOT EXISTS customers_assigned_to_idx\s+ON customers \(\(([\s\S]*?)\)\);/,
  );
  assert.ok(
    match,
    `customers_assigned_to_idx is no longer declared in ${MIGRATION}. If the ` +
      "index was moved or renamed, point this test at where it went — do not " +
      "drop it, or the constant and the index part company with nothing saying so.",
  );
  return flatten(match[1]);
}

describe("the scope predicate and its expression index", () => {
  it("are the same expression, word for word", () => {
    assert.equal(
      indexExpression(),
      constantExpression(),
      "ASSIGNED_TO_SQL and customers_assigned_to_idx have drifted apart.\n\n" +
        "Postgres will no longer use the index, so every scoped list in the CRM " +
        "and the Accounts app is back to a sequential scan of the whole book — " +
        "with no wrong answers anywhere to make it visible.\n\n" +
        `Mirror the change into ${MIGRATION}, and remember that the index on a ` +
        "deployed database was built from the OLD expression: a changed constant " +
        "needs a new migration that drops and rebuilds it, not an edit to this one.",
    );
  });

  it("names only columns of `customers`, so the index stays legal", () => {
    /*
     * An expression index demands an IMMUTABLE expression. Column references
     * and `coalesce` are; `now()`, a cast that reads the session's timezone,
     * and anything reading configuration are not — and adding one would make
     * the migration fail at the CREATE rather than quietly, which is the good
     * direction. This asserts it anyway, because the failure would otherwise
     * arrive on somebody's deploy rather than on their branch.
     */
    const expression = constantExpression();
    for (const forbidden of ["now(", "current_", "::date", "at time zone", "random("]) {
      assert.ok(
        !expression.includes(forbidden),
        `ASSIGNED_TO_SQL now contains \`${forbidden}\`, which is not IMMUTABLE. ` +
          "An expression index cannot be built on it, so customers_assigned_to_idx " +
          "has to go — and every scoped list loses its index with it.",
      );
    }
  });
});
