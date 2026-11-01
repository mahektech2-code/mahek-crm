import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ListRow, ListSpec, Tone } from "./ui";
import { groupHeadValues, groupPrintHref, listCsv, listQueryParams, pageOf, parseListQuery, queryRows, selectionTotalText, selectionTotals, type ListQuery } from "./list-query";

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

describe("Excel column filters", () => {
  const cspec: ListSpec = { ...spec, groups: undefined, colFilters: true };

  test("a tick list keeps only the ticked values, across every page and the export", () => {
    const q = Q({ cf: { item: { in: ["Toluene", "Acetone"] } } });
    assert.deepEqual(queryRows(cspec, ROWS, q, FLAGS).list.map((r) => r.id), ["a", "c", "d"]);
    assert.equal(listCsv(cspec, ROWS, q, FLAGS).n, 3);
  });

  test("a number column filters by a range, either end open, and a blank fails a bound", () => {
    const rows = [...ROWS, { id: "e", v: { no: "4", item: "Mystery", qty: null, status: "Open", godown: "Vasai" }, flags: [] }];
    assert.deepEqual(queryRows(cspec, rows, Q({ cf: { qty: { min: 5, max: 10 } } }), FLAGS).list.map((r) => r.id), ["a", "b", "c"]);
    assert.deepEqual(queryRows(cspec, rows, Q({ cf: { qty: { min: null, max: 4 } } }), FLAGS).list.map((r) => r.id), ["d"]);
    assert.equal(queryRows(cspec, rows, Q(), FLAGS).list.length, 5);
  });

  test("each column's choices are counted over what the OTHER column filters leave", () => {
    const p = pageOf(cspec, ROWS, Q({ cf: { godown: { in: ["Vasai"] } } }), FLAGS);
    assert.deepEqual(p.colFacets?.item, { kind: "list", opts: [{ v: "Toluene", n: 1 }, { v: "Xylene", n: 1 }], more: 0 });
    assert.deepEqual(p.colFacets?.godown, { kind: "list", opts: [{ v: "Bhiwandi", n: 2 }, { v: "Vasai", n: 2 }], more: 0 });
    assert.deepEqual(p.colFacets?.qty, { kind: "range", lo: 1, hi: 5 });
    assert.equal(p.colFacets?.flags, undefined, "flags carry no column filter");
  });

  test("the filters survive the URL, and anything malformed is dropped", () => {
    const q = Q({ cf: { item: { in: ["Toluene"] }, qty: { min: 2, max: null } } });
    assert.deepEqual(parseListQuery(listQueryParams(q)).cf, q.cf);
    assert.deepEqual(parseListQuery({ cf: "not json" }).cf, {});
    assert.deepEqual(parseListQuery({ cf: JSON.stringify({ qty: { min: "x" }, item: { in: [1, "A"] } }) }).cf, { item: { in: ["A"] } });
  });

  /* The Filters pop-up may name any drawn column, so a filter is honoured on
     whichever column it names — not only on a list that draws header funnels. */
  test("any drawn column can be filtered, and a column the list does not carry cannot", () => {
    assert.equal(queryRows(spec, ROWS, Q({ cf: { item: { in: ["Toluene"] } } }), FLAGS).list.length, 2);
    assert.equal(queryRows(spec, ROWS, Q({ cf: { secret: { in: ["x"] } } }), FLAGS).list.length, 4);
  });
});

describe("what the ticked rows add up to", () => {
  const sspec: Pick<ListSpec, "selectSum"> = {
    selectSum: [
      { k: "qty", l: "litres", missing: "without a quantity" },
      { k: "no", l: "orders", one: "order", kind: "distinct" },
    ],
  };
  const rows = [...ROWS, { id: "e", v: { no: "1", item: "Mystery", qty: null, status: "Open", godown: "Vasai" }, flags: [] }];

  test("sums a number, counts the distinct values, and names the rows with none", () => {
    const r = selectionTotals(sspec, rows, ["a", "c", "e"]);
    assert.equal(r.counted, 3);
    assert.deepEqual(r.totals.map((t) => [t.v, t.l, t.missing]), [[17, "litres", 1], [1, "order", 0]]);
    assert.equal(selectionTotalText(r.totals[0]), "17 litres (1 without a quantity)");
    assert.equal(selectionTotalText(r.totals[1]), "1 order");
  });

  test("a ticked id the rows do not hold is not counted, and is said to be missing", () => {
    const r = selectionTotals(sspec, rows, ["a", "gone"]);
    assert.equal(r.counted, 1);
    assert.equal(r.totals[0].v, 10);
  });
});

test("a figure no ticked row carries reads as unknown, never as zero", () => {
  const r = selectionTotals({ selectSum: [{ k: "qty", l: "kg", missing: "without a weight" }] }, [{ id: "x", v: { qty: null }, flags: [] }, { id: "y", v: { qty: "" }, flags: [] }], ["x", "y"]);
  assert.equal(selectionTotalText(r.totals[0]), "— kg (all 2 without a weight)");
});

test("a group's print link carries every distinct value in the whole group, not just its page", () => {
  const spec = { screen: "t", cols: [{ k: "orderNo", l: "Order", t: "mono" }, { k: "tr", l: "Transporter", t: "t" }], groups: ["tr"], groupPrint: { k: "orderNo", l: "Print", href: "/erp/print-labels?orders=" } } as unknown as ListSpec;
  const rows = [
    { id: "a", v: { orderNo: "10089", tr: "Jignesh" }, flags: [] },
    { id: "b", v: { orderNo: "10089", tr: "Jignesh" }, flags: [] },
    { id: "c", v: { orderNo: "10102", tr: "MK" }, flags: [] },
    { id: "d", v: { orderNo: "10090", tr: "Jignesh" }, flags: [] },
  ] as ListRow[];
  const p = pageOf(spec, rows, Q({ grp: true, size: 1, page: 1 }), {});
  const g = Object.values(p.groups)[0];
  assert.equal(g.print, `/erp/print-labels?orders=${encodeURIComponent("10089,10090")}`);
  assert.equal(groupPrintHref({ ...spec, groupPrint: undefined }, rows), undefined);
});

describe("the figure cards", () => {
  test("a list that names none gets a Total, over what the filters reach and over everything", () => {
    const [total] = pageOf(spec, ROWS, Q({ gf: "Vasai" }), FLAGS).stats!;
    assert.equal(total.l, "Total");
    assert.equal(total.v, 2);
    assert.equal(total.base, 4);
    assert.equal(pageOf(spec, ROWS, Q({ gf: "Vasai" }), FLAGS).filtered, true);
    assert.equal(pageOf(spec, ROWS, Q(), FLAGS).filtered, false);
  });

  test("a card can count a flag, and tapping it is the flag filter", () => {
    const s2: ListSpec = { ...spec, stats: [{ l: "Late", where: { flag: "late" }, tone: "danger" }] };
    const [late] = pageOf(s2, ROWS, Q(), FLAGS).stats!;
    assert.equal(late.v, 1);
    assert.deepEqual(late.pick, { flag: "late" });
    assert.equal(late.share, 0.25);
    assert.equal(late.on, false);
    const p = pageOf(s2, ROWS, Q({ flag: "late" }), FLAGS);
    assert.equal(p.total, 1);
    assert.equal(p.stats![0].on, true);
    assert.deepEqual(parseListQuery(listQueryParams(Q({ flag: "late" }))).flag, "late");
  });

  test("a sum counts the rows without a value rather than adding them as zero", () => {
    const s2: ListSpec = { ...spec, stats: [{ l: "Qty", kind: "sum", k: "qty", missing: "without a quantity" }] };
    const rows = [...ROWS, { id: "e", v: { no: "4", item: "Mystery", qty: null, status: "Open", godown: "Vasai" }, flags: [] }];
    const [q] = pageOf(s2, rows, Q(), FLAGS).stats!;
    assert.equal(q.v, 23);
    assert.equal(q.missing, 1);
  });

  test("a card on a column the list does not carry — one a power withholds — is not drawn", () => {
    const s2: ListSpec = { ...spec, stats: [{ l: "Value", kind: "sum", k: "value" }, { l: "Open", where: { k: "status", in: ["Open"] } }] };
    const st = pageOf(s2, ROWS, Q(), FLAGS).stats!;
    assert.deepEqual(st.map((x) => x.l), ["Open"]);
    /* One value of the chips column: tapping it is the chip. */
    assert.deepEqual(st[0].pick, { chip: "Open" });
  });
});

describe("the Filters pop-up", () => {
  test("a section counts its values over the rows every OTHER filter leaves", () => {
    const s2: ListSpec = { ...spec, filters: ["item", "qty"] };
    const panel = pageOf(s2, ROWS, Q({ cf: { item: { in: ["Toluene"] } } }), FLAGS).panel!;
    const item = panel.find((x) => x.k === "item");
    assert.ok(item && item.kind === "list");
    assert.deepEqual(item.opts, [{ v: "Acetone", n: 1 }, { v: "Toluene", n: 2 }, { v: "Xylene", n: 1 }]);
    const qty = panel.find((x) => x.k === "qty");
    assert.ok(qty && qty.kind === "range");
    assert.deepEqual([qty.lo, qty.hi], [1, 10]);
  });

  test("found for itself, it skips a column that is a name per row, the chips and the godown — and offers a from–to on what it adds up", () => {
    const panel = pageOf(spec, ROWS, Q(), FLAGS).panel!;
    assert.deepEqual(panel.map((x) => x.k), ["qty"]);
    const many = Array.from({ length: 20 }, (_, i) => row(`r${i}`, String(i), i % 2 ? "Toluene" : "Xylene", i, "Open", "Vasai"));
    assert.deepEqual(pageOf(spec, many, Q(), FLAGS).panel!.map((x) => x.k), ["item", "qty"]);
  });
});
