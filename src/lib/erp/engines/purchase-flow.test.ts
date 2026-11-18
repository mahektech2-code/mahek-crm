import test from "node:test";
import assert from "node:assert/strict";
import {
  FLOW_STEPS,
  poStatusAfterReceipt,
  poTotals,
  purchaseUnit,
  expectedQuantity,
  receiptGap,
  correctionFor,
  lineDone,
  quantityDifferenceNote,
  requirementStage,
  type RequirementState,
} from "./purchase-flow";

/* The purchase flow's rules, pinned:
   Requirement → Purchase method → PO number → Receipt. */

const base: RequirementState = {
  status: "Pending",
  rule: "direct",
  method: "direct",
  supplierId: null,
  po: null,
  legacy: false,
};

test("once counted, the item's purchase rule decides: Quotation links the Quotation manager's PO number, Direct creates one", () => {
  const direct = requirementStage(base);
  assert.equal(direct.stage, "Create PO");
  assert.equal(FLOW_STEPS[direct.step], "Purchase method");
  assert.equal(FLOW_STEPS[direct.step + 1], "PO number");
  assert.equal(direct.readyForPo, true, "no quotation is needed for a direct purchase");
  const quote = requirementStage({ ...base, rule: "quotation", method: "quotation" });
  assert.equal(quote.stage, "Waiting for PO number");
  assert.equal(quote.readyForPo, false, "a quotation item is bought on the Quotation manager, not created here");
  const buyer = requirementStage({ ...base, rule: "buyer", method: null });
  assert.equal(buyer.stage, "Create or link PO");
  assert.equal(buyer.readyForPo, true);
});

test("the route follows the decided method over the rule", async () => {
  const { poRouteOf } = await import("./purchase-flow");
  assert.equal(poRouteOf({ rule: "quotation", method: null }), "link");
  assert.equal(poRouteOf({ rule: "direct", method: null }), "create");
  assert.equal(poRouteOf({ rule: "buyer", method: null }), "either");
  assert.equal(poRouteOf({ rule: "buyer", method: "quotation" }), "link");
  assert.equal(poRouteOf({ rule: "quotation", method: "direct" }), "create");
});

test("the PO drives the rest: receipt, and an old PO's approval", () => {
  const on = (status: string, received = 0) => requirementStage({ ...base, supplierId: "s1", po: { status, ordered: 100, received } });
  assert.equal(on("Pending approval").stage, "PO awaiting approval");
  assert.equal(on("Approved").stage, "Waiting for goods");
  assert.equal(on("Sent").stage, "Waiting for goods");
  assert.equal(FLOW_STEPS[on("Sent").step], "Receipt");
  assert.equal(on("Partly received", 40).stage, "Partly received");
  assert.equal(on("Received", 100).step, FLOW_STEPS.length);
  assert.equal(on("Closed", 40).stage, "Closed short");
  assert.equal(requirementStage({ ...base, status: "Cancelled" }).step, -1);
});

test("a PO's status follows what was received, and only in the receiving states", () => {
  assert.equal(poStatusAfterReceipt("Sent", [{ ordered: 10, received: 4 }]), "Partly received");
  assert.equal(poStatusAfterReceipt("Approved", [{ ordered: 10, received: 10 }, { ordered: 5, received: 6 }]), "Received");
  assert.equal(poStatusAfterReceipt("Approved", [{ ordered: 10, received: 0 }]), "Approved");
  assert.equal(poStatusAfterReceipt("Pending approval", [{ ordered: 10, received: 10 }]), "Pending approval");
  assert.equal(poStatusAfterReceipt("Closed", [{ ordered: 10, received: 3 }]), "Closed");
});

test("PO totals add GST per line and freight once", () => {
  const t = poTotals([{ quantity: 10, ratePaise: 10000, gstBp: 1800 }, { quantity: 2, ratePaise: 5000, gstBp: 1200 }], 50000);
  assert.deepEqual(t, { amountPaise: 110000, gstPaise: 19200, freightPaise: 50000, roundOffPaise: 0, totalPaise: 179200 });
  /* ₹1,234.56 of goods at 18% is ₹1,456.78: the PO says ₹1,457, with 22 paise of round off. */
  const r = poTotals([{ quantity: 1, ratePaise: 123456, gstBp: 1800 }], 0);
  assert.deepEqual([r.totalPaise, r.roundOffPaise], [145700, 22]);
  assert.equal(r.amountPaise + r.gstPaise + r.roundOffPaise, r.totalPaise, "the parts still add up to the total");
});

test("an item is bought in its own unit: boxes and units are pieces", () => {
  assert.equal(purchaseUnit("Kg", "Chemical"), "Kg");
  assert.equal(purchaseUnit("Litre", "Chemical"), "Litre");
  assert.equal(purchaseUnit("Unit", "Can"), "Pcs");
  assert.equal(purchaseUnit("Kg", "Box"), "Pcs");
});

test("a name two categories share is picked with its category; every other item by its name", async () => {
  const { itemPickLabels } = await import("./purchase-flow");
  const labels = [...itemPickLabels([
    { name: "Toluene", materialType: "Chemical" },
    { name: "Label", materialType: "Box" },
    { name: "Label", materialType: "Stationary" },
  ]).keys()];
  assert.deepEqual(labels, ["Toluene", "Label · Box", "Label · Stationary"]);
});

test("a pasted list: the last number is the quantity, names match exactly or uniquely, the rest is said back", async () => {
  const { parsePastedLines } = await import("./purchase-flow");
  const labels = ["Toluene", "MEK", "Tin can 5L", "Tin can 20L", "Label · Box"];
  const r = parsePastedLines(
    ["toluene, 200", "MEK\t50.5", "Tin can 5L 120 pcs", "", "tin can 2", "label", "Acetone 10", "MEK 3"].join("\n"),
    labels,
  );
  assert.deepEqual(r.lines, [
    { item: "Toluene", qty: "200" },
    { item: "MEK", qty: "50.5" },
    { item: "Tin can 5L", qty: "120" },
    { item: "Label · Box", qty: "" },
  ]);
  /* "tin can" fits two cans, "Acetone" fits nothing: neither is guessed. */
  assert.deepEqual(r.unmatched, ["tin can 2", "Acetone 10"]);
  assert.deepEqual(r.duplicates, ["MEK"]);
  assert.deepEqual(parsePastedLines("Toluene 5", labels, ["Toluene"]).duplicates, ["Toluene"]);
});

test("there is no count in the flow: a requirement goes straight to its purchase method", () => {
  assert.deepEqual([...FLOW_STEPS], ["Requirement", "Purchase method", "PO number", "Receipt"]);
  for (const step of ["Blind count", "Book comparison", "Verification"]) assert.ok(!(FLOW_STEPS as readonly string[]).includes(step), `${step} is not a step`);
  const raised = requirementStage(base);
  assert.equal(FLOW_STEPS[raised.step], "Purchase method");
  assert.notEqual(raised.stage, "Blind count");
});

test("a PO number picks the bought cell for this item, or says why not", async () => {
  const { pickQuotePoCell, normalisePoNo, quoteRatePaise } = await import("./purchase-flow");
  const cell = (o: Record<string, unknown> = {}) => ({
    rowId: "r1", columnId: "c1", materialId: "tol", material: "Drum · Toluene · Reliance", party: "Shree Krishna",
    supplierId: "s1", value: "89.5", status: "po", rowStatus: null, drums: 3, poNo: "MM/PO/1", quotedOn: "2026-10-15",
    boughtBy: "Vikram", boughtAt: "2026-10-17T05:00:00Z", ...o,
  });
  assert.equal(normalisePoNo("  mm/po/2627/121 "), "MM/PO/2627/121");
  assert.equal(quoteRatePaise("₹ 89.50/kg"), 8950);
  assert.equal(quoteRatePaise("1,250"), 125000);
  assert.equal(quoteRatePaise("ask"), null);
  const ok = pickQuotePoCell([cell()], "tol", "Toluene", "MM/PO/1");
  assert.ok(ok.ok && ok.ratePaise === 8950);
  const none = pickQuotePoCell([], "tol", "Toluene", "MM/PO/9");
  assert.ok(!none.ok && /No PO numbered MM\/PO\/9/.test(none.error));
  const other = pickQuotePoCell([cell({ materialId: "xyl", material: "Drum · Xylene · IOCL" })], "tol", "Toluene", "MM/PO/1");
  assert.ok(!other.ok && /for Drum · Xylene · IOCL — not Toluene/.test(other.error));
  const ready = pickQuotePoCell([cell({ status: "ready" })], "tol", "Toluene", "MM/PO/1");
  assert.ok(!ready.ok, "a rate only marked Ready to buy has not been bought");
  const cancelled = pickQuotePoCell([cell({ rowStatus: "cancel" })], "tol", "Toluene", "MM/PO/1");
  assert.ok(!cancelled.ok && /cancelled/.test(cancelled.error));
  const noParty = pickQuotePoCell([cell({ supplierId: null })], "tol", "Toluene", "MM/PO/1");
  assert.ok(!noParty.ok && /not one of the Purchase parties/.test(noParty.error));
  const badRate = pickQuotePoCell([cell({ value: "tbd" })], "tol", "Toluene", "MM/PO/1");
  assert.ok(!badRate.ok && /not a number/.test(badRate.error));
  const newest = pickQuotePoCell([cell({ value: "80", boughtAt: "2026-10-01" }), cell({ value: "90", boughtAt: "2026-10-16" })], "tol", "Toluene", "MM/PO/1");
  assert.ok(newest.ok && newest.ratePaise === 9000, "the newest purchase of the item on one PO number");
});

test("a PO number the Quotation manager made is the ERP's own number; a typed one is not", async () => {
  const { seriesNumberOf, poLabel } = await import("./purchase-flow");
  assert.equal(seriesNumberOf(poLabel(1243)), 1243);
  assert.equal(seriesNumberOf(" po-77 "), 77);
  assert.equal(seriesNumberOf("MM/PO/2627/121"), null);
});

test("the GRN corrects the PO: an extra is added, a shortfall only when nothing more is coming", () => {
  assert.equal(expectedQuantity(1000, [{ quantity: 150 }, { quantity: -40, cancelled: true }]), 1150);
  assert.deepEqual(receiptGap(1000, 0, 1150), { kind: "more", quantity: 150 });
  assert.deepEqual(receiptGap(1000, 0, 800), { kind: "less", quantity: 200 });
  assert.deepEqual(receiptGap(1000, 600, 400), { kind: "exact", quantity: 0 });
  /* A line already complete takes a late truck whole, as an extra. */
  assert.deepEqual(receiptGap(800, 800, 200), { kind: "more", quantity: 200 });
  const yes = { addExtra: true, nothingMoreComing: true };
  assert.deepEqual(correctionFor(receiptGap(1000, 0, 1150), yes), { kind: "extra", quantity: 150 });
  assert.deepEqual(correctionFor(receiptGap(1000, 0, 800), yes), { kind: "short", quantity: -200 });
  assert.equal(correctionFor(receiptGap(1000, 0, 800), { addExtra: true, nothingMoreComing: false }), null, "more is coming: the line stays open");
  assert.equal(correctionFor(receiptGap(1000, 0, 1150), { addExtra: false, nothingMoreComing: false }), null);
  assert.equal(lineDone({ ordered: 800, received: 800 }), true);
  assert.equal(lineDone({ ordered: 1000, received: 800 }), false);
  assert.equal(poStatusAfterReceipt("Sent", [{ ordered: 1150, received: 1150 }]), "Received");
  assert.equal(poStatusAfterReceipt("Sent", [{ ordered: 1000, received: 800 }]), "Partly received");
  assert.equal(poStatusAfterReceipt("Approved", [{ ordered: 10, received: 0 }]), "Approved");
});

test("a correction beyond the flag percent is pointed out, either way", () => {
  assert.equal(quantityDifferenceNote(1000, 1150, 1150, 10), "15% more than ordered");
  assert.equal(quantityDifferenceNote(1000, 800, 800, 10), "20% less than ordered");
  assert.equal(quantityDifferenceNote(1000, 950, 950, 10), null, "within 10%");
  assert.equal(quantityDifferenceNote(1000, 1000, 1200, 10), "20% more than ordered", "an extra received without a correction counts too");
  assert.equal(quantityDifferenceNote(1000, 1000, 800, 10), null, "still open, more is coming");
});

test("the GRN line asks about the extra only when more arrived, and whether more is coming only when less did", async () => {
  await import("../calcs");
  const { whenHolds } = await import("../ui");
  const { runCalc } = await import("../calc");
  const data = { pendingQtyOf: { "PO-1243 · Shree|1. Toluene": 1000 }, rateOf: { "PO-1243 · Shree|1. Toluene": "₹89.50 per kg" }, unitOf: { Toluene: "Kg" } };
  const line = (qty: string) => ({ po: "PO-1243 · Shree", poLine: "1. Toluene", item: "Toluene", qty });
  assert.equal(whenHolds({ calc: "inward.isMore" }, line("1150"), data), true);
  assert.equal(whenHolds({ calc: "inward.isLess" }, line("1150"), data), false);
  assert.equal(whenHolds({ calc: "inward.isLess" }, line("800"), data), true);
  assert.equal(whenHolds({ calc: "inward.gap" }, line("1000"), data), false, "exactly as ordered asks nothing");
  assert.match(runCalc("inward.diff", { h: {}, l: line("1150"), lines: [], i: 0, data }), /^150 Kg more than PO-1243 .*₹89\.50 per kg/);
  /* A kg chemical is read off the scale: 6 drums, 1,247.8 kg with drums, 16.3 kg each. */
  assert.equal(whenHolds({ calc: "inward.isMore" }, { ...line(""), drums: "6", weight: "1247.8", emptyDrum: "16.3" }, data), true);
});
