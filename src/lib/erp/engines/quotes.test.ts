import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCell, cleanRate, columnStats, parseQuoteDate, parseTsv, quoteStatusRefusal, validQuoteId, newQuoteId } from "./quotes";
import { applySheetOps, invertSheetOps, visibleColumns, visibleRows, type SheetOp, type SheetState } from "./quote-sheet";

test("a rate is a number, with the commas and rupee sign a paste carries taken out", () => {
  assert.deepEqual(cleanRate(" 1,48.75 "), { ok: true, value: "148.75" });
  assert.deepEqual(cleanRate("₹130"), { ok: true, value: "130" });
  assert.deepEqual(cleanRate(".5"), { ok: true, value: "0.5" });
  assert.deepEqual(cleanRate(""), { ok: true, value: "" });
  assert.equal(cleanRate("abc").ok, false);
  assert.equal(cleanRate("12.5.1").ok, false);
  assert.deepEqual(cleanCell("text", "  Mitesh   Mehta "), { ok: true, value: "Mitesh Mehta" });
});

test("dates are read as the sheet writes them, day first unless that cannot be", () => {
  assert.equal(parseQuoteDate("22-Aug-2026"), "2026-08-22");
  assert.equal(parseQuoteDate("1-Sep-2026"), "2026-09-01");
  assert.equal(parseQuoteDate("10/14/2026"), "2026-10-14");
  assert.equal(parseQuoteDate("14/10/2026"), "2026-10-14");
  assert.equal(parseQuoteDate("03/10/2026"), "2026-10-03");
  assert.equal(parseQuoteDate("2026-10-15"), "2026-10-15");
  assert.equal(parseQuoteDate("15 Oct 26"), "2026-10-15");
  assert.equal(parseQuoteDate("31-Feb-2026"), null);
  assert.equal(parseQuoteDate("soon"), null);
});

test("a pasted block is split into rows and cells, quotes included", () => {
  assert.deepEqual(parseTsv("a\tb\n1\t2\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseTsv('"x\ny"\t3'), [["x\ny", "3"]]);
  assert.deepEqual(parseTsv("a\t\tc"), [["a", "", "c"]]);
});

test("ids minted on the screen are ids the server accepts", () => {
  assert.ok(validQuoteId("eqr", newQuoteId("eqr")));
  assert.ok(validQuoteId("eqc", newQuoteId("eqc")));
  assert.ok(!validQuoteId("eqr", "eqr_x"));
  assert.ok(!validQuoteId("eqr", "eqr_'; drop"));
});

test("the latest and lowest rate leave cancelled rates out", () => {
  const rows = [
    { id: "1", date: "2026-09-01", status: null, cells: { c: { value: "131", status: null } } },
    { id: "2", date: "2026-09-09", status: null, cells: { c: { value: "128", status: "cancel" as const } } },
    { id: "3", date: "2026-10-01", status: "cancel" as const, cells: { c: { value: "100", status: null } } },
    { id: "4", date: "2026-10-03", status: null, cells: { c: { value: "133", status: "po" as const } } },
  ];
  const s = columnStats(rows, "c");
  assert.equal(s.latest, "133");
  assert.equal(s.lowest, 131);
  assert.equal(s.count, 2);
});

const base = (): SheetState => ({
  columns: [
    { id: "c1", pack: "185 KG", name: "Butyl", brand: "Mahek", kind: "rate", rawMaterialId: null, archived: false },
    { id: "c2", pack: "", name: "Broker", brand: "", kind: "text", rawMaterialId: null, archived: false },
  ],
  rows: [{ id: "r1", date: "2026-10-01", party: "Garnet", status: null, seq: 0, deleted: false, cells: { c1: { value: "48.5", status: null, drums: null, poNo: null, poBy: null, poAt: null } } }],
});

test("every change is undone by its inverse, whatever it touched", () => {
  const ops: SheetOp[] = [
    { op: "row", rowId: "r2", create: true, date: "2026-09-01", party: "Saraswati" },
    { op: "cell", rowId: "r2", columnId: "c1", value: "130" },
    { op: "cell", rowId: "r1", columnId: "c1", value: "49", status: "po" },
    { op: "cell", rowId: "r1", columnId: "c1", value: "50" },
    { op: "row", rowId: "r1", party: "Garnet Chemicals", status: "pickup" },
    { op: "column", columnId: "c3", create: true, name: "EA" },
    { op: "order", columnIds: ["c3", "c2", "c1"] },
    { op: "column", columnId: "c1", name: "Butyl Acetate", kind: "text" },
    { op: "archiveColumn", columnId: "c2" },
  ];
  const s0 = base();
  const s1 = applySheetOps(s0, ops);
  assert.equal(visibleRows(s1)[0].party, "Saraswati");
  assert.deepEqual(visibleColumns(s1).map((c) => c.id), ["c3", "c1"]);
  assert.deepEqual(s1.rows[0].cells.c1, { value: "50", status: "po", drums: null, poNo: null, poBy: null, poAt: null });

  const back = applySheetOps(s1, invertSheetOps(s0, ops));
  assert.deepEqual(visibleRows(back).map((r) => r.id), ["r1"]);
  assert.deepEqual(back.rows.find((r) => r.id === "r1"), s0.rows[0]);
  assert.deepEqual(visibleColumns(back).map((c) => [c.id, c.name, c.kind]), [["c1", "Butyl", "rate"], ["c2", "Broker", "text"]]);
});

test("deleting a row hides it and undoing brings it back with its cells", () => {
  const s0 = base();
  const ops: SheetOp[] = [{ op: "deleteRow", rowId: "r1" }];
  const s1 = applySheetOps(s0, ops);
  assert.equal(visibleRows(s1).length, 0);
  const back = applySheetOps(s1, invertSheetOps(s0, ops));
  assert.deepEqual(visibleRows(back)[0].cells.c1, { value: "48.5", status: null, drums: null, poNo: null, poBy: null, poAt: null });
});

test("a rate is bought only once a manager has marked it Ready to buy, and never without drums and a PO", () => {
  const buy = { status: "po" as const, drums: 4, poNo: "PO-118" };
  assert.equal(quoteStatusRefusal(null, { status: "ready", drums: null, poNo: null }, false) !== null, true);
  assert.equal(quoteStatusRefusal(null, { status: "ready", drums: null, poNo: null }, true), null);
  assert.equal(quoteStatusRefusal("ready", buy, false), null);
  assert.match(quoteStatusRefusal(null, buy, false)!, /Ready to buy/);
  assert.equal(quoteStatusRefusal(null, buy, true), null);
  assert.match(quoteStatusRefusal("ready", { ...buy, drums: 0 }, false)!, /drums/);
  assert.match(quoteStatusRefusal("ready", { ...buy, poNo: " " }, false)!, /PO number/);
  assert.equal(quoteStatusRefusal("po", { status: "ready", drums: 4, poNo: "PO-118" }, false), null, "undoing a purchase is anybody's");
  assert.match(quoteStatusRefusal("po", { status: null, drums: 4, poNo: "PO-118" }, false)!, /manager/);
  assert.match(quoteStatusRefusal("ready", { status: null, drums: null, poNo: null }, false)!, /manager/);
  assert.equal(quoteStatusRefusal(null, { status: "pickup", drums: null, poNo: null }, false), null);
});

test("undoing a purchase puts back the drums and PO number it replaced", () => {
  const s0 = base();
  s0.rows[0].cells.c1.status = "ready";
  const ops: SheetOp[] = [{ op: "cell", rowId: "r1", columnId: "c1", status: "po", drums: 4, poNo: "PO-1", poBy: "Me", poAt: "2026-10-16T10:00:00Z" }];
  const s1 = applySheetOps(s0, ops);
  assert.equal(s1.rows[0].cells.c1.poNo, "PO-1");
  const back = applySheetOps(s1, invertSheetOps(s0, ops));
  assert.deepEqual(back.rows[0].cells.c1, s0.rows[0].cells.c1);
});
