import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";

import { PARENT_KIND, territoryClause, type Territory } from "./territory-rules";

/**
 * THE RULE ITSELF, exercised without a database.
 *
 * Every territory feature in this product was once dead on the real book, and
 * the failure was invisible to types, to the linter and to every unit test: the
 * SQL looked correct, the query ran, and the answer was an empty list that read
 * as "nothing set up yet" rather than as a bug. These tests exist because the
 * two things that decide somebody's whole handset — whether an empty allocation
 * matches nothing, and whether a city narrows INSIDE its state or sits beside
 * it — are both invisible at runtime on a book that happens to agree.
 */

const dialect = new PgDialect();
const render = (territories: Territory[]) => {
  const q = dialect.sqlToQuery(territoryClause(territories));
  /* Parameters back inline, so a test can read the clause the way a person
     would. Nothing here is a real query — it is never sent anywhere. */
  return q.params.reduce<string>(
    (text, p, i) => text.replace(`$${i + 1}`, `'${String(p)}'`),
    q.sql,
  );
};

test("NOTHING ALLOCATED MATCHES NOTHING, and never nothing-to-match", () => {
  /* The whole of the reversal. This used to answer `undefined`, which every
     caller read as "no filter" — so an unallocated salesman carried the entire
     book. An absent clause and a false one look alike in a type signature and
     are opposite answers to "what may this person see". */
  assert.equal(render([]), "false");
});

test("a state matches every spelling of it, not the one somebody clicked", () => {
  /* The sheet holds Gujrat 97 beside Gujarat 31. Compared as text, a chip
     saying "Gujarat" covered a quarter of Gujarat and nothing said so. */
  const clause = render([{ kind: "state", value: "Gujarat" }]);
  assert.match(clause, /gujarat/);
  assert.match(clause, /gujrat/);
});

test("A CITY NARROWS INSIDE ITS STATE — it does not sit beside it", () => {
  /*
   * The difference between `and` and `or` here is the difference between
   * "Pune" and "the whole of Maharashtra", and both read as a narrowing on the
   * screen that set them. Picked apart the wrong way round, a salesman
   * allocated one city quietly holds twelve hundred shops.
   */
  const clause = render([{ kind: "city", value: "Pune", parent: "Maharashtra" }]);
  assert.match(clause, /\band\b/);
  assert.doesNotMatch(clause, /\bor\b/);
  assert.match(clause, /'pune'/);
  assert.match(clause, /maharashtra/);
});

test("two states are both states", () => {
  const clause = render([
    { kind: "state", value: "Gujarat" },
    { kind: "state", value: "Kerala" },
  ]);
  assert.match(clause, /\bor\b/);
});

test("a beat narrows inside its city", () => {
  const clause = render([{ kind: "beat", value: "Camp", parent: "Pune" }]);
  assert.match(clause, /\band\b/);
  assert.match(clause, /'camp'/);
  assert.match(clause, /'pune'/);
});

test("A ROW WRITTEN BEFORE THE HIERARCHY KEEPS ITS OLD MEANING", () => {
  /*
   * Legacy rows carry no parent, and the fall-through is deliberate: a city
   * allocated a month ago must not silently stop matching because a column
   * arrived. Refusing it instead would empty a book on the day of a deploy,
   * which is the one failure nobody debugs.
   */
  const clause = render([{ kind: "city", value: "Nagpur" }]);
  assert.doesNotMatch(clause, /\band\b/);
  assert.match(clause, /'nagpur'/);
});

test("the hierarchy is stated once, and it is what the screens read", () => {
  /* Three copies of a shape is how a dialog comes to offer something the
     action then rejects. */
  assert.equal(PARENT_KIND.state, null);
  assert.equal(PARENT_KIND.city, "state");
  assert.equal(PARENT_KIND.beat, "city");
});
