import test from "node:test";
import assert from "node:assert/strict";
import {
  FLOW_STEPS,
  poStatusAfterReceipt,
  poTotals,
  purchaseUnit,
  rankQuotes,
  receivableQuantity,
  requirementStage,
  type RequirementState,
} from "./purchase-flow";

/* The purchase flow's rules, pinned:
   Requirement → Blind count → Book comparison → Verification → Purchase method → PO number → Receipt. */

const base: RequirementState = {
  status: "Pending",
  rule: "direct",
  method: "direct",
  supplierId: null,
  quotationId: null,
  quoteCount: 0,
  minQuotations: 2,
  po: null,
  legacy: false,
};

test("once counted, a requirement waits for the PO number the Quotation manager gives it", () => {
  const s = requirementStage(base);
  assert.equal(s.stage, "Waiting for PO number");
  assert.equal(FLOW_STEPS[s.step], "Purchase method");
  assert.equal(FLOW_STEPS[s.step + 1], "PO number");
  /* No vendor, quotation or buyer decision is asked for any more, whatever the item's rule. */
  assert.equal(requirementStage({ ...base, rule: "quotation", method: "quotation" }).stage, "Waiting for PO number");
  assert.equal(requirementStage({ ...base, rule: "buyer", method: null }).stage, "Waiting for PO number");
  /* Only a requirement whose vendor was chosen the old way can still go on the manual PO form. */
  assert.equal(s.readyForPo, false);
  assert.equal(requirementStage({ ...base, supplierId: "s1" }).readyForPo, true);
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

test("quotations are ranked by LANDED cost, and an expired one can never be the lowest", () => {
  const ranked = rankQuotes(
    [
      { id: "cheap-rate", ratePaise: 9000, gstBp: 1800, freightPaise: 300000, validUntil: null },
      { id: "landed-best", ratePaise: 9500, gstBp: 1800, freightPaise: 0, validUntil: "2026-12-31" },
      { id: "expired", ratePaise: 5000, gstBp: 1800, freightPaise: 0, validUntil: "2026-01-01" },
    ],
    100,
    "2026-10-06",
  );
  assert.deepEqual(ranked.map((q) => q.id), ["landed-best", "cheap-rate", "expired"]);
  assert.equal(ranked[0].lowest, true);
  assert.equal(ranked[0].fig.landedPaise, 1121000, "100 × ₹95 + 18% GST");
  assert.equal(ranked[1].fig.landedPaise, 1362000, "100 × ₹90 + 18% GST + ₹3,000 freight");
  assert.equal(ranked[2].lowest, false);
});

test("a PO's status follows what was received, and only in the receiving states", () => {
  assert.equal(poStatusAfterReceipt("Sent", [{ ordered: 10, received: 4 }]), "Partly received");
  assert.equal(poStatusAfterReceipt("Approved", [{ ordered: 10, received: 10 }, { ordered: 5, received: 6 }]), "Received");
  assert.equal(poStatusAfterReceipt("Approved", [{ ordered: 10, received: 0 }]), "Approved");
  assert.equal(poStatusAfterReceipt("Pending approval", [{ ordered: 10, received: 10 }]), "Pending approval");
  assert.equal(poStatusAfterReceipt("Closed", [{ ordered: 10, received: 3 }]), "Closed");
});

test("receipt tolerance is a share of what was ordered", () => {
  assert.equal(receivableQuantity(200, 0, 5), 210);
  assert.equal(receivableQuantity(200, 190, 5), 20);
  assert.equal(receivableQuantity(200, 215, 5), 0);
});

test("PO totals add GST per line and freight once", () => {
  const t = poTotals([{ quantity: 10, ratePaise: 10000, gstBp: 1800 }, { quantity: 2, ratePaise: 5000, gstBp: 1200 }], 50000);
  assert.deepEqual(t, { amountPaise: 110000, gstPaise: 19200, freightPaise: 50000, totalPaise: 179200 });
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

test("a requirement waiting for its blind count sits at that step, before the purchase method", () => {
  const held = requirementStage({ ...base, gate: { blocks: true, stage: "Blind count", next: "Count it." } });
  assert.equal(FLOW_STEPS[held.step], "Blind count");
  assert.equal(FLOW_STEPS[held.step + 1], "Book comparison");
  assert.equal(held.stage, "Blind count");
  assert.equal(held.readyForPo, false);
  const counted = requirementStage({ ...base, gate: { blocks: false, stage: null, next: null } });
  assert.deepEqual(counted, requirementStage(base), "once counted — matched or not — nothing changes");
  /* A PO already raised is never pulled back by a later count. */
  const onPo = requirementStage({ ...base, po: { status: "Sent", ordered: 10, received: 0 }, gate: { blocks: true, stage: "Blind count", next: null } });
  assert.equal(onPo.stage, "Waiting for goods");
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
