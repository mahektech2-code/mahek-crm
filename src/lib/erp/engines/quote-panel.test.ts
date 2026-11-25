import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cheapestByColumn,
  cheapestInMonth,
  latestByParty,
  packNet,
  packsFor,
  partyHistory,
  selectionFigures,
  sortRows,
  waitingBadge,
  waitingByColumn,
  type PanelRow,
} from "./quote-panel";

const row = (
  id: string,
  date: string,
  party: string,
  seq: number,
  cells: Record<string, string | [string, "cancel" | "po" | "ready"]>,
  status: PanelRow["status"] = null,
): PanelRow => ({
  id,
  date,
  party,
  seq,
  status,
  cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, Array.isArray(v) ? { value: v[0], status: v[1] } : { value: v, status: null }])),
});

const ROWS: PanelRow[] = [
  row("r1", "2026-11-02", "Shree Petrochem", 0, { bac: "121", tol: "91" }),
  row("r2", "2026-11-08", "Asian Solvents", 1, { bac: "117.5", tol: "88.5" }),
  row("r3", "2026-11-16", "Asian Solvents", 2, { bac: "119", tol: ["87.5", "cancel"] }),
  row("r4", "2026-11-19", "Shree Petrochem", 3, { bac: "121.5" }),
  row("r5", "2026-11-19", "Asian Solvents", 4, { bac: "118" }),
  row("r6", "2026-11-20", "Gujarat Solvents", 5, { bac: "123", tol: "75" }, "cancel"),
  row("r7", "2026-10-30", "Gujarat Solvents", 6, { bac: "110" }),
];

test("the cheapest in each column leaves cancelled rates out, and a lone rate is not cheapest", () => {
  const c = cheapestByColumn(ROWS, ["bac", "tol", "none"]);
  assert.equal(c.get("bac"), 110);
  /* 87.5 is cancelled and 75 sits on a cancelled row: 88.5 is the cheapest anybody would sell at. */
  assert.equal(c.get("tol"), 88.5);
  assert.equal(c.has("none"), false);
  assert.equal(cheapestByColumn([ROWS[0]], ["bac"]).has("bac"), false);
});

test("cheapest this month reads only the month of the day given", () => {
  /* October's 110 is cheaper, but it is not this month's. */
  assert.equal(cheapestInMonth(ROWS, "bac", 117.5, "2026-11-21"), true);
  assert.equal(cheapestInMonth(ROWS, "bac", 118, "2026-11-21"), false);
  assert.equal(cheapestInMonth(ROWS, "bac", 110, "2026-10-05"), false, "a month with one rate has nothing to be cheapest against");
});

test("each party's latest rate, cheapest first — an older quote is not a second entry", () => {
  const l = latestByParty(ROWS, "bac");
  assert.deepEqual(
    l.map((x) => [x.party, x.date, x.rate]),
    [
      ["Gujarat Solvents", "2026-10-30", 110],
      ["Asian Solvents", "2026-11-19", 118],
      ["Shree Petrochem", "2026-11-19", 121.5],
    ],
  );
  /* Gujarat's 20 Nov row is cancelled, so its October quote is its latest that counts. */
});

test("a party's history is its quotes oldest first, the last few, matched whatever the spacing or case", () => {
  const h = partyHistory(ROWS, "bac", "  asian   solvents ", 2);
  assert.deepEqual(
    h.map((x) => x.rowId),
    ["r3", "r5"],
  );
  assert.deepEqual(partyHistory(ROWS, "bac", "").length, 0);
});

test("a requirement waits on every column linked to its raw material", () => {
  const cols = [
    { id: "a", rawMaterialId: "rm_bac" },
    { id: "b", rawMaterialId: "rm_bac" },
    { id: "c", rawMaterialId: null },
    { id: "d", rawMaterialId: "rm_tol" },
  ];
  const w = waitingByColumn(cols, [
    { id: "q1", materialId: "rm_bac", reqNo: 13 },
    { id: "q2", materialId: "rm_mek", reqNo: 14 },
  ]);
  assert.deepEqual([...w.keys()], ["a", "b"]);
  assert.equal(waitingBadge(w.get("a")!), "REQ-13 waiting");
  assert.equal(waitingBadge([{ reqNo: 1 }, { reqNo: 2 }]), "2 requirements waiting");
  assert.equal(waitingBadge([]), null);
});

test("a selection's figures count only the rates in it", () => {
  assert.deepEqual(selectionFigures(["118", "121.5", "123", "", "Self"]), { count: 3, min: 118, avg: 120.83 });
  assert.deepEqual(selectionFigures(["", "x"]), { count: 0, min: null, avg: null });
});

test("the pack's net is read off the heading's top line, never guessed", () => {
  assert.deepEqual(packNet("185/180 KGS NET"), { qty: 185, unit: "Kg" });
  assert.deepEqual(packNet("195 KG NET"), { qty: 195, unit: "Kg" });
  assert.deepEqual(packNet("200 LITER"), { qty: 200, unit: "Litre" });
  assert.deepEqual(packNet("170 KGS"), { qty: 170, unit: "Kg" });
  assert.equal(packNet("Drum"), null);
  assert.equal(packNet(""), null);
  assert.equal(packsFor(1600, "Kg", "185/180 KGS NET"), 9);
  assert.equal(packsFor(1600, "Litre", "200 LITER"), 8);
  assert.equal(packsFor(1600, "Litre", "185/180 KGS NET"), null, "kilograms are not litres");
});

test("rows sort latest first by default; oldest, party and cheapest are views of the same rows", () => {
  const ids = (rs: PanelRow[]) => rs.map((r) => r.id);
  assert.deepEqual(ids(sortRows(ROWS, "latest")), ["r6", "r5", "r4", "r3", "r2", "r1", "r7"]);
  assert.deepEqual(ids(sortRows(ROWS, "oldest")), ["r7", "r1", "r2", "r3", "r4", "r5", "r6"]);
  assert.deepEqual(ids(sortRows(ROWS, "party")).slice(0, 4), ["r5", "r3", "r2", "r6"]);
  /* Rows without a rate in the column go last, latest first among themselves. */
  assert.deepEqual(ids(sortRows(ROWS, "cheapest", "tol")), ["r6", "r3", "r2", "r1", "r5", "r4", "r7"]);
});
