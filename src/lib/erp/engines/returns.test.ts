import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  approvalRefusal,
  approvalSteps,
  complaintCategoryFor,
  customerReturnRefusal,
  customerReturnStage,
  dispositionByLabel,
  dispositionRefusal,
  quarantineLeft,
  reasonByLabel,
  reasonLabel,
  returnCans,
  returnLitres,
  returnValue,
  returnableQty,
  reworkFigures,
  toStockQty,
  vendorReturnRefusal,
  vendorReturnStage,
} from "./returns";

describe("material returns — money", () => {
  it("values a return at rate less discount with GST on the rest", () => {
    assert.deepEqual(returnValue({ qty: 100, ratePaise: 15000, gstBp: 1800 }), {
      amountPaise: 1_500_000,
      discountPaise: 0,
      taxablePaise: 1_500_000,
      taxPaise: 270_000,
      totalPaise: 1_770_000,
    });
    const d = returnValue({ qty: 10, ratePaise: 10000, gstBp: 1800, discountBp: 1000 })!;
    assert.equal(d.discountPaise, 10_000);
    assert.equal(d.taxablePaise, 90_000);
    assert.equal(d.totalPaise, 106_200);
  });
  it("writes no figure without a rate", () => {
    assert.equal(returnValue({ qty: 5, ratePaise: null, gstBp: 1800 }), null);
  });
});

describe("material returns — quantities", () => {
  it("turns kg into the ledger's litres by density, and refuses a kg lot with none", () => {
    assert.equal(toStockQty(100, "Kg", 0.8), 125);
    assert.equal(toStockQty(100, "Litre", null), 100);
    assert.equal(toStockQty(100, "Kg", null), null);
  });
  it("never returns more than the lot, less what other returns claim, nor more than is on the shelf", () => {
    assert.equal(returnableQty(1000, 300), 700);
    assert.equal(vendorReturnRefusal({ qty: 100, returnable: 700, onShelf: 900 }), null);
    assert.match(vendorReturnRefusal({ qty: 800, returnable: 700, onShelf: 900 })!, /700/);
    assert.match(vendorReturnRefusal({ qty: 100, returnable: 700, onShelf: 50 })!, /in stock/);
  });
  it("counts a customer return in its allocation's unit, never more than was sent", () => {
    assert.equal(returnLitres({ qty: 2, lotFrom: "pack", cansPerBox: 4, millilitres: 5000 }), 40);
    assert.equal(returnCans({ qty: 2, lotFrom: "pack", cansPerBox: 4 }), 8);
    assert.equal(returnLitres({ qty: 3, lotFrom: "fg", cansPerBox: 1, millilitres: 20000 }), 60);
    assert.equal(customerReturnRefusal({ qty: 5, dispatched: 10, alreadyReturned: 4, whole: true }), null);
    assert.match(customerReturnRefusal({ qty: 7, dispatched: 10, alreadyReturned: 4, whole: true })!, /6/);
    assert.match(customerReturnRefusal({ qty: 1.5, dispatched: 10, alreadyReturned: 0, whole: true })!, /whole/);
  });
});

describe("material returns — approval", () => {
  it("asks the owner too only above the configured limit", () => {
    assert.equal(approvalSteps(5_000_000, 10_000_000), 1);
    assert.equal(approvalSteps(15_000_000, 10_000_000), 2);
    assert.equal(approvalSteps(15_000_000, 0), 1, "a limit of 0 switches the owner step off");
  });
  it("is never the requester's, and the owner step is an administrator's", () => {
    const base = { actorId: "u1", requesterId: "u1", firstApproverId: null, administrator: false, hasPower: true };
    assert.match(approvalRefusal({ step: 1, ...base })!, /other than/);
    assert.equal(approvalRefusal({ step: 1, ...base, requesterId: "u2" }), null);
    assert.match(approvalRefusal({ step: 1, ...base, requesterId: "u2", hasPower: false })!, /power/);
    assert.equal(approvalRefusal({ step: 1, ...base, administrator: true }), null);
    assert.match(approvalRefusal({ step: 2, ...base, requesterId: "u2" })!, /owner/);
    assert.equal(approvalRefusal({ step: 2, ...base, administrator: true }), null);
  });
});

describe("material returns — stages", () => {
  it("follows a vendor return from approval to the goods leaving", () => {
    const r = { status: "approved", needsOwner: false, ownerApproved: false };
    assert.equal(vendorReturnStage({ ...r, status: "pending" }, null), "awaiting_approval");
    assert.equal(vendorReturnStage({ ...r, needsOwner: true }, null), "awaiting_owner");
    assert.equal(vendorReturnStage(r, null), "to_dispatch");
    assert.equal(vendorReturnStage(r, { status: "draft" }), "outward_drafted");
    assert.equal(vendorReturnStage(r, { status: "confirmed" }), "dispatched");
    assert.equal(vendorReturnStage({ ...r, status: "cancelled" }, { status: "confirmed" }), "cancelled");
  });
  it("follows a customer return through quarantine to closed", () => {
    assert.equal(customerReturnStage({ status: "open", received: null, disposed: 0 }), "awaiting_receipt");
    assert.equal(customerReturnStage({ status: "open", received: 10, disposed: 0 }), "in_quarantine");
    assert.equal(customerReturnStage({ status: "open", received: 10, disposed: 4 }), "partly_disposed");
    assert.equal(customerReturnStage({ status: "open", received: 10, disposed: 10 }), "closed");
  });
});

describe("material returns — QC disposition", () => {
  it("leaves in quarantine what is received less what is decided and not reversed", () => {
    assert.equal(quarantineLeft(10, [{ qty: 4, status: "active" }, { qty: 3, status: "reversed" }]), 6);
    assert.equal(quarantineLeft(null, []), 0);
  });
  it("refuses a decision past what is in quarantine, and asks each kind for what it needs", () => {
    const base = { qty: 2, left: 5, whole: true, godownId: "g1", scrapKg: null, wasteReason: null };
    assert.equal(dispositionRefusal({ kind: "reuse", ...base }), null);
    assert.match(dispositionRefusal({ kind: "reuse", ...base, qty: 6 })!, /5/);
    assert.match(dispositionRefusal({ kind: "reuse", ...base, godownId: null })!, /godown/);
    assert.match(dispositionRefusal({ kind: "scrap", ...base })!, /kg/);
    assert.equal(dispositionRefusal({ kind: "scrap", ...base, scrapKg: 40 }), null);
    assert.match(dispositionRefusal({ kind: "waste", ...base, wasteReason: "bad" })!, /10 characters/);
  });
  it("records the rework example: 100 L in, 95 L out, 5 L lost", () => {
    assert.deepEqual(reworkFigures(100, 95), { lossLitres: 5, lossPercent: 5 });
    assert.ok("refusal" in reworkFigures(100, 101));
  });
});

describe("material returns — vocabulary", () => {
  it("round-trips reasons and dispositions by label", () => {
    assert.equal(reasonByLabel(reasonLabel("wrong_spec", "vendor"), "vendor"), "wrong_spec");
    assert.equal(dispositionByLabel("Chemical scrap"), "scrap");
    assert.equal(complaintCategoryFor("damaged"), "Leakage / Packaging");
  });
});
