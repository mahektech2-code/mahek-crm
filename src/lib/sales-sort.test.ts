import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readSort, sortHref, sortRows, type SortColumns } from "@/app/sales/sort";

/* ---------------------------------------------------------------------------
 * Sorting a Manager Console table.
 *
 * Pure, so it is tested without a database and without a browser — the same
 * reason the engines are. What is worth pinning here is not that a sort sorts:
 * it is the three decisions that are easy to get wrong later and invisible
 * when they are, which are where a missing value goes, whether a tie keeps its
 * query order, and whether the filter survives a click on a column.
 * ------------------------------------------------------------------------- */

type Row = { name: string; owed: number | null; at: string | null };

const COLUMNS: SortColumns<Row> = {
  name: (r) => r.name,
  owed: (r) => r.owed,
  at: (r) => (r.at ? new Date(r.at).getTime() : null),
};

describe("reading a sort off the URL", () => {
  it("an unknown column falls back to the query's own order", () => {
    // A stale link from a screen that has since lost a column has to degrade
    // to the default rather than to an empty or arbitrarily ordered table.
    assert.equal(readSort({ sort: "nonsense" }, COLUMNS).key, null);
  });

  it("no direction means descending", () => {
    // Every sortable column here answers a "most" or a "who is worst"
    // question first.
    assert.equal(readSort({ sort: "owed" }, COLUMNS).dir, "desc");
    assert.equal(readSort({ sort: "owed", dir: "asc" }, COLUMNS).dir, "asc");
  });

  it("a direction with no column is still not a sort", () => {
    assert.equal(readSort({ dir: "asc" }, COLUMNS).key, null);
  });
});

describe("the link a column header points at", () => {
  it("clicking the column in force flips it", () => {
    const href = sortHref("/sales/orders", { key: "owed", dir: "desc" }, "owed");
    assert.ok(href.includes("dir=asc"), href);
  });

  it("clicking a different column starts it descending", () => {
    const href = sortHref("/sales/orders", { key: "name", dir: "asc" }, "owed");
    assert.ok(href.includes("dir=desc"), href);
  });

  it("THE FILTER SURVIVES THE CLICK", () => {
    // The failure this guards is silent and nasty: sort a filtered list, and
    // the chip quietly resets to its default while the table fills with rows
    // the reader had deliberately excluded. Nothing on the screen says so.
    const href = sortHref("/sales/orders", { key: null, dir: "desc" }, "owed", "show=waiting");
    assert.ok(href.startsWith("/sales/orders?show=waiting&"), href);
    assert.ok(href.includes("sort=owed"), href);
  });
});

describe("the sort itself", () => {
  const rows: Row[] = [
    { name: "Anand", owed: 500, at: "2026-09-01" },
    { name: "Bharat", owed: null, at: null },
    { name: "Chetan", owed: 900, at: "2026-08-01" },
  ];

  it("does not mutate what it was given", () => {
    const before = [...rows];
    sortRows(rows, { key: "owed", dir: "asc" }, COLUMNS);
    assert.deepEqual(rows, before);
  });

  it("no column at all leaves the query's order alone", () => {
    assert.deepEqual(
      sortRows(rows, { key: null, dir: "desc" }, COLUMNS).map((r) => r.name),
      ["Anand", "Bharat", "Chetan"],
    );
  });

  it("A MISSING VALUE SORTS LAST IN BOTH DIRECTIONS", () => {
    // The one rule worth stating twice. A salesman who never checked in has no
    // check-in time and a shop with no pin has no distance; floating those to
    // the top of a descending sort puts the rows that answer the question
    // least exactly where the eye goes first.
    for (const dir of ["asc", "desc"] as const) {
      const out = sortRows(rows, { key: "owed", dir }, COLUMNS);
      assert.equal(out[out.length - 1].name, "Bharat", `${dir} put the empty row first`);
    }
  });

  it("ties keep the order the query put them in", () => {
    // `Array.prototype.sort` is specified stable, and this depends on it: a
    // table sorted by city still reads newest-first inside each town.
    const tied: Row[] = [
      { name: "first", owed: 100, at: null },
      { name: "second", owed: 100, at: null },
      { name: "third", owed: 100, at: null },
    ];
    assert.deepEqual(
      sortRows(tied, { key: "owed", dir: "desc" }, COLUMNS).map((r) => r.name),
      ["first", "second", "third"],
    );
  });

  it("numbers sort as numbers and not as text", () => {
    // The bug this catches is a column that reads 9 as larger than 100.
    const money: Row[] = [
      { name: "a", owed: 9, at: null },
      { name: "b", owed: 100, at: null },
    ];
    assert.deepEqual(
      sortRows(money, { key: "owed", dir: "desc" }, COLUMNS).map((r) => r.owed),
      [100, 9],
    );
  });

  it("dates sort by instant, not by the string they were printed as", () => {
    assert.deepEqual(
      sortRows(rows, { key: "at", dir: "desc" }, COLUMNS).map((r) => r.name),
      ["Anand", "Chetan", "Bharat"],
    );
  });
});
