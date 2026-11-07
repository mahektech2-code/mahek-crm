import { test } from "node:test";
import assert from "node:assert/strict";
import { bulkOffers, narrowerOffers } from "./bulk-fit";
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

/* THE SHAPE OF A SELECTION: one PR's lines are offered the PR's own work, several PRs only what each line takes alone. */
const SHAPED: BulkSpec[] = [
  { id: "combined", l: "Combined view", client: "combinedView", fits: false },
  { id: "toTesting", l: "Send to Testing" },
  { id: "costs", l: "Transport & costs", same: ["pr"], asRow: true },
  { id: "billReceived", l: "Record the bill", same: ["party"] },
];
const line = (id: string, pr: string, party: string, actions: ListRow["actions"]): ListRow => ({ id, v: { pr, party }, flags: [], actions });
const p1a = line("1a", "101", "Acme", [{ id: "toTesting", l: "Send to Testing" }, { id: "costs", l: "Transport & costs" }, { id: "billReceived", l: "Record the bill" }]);
const p1b = line("1b", "101", "Acme", [{ id: "costs", l: "Transport & costs" }, { id: "billReceived", l: "Record the bill" }]);
const p2 = line("2", "102", "Acme", [{ id: "toTesting", l: "Send to Testing" }, { id: "costs", l: "Transport & costs" }, { id: "billReceived", l: "Record the bill" }]);
const other = line("3", "103", "Bharat", [{ id: "costs", l: "Transport & costs" }, { id: "billReceived", l: "Record the bill" }]);
const shaped = (chosen: string[], held = [p1a, p1b, p2, other]) => bulkOffers(SHAPED, held, chosen);

test("one PR's lines: the PR's own work, run once on a row that can take it", () => {
  const o = shaped(["1a", "1b"]);
  assert.deepEqual(o.map((x) => x.label), ["Combined view", "Send to Testing · 1 of 2", "Transport & costs", "Record the bill"]);
  assert.equal(o.find((x) => x.b.id === "costs")?.row?.id, "1a");
});

test("two PRs of one party: no once-per-PR work, but one bill still fits", () => {
  assert.deepEqual(shaped(["1a", "2"]).map((x) => x.label), ["Combined view", "Send to Testing", "Record the bill"]);
});

test("two parties: only what every line takes alone", () => {
  assert.deepEqual(shaped(["1a", "3"]).map((x) => x.label), ["Combined view", "Send to Testing · 1 of 2"]);
});

test("a row not in hand: a shaped bulk act is left to refuse for itself, a once-per-record act is never guessed", () => {
  assert.deepEqual(shaped(["1a", "zz"]).map((x) => x.b.id), ["combined", "toTesting", "billReceived"]);
});

test("what a narrower selection would add is said", () => {
  assert.deepEqual(narrowerOffers(SHAPED, [p1a, p1b, p2, other], ["1a", "3"]), [
    { same: ["pr"], l: "Transport & costs" },
    { same: ["party"], l: "Record the bill" },
  ]);
  assert.deepEqual(narrowerOffers(SHAPED, [p1a, p1b, p2, other], ["1a", "1b"]), []);
});
