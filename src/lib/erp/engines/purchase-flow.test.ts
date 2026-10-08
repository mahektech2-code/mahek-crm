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
   Requirement → Purchase method → Vendor / quotation → Approval → PO → Receipt. */

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

test("direct purchase: select the vendor, then the PO", () => {
  assert.equal(requirementStage(base).stage, "Select vendor");
  const ready = requirementStage({ ...base, supplierId: "s1" });
  assert.equal(ready.stage, "Ready for PO");
  assert.equal(ready.readyForPo, true);
  assert.equal(FLOW_STEPS[ready.step], "Approval");
});

test("quotation: collect until the minimum, compare, then select — and only then a PO", () => {
  const q = { ...base, rule: "quotation" as const, method: "quotation" as const };
  assert.equal(requirementStage({ ...q, quoteCount: 1 }).stage, "Collect quotations");
  assert.equal(requirementStage({ ...q, quoteCount: 2 }).stage, "Compare quotations");
  /* A vendor without a selected quotation is not ready: the rule says a quotation is required. */
  assert.equal(requirementStage({ ...q, quoteCount: 2, supplierId: "s1" }).readyForPo, false);
  assert.equal(requirementStage({ ...q, quoteCount: 2, supplierId: "s1", quotationId: "q1" }).stage, "Ready for PO");
});

test("buyer decision waits on the buyer, and nothing can be ordered meanwhile", () => {
  const s = requirementStage({ ...base, rule: "buyer", method: null, supplierId: "s1" });
  assert.equal(s.stage, "Buyer decision");
  assert.equal(FLOW_STEPS[s.step], "Purchase method");
  assert.equal(s.readyForPo, false);
});

test("the PO drives the rest: approval, sending, receipt", () => {
  const on = (status: string, received = 0) => requirementStage({ ...base, supplierId: "s1", po: { status, ordered: 100, received } });
  assert.equal(on("Pending approval").stage, "PO awaiting approval");
  assert.equal(on("Approved").stage, "PO approved");
  assert.equal(on("Sent").stage, "PO sent");
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
