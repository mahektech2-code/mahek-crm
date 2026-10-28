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
  assert.deepEqual(p.groups["1"], { n: 2, agg: [{ v: 17, missing: 0 }], ids: ["a", "c"], head: ROWS[0].v });
  const first = pageOf(spec, ROWS, { ...Q(), size: 1 } as ListQuery, FLAGS);
  assert.deepEqual(first.rows.map((r) => r.id), ["a"]);
  assert.equal(first.groups["1"].n, 2);
});

test("a group can carry several aggregates, and one that asks counts the rows it could not sum", () => {
  const two: ListSpec = { ...spec, agg: [{ k: "qty", l: "litres" }, { k: "kg", l: "kg", missing: "without a weight" }], cols: [...spec.cols, { k: "kg", l: "Weight", t: "n" }] };
  const rows = ROWS.map((r, i) => ({ ...r, v: { ...r.v, kg: i === 0 ? 12.5 : null } }));
  const p = pageOf(two, rows, Q({ size: 25, page: 1 }), FLAGS);
  assert.deepEqual(p.groups["1"].agg, [{ v: 17, missing: 0 }, { v: 12.5, missing: 1 }]);
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

describe("a list that folds rows under a total", () => {
  const fspec: ListSpec = { ...spec, groups: undefined, chips: undefined, fold: { l: "Cans", whole: "Item total", parts: "By lot" } };
  const lotOf = (id: string, no: string, qty: number): ListRow => ({ id, v: { no, item: "Can 5 L", qty, status: "Open", godown: "Bhiwandi" }, flags: [] });
  const FOLD: ListRow[] = [
    row("t", "T1", "Toluene", 10, "Open", "Bhiwandi"),
    { ...row("can", "2 lots", "Can 5 L", 30, "Open", "Bhiwandi"), sub: [lotOf("c1", "C-001", 10), lotOf("c2", "C-002", 20)] },
  ];

  test("totals are the rows, and By lot puts each lot in its total's place", () => {
    assert.deepEqual(queryRows(fspec, FOLD, Q(), FLAGS).list.map((r) => r.id), ["t", "can"]);
    assert.deepEqual(queryRows(fspec, FOLD, Q({ parts: true }), FLAGS).list.map((r) => r.id), ["t", "c1", "c2"]);
    assert.deepEqual(parseListQuery(listQueryParams(Q({ parts: true }))).parts, true);
  });

  test("a lot number finds its total, and a named lot keeps its total in the list", () => {
    assert.deepEqual(queryRows(fspec, FOLD, Q({ q: "c-002" }), FLAGS).list.map((r) => r.id), ["can"]);
    assert.deepEqual(queryRows(fspec, FOLD, Q({ ids: ["c1"] }), FLAGS).list.map((r) => r.id), ["can"]);
    assert.deepEqual(queryRows(fspec, FOLD, Q({ ids: ["c1"], parts: true }), FLAGS).list.map((r) => r.id), ["c1"]);
  });

  test("a list that does not fold ignores By lot", () => {
    assert.deepEqual(queryRows({ ...fspec, fold: undefined }, FOLD, Q({ parts: true }), FLAGS).list.map((r) => r.id), ["t", "can"]);
  });
});

describe("column filters", () => {
  const fspec: ListSpec = { ...spec, filters: ["item", "status", "nope"] };

  test("a filter keeps the rows whose column shows the value, and survives the URL", () => {
    const q = Q({ fx: { item: "Toluene" }, grp: false });
    assert.deepEqual(queryRows(fspec, ROWS, q, FLAGS).list.map((r) => r.id), ["a", "d"]);
    assert.deepEqual(parseListQuery(listQueryParams(q)), q);
    assert.deepEqual(parseListQuery({ fx: "not json" }).fx, {});
  });

  test("each filter is counted over what the other filters leave, and a key the spec does not draw is not offered", () => {
    const p = pageOf(fspec, ROWS, Q({ fx: { status: "Open" } }), FLAGS);
    assert.deepEqual(p.facets.map((f) => f.k), ["item", "status"]);
    assert.deepEqual(p.facets[0].opts, [{ v: "Acetone", n: 1 }, { v: "Toluene", n: 2 }]);
    assert.deepEqual(p.facets[1].opts, [{ v: "Done", n: 1 }, { v: "Open", n: 3 }]);
    assert.equal(p.total, 3);
    assert.equal(p.beforeChip, 3, "the chip's All count follows the filters");
  });

  test("a picked value nothing has any more is still offered, at zero", () => {
    const p = pageOf(fspec, ROWS, Q({ fx: { item: "Xylene", status: "Open" } }), FLAGS);
    assert.deepEqual(p.facets[0].opts.find((o) => o.v === "Xylene"), { v: "Xylene", n: 0 });
    assert.equal(p.total, 0);
  });

  test("a filter the spec does not offer is ignored", () => {
    assert.equal(queryRows(spec, ROWS, Q({ fx: { item: "Toluene" } }), FLAGS).list.length, 4);
  });
});
