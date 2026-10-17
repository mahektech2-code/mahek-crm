import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ListRow, ListSpec, Tone } from "./ui";
import { groupHeadValues, listCsv, listQueryParams, pageOf, parseListQuery, queryRows, type ListQuery } from "./list-query";

const FLAGS: Record<string, [string, Tone]> = { late: ["Running late", "danger"] };
const spec: ListSpec = {
  screen: "t",
  cols: [
    { k: "no", l: "No", t: "mono" },
    { k: "item", l: "Item", t: "b" },
    { k: "qty", l: "Qty", t: "n" },
    { k: "status", l: "Status", t: "s" },
    { k: "godown", l: "Godown", t: "t" },
    { k: "flags", l: "Flags", t: "f" },
  ],
  hidden: [],
  chips: "status",
  godownKey: "godown",
  groups: ["no"],
  agg: { k: "qty", l: "litres" },
};
const row = (id: string, no: string, item: string, qty: number, status: string, godown: string, flags: string[] = []): ListRow => ({
  id,
  v: { no, item, qty, status, godown },
  flags,
});
const ROWS: ListRow[] = [
  row("a", "1", "Toluene", 10, "Open", "Bhiwandi"),
  row("b", "2", "Xylene", 5, "Done", "Vasai", ["late"]),
  row("c", "1", "Acetone", 7, "Open", "Bhiwandi"),
  row("d", "3", "Toluene", 1, "Open", "Vasai"),
];
const Q = (over: Partial<ListQuery> = {}): ListQuery => ({ ...parseListQuery({}), ...over });

test("a query survives the URL both ways, and the defaults stay out of it", () => {
  const q = Q({ q: "tol", chip: "Open", gf: "Vasai", grp: false, sort: { k: "qty", d: -1 }, page: 3, size: 50 });
  assert.deepEqual(parseListQuery(listQueryParams(q)), q);
  assert.deepEqual(listQueryParams(Q()), {});
});

test("nonsense in the URL reads as the defaults rather than throwing", () => {
  const q = parseListQuery({ page: "-2", size: "7", sort: "qty", grp: "yes" });
  assert.equal(q.page, 1);
  assert.equal(q.size, 25);
  assert.equal(q.sort, null);
  assert.equal(q.grp, true);
});

test("grouping keeps each group together in the order it first appears", () => {
  const { list } = queryRows(spec, ROWS, Q(), FLAGS);
  assert.deepEqual(list.map((r) => r.id), ["a", "c", "b", "d"]);
});

test("search reads the words on the screen, flags included", () => {
  assert.deepEqual(queryRows(spec, ROWS, Q({ q: "running late" }), FLAGS).list.map((r) => r.id), ["b"]);
  assert.deepEqual(queryRows(spec, ROWS, Q({ q: "toluene", grp: false }), FLAGS).list.map((r) => r.id), ["a", "d"]);
});

test("the chip counts are taken before the chip, and after the godown", () => {
  const p = pageOf(spec, ROWS, Q({ gf: "Vasai", chip: "Open" }), FLAGS);
  assert.equal(p.beforeChip, 2);
  assert.deepEqual(p.chips, [{ v: "Done", n: 1 }, { v: "Open", n: 1 }]);
  assert.equal(p.total, 1);
});

test("a page carries its groups whole: the count, the aggregate and every id, even past the page", () => {
  const p = pageOf(spec, ROWS, Q({ size: 25, page: 1 }), FLAGS);
  assert.deepEqual(p.groups["1"], { n: 2, agg: 17, ids: ["a", "c"], head: ROWS[0].v });
  const first = pageOf(spec, ROWS, { ...Q(), size: 1 } as ListQuery, FLAGS);
  assert.deepEqual(first.rows.map((r) => r.id), ["a"]);
  assert.equal(first.groups["1"].n, 2);
});

test("a page past the end is the last page", () => {
  const p = pageOf(spec, ROWS, Q({ page: 9 }), FLAGS);
  assert.equal(p.page, 1);
  assert.equal(p.rows.length, 4);
});

test("a dashboard's ids narrow the list before anything else", () => {
  const p = pageOf(spec, ROWS, Q({ ids: ["b", "d"] }), FLAGS);
  assert.equal(p.total, 2);
  assert.equal(p.all, 4);
});

test("sorting puts numbers in number order", () => {
  const { list } = queryRows(spec, ROWS, Q({ grp: false, sort: { k: "qty", d: 1 } }), FLAGS);
  assert.deepEqual(list.map((r) => r.id), ["d", "b", "c", "a"]);
});

test("the export is every filtered row, not the page", () => {
  const { csv, n } = listCsv(spec, ROWS, Q({ chip: "Open", size: 25 }), FLAGS);
  assert.equal(n, 3);
  assert.equal(csv.split("\n").length, 4);
  assert.match(csv.split("\n")[0], /^No,Item,Qty,Status,Godown,Flags$/);
});

describe("a group's header facts", () => {
  const row = (id: string, po: string | null, date: string) => ({ id, v: { pr: "15", po, date } }) as unknown as ListRow;
  test("a fact every row shares is drawn once", () => {
    assert.equal(groupHeadValues([row("a", "PO-15", "2026-10-17"), row("b", "PO-15", "2026-10-17")], ["po", "date"]).po, "PO-15");
  });
  test("a fact the rows disagree on lists every value, in order", () => {
    const h = groupHeadValues([row("a", "PO-15", "2026-10-17"), row("b", "PO-16", "2026-10-17"), row("c", "PO-15", "2026-10-17")], ["po", "date"]);
    assert.equal(h.po, "PO-15, PO-16");
    assert.equal(h.date, "2026-10-17");
  });
  test("an empty value is not listed beside a real one", () => {
    assert.equal(groupHeadValues([row("a", null, "x"), row("b", "PO-9", "x")], ["po"]).po, "PO-9");
    assert.equal(groupHeadValues([row("a", "PO-9", "x"), row("b", null, "x")], ["po"]).po, "PO-9");
  });
});
