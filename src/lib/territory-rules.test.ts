import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  PARENT_KIND,
  matchesTerritory,
  placeNewLead,
  territoryClause,
  territoryLeaves,
  townParent,
  type Territory,
} from "./territory-rules";
import { indexPlaces, type PlaceNode } from "./place-tree";
import { placeKey } from "./place-parse";

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

test("the clause can be told which table the columns are on", () => {
  /* Every territory caller selects `from customers` unaliased; the leads list
     selects `from customers c`, and `customers.city` is not a name Postgres can
     resolve there. It is a parameter rather than a second copy of the clause —
     two readings of "which shops are in Nagpur" is the drift this file exists
     to prevent, and the half that drifts is the one nobody compares. */
  const one: Territory[] = [{ kind: "city", value: "Nagpur", parent: "Maharashtra" }];

  const aliased = dialect.sqlToQuery(territoryClause(one, "c")).sql;
  assert.match(aliased, /c\.city/);
  assert.doesNotMatch(aliased, /customers\./);

  /* And the default is what every existing caller already relies on. */
  assert.match(dialect.sqlToQuery(territoryClause(one)).sql, /customers\.city/);
});

/* ------------------------------------------------ where a lead may be raised */

const pritesh: Territory[] = [
  { kind: "city", value: "Thane", parent: "Maharashtra" },
  { kind: "city", value: "Bhopal", parent: "Madhya Pradesh" },
  { kind: "region", value: "Maharashtra" },
];
const rahul: Territory[] = [{ kind: "state", value: "Madhya Pradesh" }];

test("A LEAD IN AN ALLOCATED CITY takes the city's state, even from a phone that sent none", () => {
  assert.deepEqual(placeNewLead(pritesh, { city: "thane" }, true), { ok: true, state: "Maharashtra" });
});

test("A TOWN THE BOOK KNOWS is filed under the state the book files it under", () => {
  /* The production case: Nagpur, no state on the wire, and a region row for
     Maharashtra. Before, the lead was accepted with no state and matched no
     territory at all — on nobody's Customers tab, its author's included. */
  assert.deepEqual(
    placeNewLead(pritesh, { city: "Nagpur", bookState: "Maharashtra" }, true),
    { ok: true, state: "Maharashtra" },
  );
});

test("A SALESMAN ON ONE STATE needs no state from the phone", () => {
  assert.deepEqual(placeNewLead(rahul, { city: "Rewa" }, false), { ok: true, state: "Madhya Pradesh" });
});

test("OUTSIDE THE AREA IS REFUSED, and the refusal names the area", () => {
  const r = placeNewLead(rahul, { city: "Virar", bookState: "Maharashtra" }, false);
  assert.deepEqual(r, { ok: false, reason: "outside", areas: ["Madhya Pradesh"] });
});

test("A CITY NARROWS INSIDE ITS STATE: Bhopal in Maharashtra is not Bhopal", () => {
  const cityOnly: Territory[] = [{ kind: "city", value: "Bhopal", parent: "Madhya Pradesh" }];
  assert.equal(placeNewLead(cityOnly, { city: "Bhopal", state: "Maharashtra" }, false).ok, false);
  assert.equal(placeNewLead(cityOnly, { city: "Bhopal" }, false).ok, true);
});

test("A STATE IS MATCHED ON EVERY SPELLING, as the SQL matches it", () => {
  const guj: Territory[] = [{ kind: "state", value: "Gujarat" }];
  assert.equal(placeNewLead(guj, { city: "Surat", state: "Gujrat" }, false).ok, true);
});

test("AN UNRESOLVABLE STATE IS NOT GUESSED: two states and an unknown town is refused", () => {
  const two: Territory[] = [
    { kind: "state", value: "Odisha" },
    { kind: "state", value: "Madhya Pradesh" },
  ];
  assert.equal(placeNewLead(two, { city: "Somewhere" }, false).ok, false);
  assert.equal(placeNewLead(two, { city: "Somewhere", state: "Odisha" }, false).ok, true);
});

test("NO AREA: a salesman cannot raise a lead, a manager with no allocation can", () => {
  assert.deepEqual(placeNewLead([], { city: "Pune" }, false), { ok: false, reason: "no_area", areas: [] });
  assert.deepEqual(placeNewLead([], { city: "Pune", bookState: "Maharashtra" }, true), {
    ok: true,
    state: "Maharashtra",
  });
});

test("A BEAT is matched on the area, inside its city", () => {
  const beat: Territory = { kind: "beat", value: "Sadar", parent: "Nagpur" };
  assert.equal(matchesTerritory(beat, { city: "Nagpur", area: "sadar" }), true);
  assert.equal(matchesTerritory(beat, { city: "Pune", area: "Sadar" }), false);
});

/* ------------------------------------------------ the tree: district and town */

/** A small tree: two Aurangabads, one in each state, each with its own town. */
const node = (id: string, kind: PlaceNode["kind"], name: string, parentId: string | null): PlaceNode => ({
  id,
  kind,
  name,
  key: placeKey(name),
  parentId,
});
const TREE = indexPlaces([
  node("mh", "state", "Maharashtra", null),
  node("mh-thane", "district", "Thane", "mh"),
  node("mh-kalyan", "city", "Kalyan", "mh-thane"),
  node("mh-bhiwandi", "city", "Bhiwandi", "mh-thane"),
  node("mh-pune", "district", "Pune", "mh"),
  node("mh-pune-city", "city", "Pune", "mh-pune"),
  node("mh-aur", "district", "Aurangabad", "mh"),
  node("mh-aur-city", "city", "Aurangabad", "mh-aur"),
  node("br", "state", "Bihar", null),
  node("br-aur", "district", "Aurangabad", "br"),
  node("br-aur-city", "city", "Aurangabad", "br-aur"),
]);

test("A DISTRICT IS MATCHED ON THE TREE, never on what the sheet typed", () => {
  /* The typed `city` column is 1,165 spellings with postal addresses among
     them; a district reads the shop's reviewed place instead, and names its
     state so Aurangabad in Bihar is not Aurangabad in Maharashtra. */
  const clause = render([{ kind: "district", value: "Thane", parent: "Maharashtra" }]);
  assert.match(clause, /resolved_district_id in/);
  assert.match(clause, /'thane'/);
  assert.match(clause, /'maharashtra'/);
  assert.doesNotMatch(clause, /lower\(trim\(coalesce\(customers\.city/);
});

test("a town is matched under its district AND its state", () => {
  const clause = render([{ kind: "town", value: "Kalyan", parent: townParent("Thane", "Maharashtra") }]);
  assert.match(clause, /resolved_city_id in/);
  assert.match(clause, /'kalyan'/);
  assert.match(clause, /'thane'/);
  assert.match(clause, /'maharashtra'/);
});

test("a town that does not name its state matches nothing rather than every namesake", () => {
  assert.equal(render([{ kind: "town", value: "Aurangabad", parent: "Aurangabad" }]), "(false)");
});

test("a tree row names the table it is asked about, like every other kind", () => {
  const q = dialect.sqlToQuery(territoryClause([{ kind: "district", value: "Thane", parent: "Maharashtra" }], "c"));
  assert.match(q.sql, /\bc\.resolved_district_id\b/);
});

test("THE NARROWEST PICK IN A BRANCH IS STORED — down to the town", () => {
  const leaves = territoryLeaves<Territory>([
    { kind: "state", value: "Maharashtra", parent: "" },
    { kind: "district", value: "Thane", parent: "Maharashtra" },
    { kind: "town", value: "Kalyan", parent: townParent("Thane", "Maharashtra") },
    { kind: "district", value: "Pune", parent: "Maharashtra" },
    { kind: "state", value: "Goa", parent: "" },
  ]);
  assert.deepEqual(
    leaves.map((t) => `${t.kind}:${t.value}`),
    ["town:Kalyan", "district:Pune", "state:Goa"],
  );
});

test("a town under Aurangabad in Maharashtra does not prune Aurangabad in Bihar", () => {
  /* Pruning by bare value — what this used to do — would have dropped the
     Bihar district and silently handed the salesman less than was picked. */
  const leaves = territoryLeaves<Territory>([
    { kind: "district", value: "Aurangabad", parent: "Maharashtra" },
    { kind: "town", value: "Aurangabad", parent: townParent("Aurangabad", "Maharashtra") },
    { kind: "district", value: "Aurangabad", parent: "Bihar" },
  ]);
  assert.deepEqual(
    leaves.map((t) => `${t.kind}:${t.value}:${t.parent}`),
    ["town:Aurangabad:Aurangabad, Maharashtra", "district:Aurangabad:Bihar"],
  );
});

test("a typed city picked before districts still prunes its state", () => {
  const leaves = territoryLeaves<Territory>([
    { kind: "state", value: "Maharashtra", parent: "" },
    { kind: "city", value: "Pune", parent: "Maharashtra" },
  ]);
  assert.deepEqual(leaves.map((t) => t.kind), ["city"]);
});

test("matchesTerritory reads a district and a town off the tree's names", () => {
  const kalyan = { city: "kalyan west", state: "Maharashtra", district: "Thane", town: "Kalyan" };
  assert.equal(matchesTerritory({ kind: "district", value: "Thane", parent: "Maharashtra" }, kalyan), true);
  assert.equal(matchesTerritory({ kind: "district", value: "Thane", parent: "Gujarat" }, kalyan), false);
  assert.equal(
    matchesTerritory({ kind: "town", value: "Kalyan", parent: townParent("Thane", "Maharashtra") }, kalyan),
    true,
  );
  assert.equal(
    matchesTerritory({ kind: "town", value: "Bhiwandi", parent: townParent("Thane", "Maharashtra") }, kalyan),
    false,
  );
});

test("A LEAD IN A TOWN OF HIS DISTRICT IS LET IN, and filed under its state", () => {
  const thane: Territory[] = [{ kind: "district", value: "Thane", parent: "Maharashtra" }];
  /* No state from the phone and none from the book: the district names it. */
  const inside = placeNewLead(thane, { city: "Kalyan" }, false, TREE);
  assert.deepEqual(inside, { ok: true, state: "Maharashtra" });

  const outside = placeNewLead(thane, { city: "Pune" }, false, TREE);
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.deepEqual(outside.areas, ["Thane district (Maharashtra)"]);
});

test("a town allocation lets in that town and not its neighbour", () => {
  const kalyan: Territory[] = [{ kind: "town", value: "Kalyan", parent: townParent("Thane", "Maharashtra") }];
  assert.equal(placeNewLead(kalyan, { city: "Kalyan" }, false, TREE).ok, true);
  assert.equal(placeNewLead(kalyan, { city: "Bhiwandi" }, false, TREE).ok, false);
});

test("a lead with no town falls back to its area, as the row it becomes does", () => {
  const thane: Territory[] = [{ kind: "district", value: "Thane", parent: "Maharashtra" }];
  assert.equal(placeNewLead(thane, { city: null, area: "Bhiwandi" }, false, TREE).ok, true);
});

test("without the tree a district cannot match, so the lead is refused rather than guessed in", () => {
  const thane: Territory[] = [{ kind: "district", value: "Thane", parent: "Maharashtra" }];
  assert.equal(placeNewLead(thane, { city: "Kalyan" }, false).ok, false);
});

test("an older handset that sends a district as the state is not taken at its word", () => {
  /* Builds before districts offered every unknown kind as a state chip, so the
     lead arrives saying state "Thane". It is a town in Thane district all the
     same, and the one state his allocation names is the state it is in. */
  const thane: Territory[] = [{ kind: "district", value: "Thane", parent: "Maharashtra" }];
  assert.deepEqual(placeNewLead(thane, { city: "Kalyan", state: "Thane" }, false, TREE), {
    ok: true,
    state: "Maharashtra",
  });
});
