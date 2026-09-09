import { test } from "node:test";
import assert from "node:assert/strict";

import { TERRITORY_REGION_SQL, qualify, stateKeySql } from "./territory-sql";
import { stateKey } from "./india-states";

/**
 * The territory expression, pinned as TEXT.
 *
 * Every territory feature in the console was dead on the real book because the
 * column it read — `customers.territory_region` — is empty on all 5,915 rows,
 * while `customers.region` carries the states the sheet actually fills. That
 * failure is invisible to types and to unit tests: the SQL is correct-looking,
 * the query runs, and the answer is an empty list that reads as "nothing set
 * up yet" rather than as a bug.
 *
 * What makes it worth a test is that the chip list and the filter have to read
 * the SAME expression. When they disagree, the console offers a place no
 * customer is in and the allocation silently empties somebody's screen — which
 * is the one outcome nobody debugs.
 */

test("the widest geography falls through to the column the sheet actually fills", () => {
  assert.match(TERRITORY_REGION_SQL, /territory_region/);
  assert.match(TERRITORY_REGION_SQL, /\bregion\b/);
  /* territory_region FIRST: it keeps the meaning its schema comment gives it
     wherever somebody fills it, and `region` only answers until then. */
  assert.ok(
    TERRITORY_REGION_SQL.indexOf("territory_region") <
      TERRITORY_REGION_SQL.lastIndexOf("region"),
    "territory_region has to win where it is set",
  );
  /* An empty string is not a value. Without the nullif, a row with
     `territory_region = ''` would beat a real region and match nothing. */
  assert.match(TERRITORY_REGION_SQL, /nullif/);
});

test("qualifying names EVERY column, not just the first", () => {
  /* A bare column inside a correlated subquery binds to the INNER table and the
     condition silently becomes false — the bug AGENTS.md records under "in raw
     SQL, qualify every column of the outer table", which shipped once already.
     One column qualified out of two is that bug with extra steps. */
  const out = qualify(TERRITORY_REGION_SQL, "c");
  assert.match(out, /c\.territory_region/);
  assert.match(out, /c\.region/);
  assert.equal(/(?<!\.)\bterritory_region\b/.test(out), false, "an unqualified column is left");
  assert.equal(/(?<!\.)\bregion\b/.test(out.replace(/territory_region/g, "")), false);
});

test("the other kinds qualify too, and are left alone otherwise", () => {
  assert.equal(qualify("city", "customers"), "customers.city");
  assert.equal(qualify("beat", "customers"), "customers.beat");
  /* Only the known column names are touched — a function name or a literal
     inside the expression must survive being qualified. */
  assert.equal(qualify("lower(city)", "c"), "lower(c.city)");
});

test("the SQL fold and the JavaScript fold are twins", () => {
  /* The chip list canonicalises in JavaScript and the filter compares in
     Postgres. If the two folded differently the console would offer a place
     whose own customers it then failed to match — the same class of failure as
     reading two different columns, and just as invisible. Both keep letters
     only, lower case. */
  const sql = stateKeySql("region");
  assert.match(sql, /lower/);
  assert.match(sql, /\[\^a-z\]/);
  /* And the JavaScript side agrees on what that means. */
  assert.equal(stateKey("TAMIL NADU"), "tamilnadu");
  assert.equal(stateKey("Jammu & Kashmir"), "jammukashmir");
});
