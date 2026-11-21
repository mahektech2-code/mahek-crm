/**
 * Which tick each Purchase action needs (`action-ticks.ts`), pure.
 *
 *   npm run test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTicks, holdsTick, menuBlock, PURCHASE_TICKS, quoteOpTick, tickFor, tickWhy } from "./action-ticks";
import type { ListRow, ListSpec } from "./ui";

const ticks = (m: Record<string, [boolean, boolean]>) => ({ administrator: false, ticks: new Map(Object.entries(m).map(([k, [edit, del]]) => [k, { edit, delete: del }])) });

test("an unconverted grant and an administrator hold every tick", () => {
  assert.ok(holdsTick({ administrator: false }, "requisitions", "delete"));
  assert.ok(holdsTick({ administrator: true, ticks: new Map() }, "requisitions", "delete"));
  assert.ok(holdsTick(ticks({}), "requisitions", undefined), "an act that names no tick needs Access only");
});

test("a converted grant holds exactly the ticks it was given, page by page", () => {
  const p = ticks({ requisitions: [true, false], register: [true, true] });
  assert.ok(holdsTick(p, "requisitions", "edit"));
  assert.equal(holdsTick(p, "requisitions", "delete"), false);
  assert.ok(holdsTick(p, "register", "delete"));
  assert.equal(holdsTick(p, "purchaseOrders", "edit"), false, "a page not listed holds no tick");
});

test("the table names the destructive acts as Delete and the changes as Edit", () => {
  assert.equal(tickFor("requisitions", "actions", "cancel"), "delete");
  assert.equal(tickFor("requisitions", "actions", "linkPo"), "edit");
  assert.equal(tickFor("purchaseOrders", "actions", "cancel"), "delete");
  assert.equal(tickFor("purchaseOrders", "actions", "share"), "edit");
  assert.equal(tickFor("inward", "actions", "void"), "delete");
  assert.equal(tickFor("inward", "forms", "new"), undefined, "receiving goods is Access");
  assert.equal(tickFor("testing", "actions", "verify"), "edit");
  assert.equal(tickFor("register", "actions", "reopen"), "delete");
  assert.equal(tickFor("register", "bulk", "verifyMany"), "edit");
  assert.equal(PURCHASE_TICKS.barcode, undefined, "Drum labels is print-only");
  assert.match(tickWhy("inward", "delete"), /^Needs Delete on Goods in/);
});

test("a list hides what the person cannot do, and keeps it locked with the reason for the record", () => {
  const spec = { cols: [], bulk: [{ id: "billReceived", l: "Bill received" }, { id: "reopen", l: "Back to pending" }] } as unknown as ListSpec;
  const rows = [{ id: "r1", v: {}, actions: [{ id: "edit", l: "Edit", loadsForm: true }, { id: "void", l: "Void" }, { id: "trace", l: "Trace" }] }] as unknown as ListRow[];
  const out = applyTicks(ticks({ register: [true, false] }), "register", { spec, rows });
  const [edit, voided, trace] = out.rows[0].actions!;
  assert.equal(edit.tickHidden, undefined, "Edit held");
  assert.equal(voided.tickHidden, true);
  assert.match(voided.why!, /Needs Delete on Bills/);
  assert.equal(trace.tickHidden, undefined, "an ordinary act is untouched");
  assert.deepEqual(out.spec.bulk!.map((b) => b.id), ["billReceived"], "a bulk act without its tick is removed");
  assert.equal(applyTicks({ administrator: false }, "register", { spec, rows }).rows, rows, "unconverted: nothing changes");
});

test("on the Quotation manager every change is Edit and taking something back is Delete", () => {
  assert.equal(quoteOpTick({ op: "cell" }), "edit");
  assert.equal(quoteOpTick({ op: "row" }), "edit");
  assert.equal(quoteOpTick({ op: "column" }), "edit");
  assert.equal(quoteOpTick({ op: "deleteRow" }), "delete");
  assert.equal(quoteOpTick({ op: "archiveColumn" }), "delete");
  assert.equal(quoteOpTick({ op: "cell", impact: { typed: "x" } }), "delete", "undoing a bought rate");
});

test("a Purchase row's menu is ordered by the tick each act needs: ordinary, changes, take-backs", () => {
  assert.equal(menuBlock("requisitions", { id: "openPo" }), 0, "opening its PO is ordinary work");
  assert.equal(menuBlock("requisitions", { id: "edit", loadsForm: true }), 1);
  assert.equal(menuBlock("requisitions", { id: "createPo" }), 1);
  assert.equal(menuBlock("requisitions", { id: "cancel" }), 2);
  assert.equal(menuBlock("purchaseOrders", { id: "receive", loadsForm: true }), 0, "receiving goods is Access");
  assert.equal(menuBlock("register", { id: "reopen" }), 2);
  assert.equal(menuBlock("barcode", { id: "label" }), 0);
  assert.equal(tickFor("requisitions", "bulk", "createOnePo"), "edit", "Create one PO is Create PO for several");
});

test("Purchase orders and Goods in (Phase 4): receiving is Access, changing a PO is Edit, taking one back Delete", () => {
  for (const f of ["receive", "receiveAll", "new"]) assert.equal(tickFor("inward", "forms", f), undefined, `Goods in's ${f} is Access`);
  assert.equal(tickFor("inward", "actions", "trace"), undefined, "Trace this lot is Access");
  assert.equal(tickFor("purchaseOrders", "actions", "receive"), undefined, "Receive goods on a PO is Access");
  assert.equal(tickFor("purchaseOrders", "actions", "print"), undefined);
  assert.equal(tickFor("purchaseOrders", "actions", "close"), "edit");
  assert.equal(tickFor("purchaseOrders", "actions", "correctionRate"), "edit");
  assert.equal(tickFor("purchaseOrders", "actions", "cancelCorrection"), "delete");
  /* The row's menu: Receive in the first block, Edit / Share / Close short in the middle, Cancel last. */
  assert.equal(menuBlock("purchaseOrders", { id: "receive", loadsForm: true }), 0);
  assert.equal(menuBlock("purchaseOrders", { id: "edit", loadsForm: true }), 1);
  assert.equal(menuBlock("purchaseOrders", { id: "cancel" }), 2);
  assert.equal(menuBlock("inward", { id: "receiveAll", loadsForm: true }), 0);
  assert.equal(menuBlock("inward", { id: "void" }), 2);
});

test("Lot testing, Bills and Drum labels: what each new act needs", () => {
  /* Lot testing: recording a test on a To test row is the department's ordinary work; deciding it is the verifier's change. */
  assert.equal(menuBlock("testing", { id: "record", loadsForm: true }), 0, "Record test is Access");
  assert.equal(menuBlock("testing", { id: "edit", loadsForm: true }), 0, "Record evidence is Access");
  assert.equal(menuBlock("testing", { id: "addLot", loadsForm: true }), 0);
  assert.equal(menuBlock("testing", { id: "verify" }), 1);
  assert.equal(menuBlock("testing", { id: "unverify" }), 1);
  /* Bills: open-the-lot work, then the changes, then the take-backs — the design's menu. */
  for (const a of ["trace", "inquiry", "label", "aiBillRead"]) assert.equal(menuBlock("register", { id: a }), 0, a);
  for (const a of ["rate", "billReceived", "billNotReceived", "status"]) assert.equal(menuBlock("register", { id: a }), 1, a);
  assert.equal(menuBlock("register", { id: "edit", loadsForm: true }), 1);
  assert.equal(menuBlock("register", { id: "aiBill", loadsForm: true }), 1);
  assert.equal(menuBlock("register", { id: "void" }), 2);
  /* Record bill for n lots is the bulk Record the bill, so it needs Edit on Bills. */
  assert.equal(tickFor("register", "bulk", "billReceived"), "edit");
  /* Drum labels is print-only: printing a lot, printing the ticked lots and tracing are Access. */
  assert.equal(PURCHASE_TICKS.barcode, undefined);
  assert.equal(tickFor("barcode", "bulk", "print"), undefined);
  assert.equal(menuBlock("barcode", { id: "trace" }), 0);
});
