import { test } from "node:test";
import assert from "node:assert/strict";
import { bulkOffers } from "./bulk-fit";
import type { BulkSpec, ListRow } from "./ui";

const BULK: BulkSpec[] = [
  { id: "verifyOrder", l: "Verify order" },
  { id: "unverifyOrder", l: "Undo verification" },
  { id: "ready", l: "Ready" },
  { id: "bill", l: "Bill together" },
  { id: "printInvoices", l: "Print invoices", client: "printInvoices", fits: "invoiceFile" },
  { id: "export", l: "Export", fits: false },
];
const row = (id: string, actions: ListRow["actions"]): ListRow => ({ id, v: {}, flags: [], actions });
const verified = row("a", [{ id: "unverifyOrder", l: "Undo verification" }, { id: "ready", l: "Ready" }, { id: "bill", l: "Bill it", why: "Needs Ready" }]);
const fresh = row("b", [{ id: "verifyOrder", l: "Verify order" }, { id: "ready", l: "Ready", why: "Not verified yet" }]);
const billed = row("c", [{ id: "unverifyOrder", l: "Undo verification" }, { id: "invoiceFile", l: "Add invoice PDF" }]);
const labels = (rows: ListRow[], chosen: string[]) => bulkOffers(BULK, rows, chosen).map((o) => o.label);

test("one verified line is offered only what it can take", () => {
  assert.deepEqual(labels([verified, fresh, billed], ["a"]), ["Undo verification", "Ready", "Export"]);
});

test("a mixed selection is offered the union, with a count where it is not everybody", () => {
  assert.deepEqual(labels([verified, fresh, billed], ["a", "b", "c"]), [
    "Verify order · 1 of 3",
    "Undo verification · 2 of 3",
    "Ready · 1 of 3",
    "Print invoices · 1 of 3",
    "Export",
  ]);
});

test("a row this page does not hold hides nothing and stops the count", () => {
  assert.deepEqual(labels([verified], ["a", "zz"]), ["Undo verification", "Ready", "Export"]);
  assert.equal(bulkOffers(BULK, [], ["zz"]).length, BULK.length, "nothing in hand: everything is offered as before");
});

test("a row with no actions cannot be judged, so a screen that never fills them is unchanged", () => {
  assert.equal(bulkOffers(BULK, [row("x", undefined)], ["x"]).length, BULK.length);
});

test("a folded row is judged by its own actions", () => {
  const total: ListRow = { ...row("t", undefined), sub: [fresh] };
  assert.deepEqual(labels([total], ["b"]), ["Verify order", "Export"]);
});
