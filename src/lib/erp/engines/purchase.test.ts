import test from "node:test";
import assert from "node:assert/strict";
import { lotNumber, postsToStock, prBillLabel, purchaseFigures, settableStatuses, shortLabel } from "./purchase";

const base = { quantity: 0, unit: "Litre", ratePaise: null, density: null, feedAdjustedLitre: 0, feedAdjustedAmountPaise: 0, gstBp: 1800, drums: null };

test("kilograms become litres by density, rounded as the source rounds", () => {
  const f = purchaseFigures({ ...base, quantity: 870, unit: "Kg", density: 0.87, ratePaise: 8000 });
  assert.equal(f.inLitre, 1000);
  assert.equal(f.literRatePaise, 6960, "a kg rate is rate × density per litre");
});

test("litres and pieces pass through; feed adjustment comes off the available litres", () => {
  const f = purchaseFigures({ ...base, quantity: 900, unit: "Litre", ratePaise: 9200, feedAdjustedLitre: 4.6, drums: 4 });
  assert.equal(f.inLitre, 900);
  assert.equal(f.availableLitres, 895);
  assert.equal(f.litresPerDrum, 223.75);
  assert.equal(f.literRatePaise, 9200);
});

test("GST and the final amount, net of the feed-adjusted amount", () => {
  const f = purchaseFigures({ ...base, quantity: 100, ratePaise: 10000, feedAdjustedAmountPaise: 5000 });
  assert.equal(f.subTotalPaise, 1_000_000);
  assert.equal(f.gstPaise, 180_000);
  assert.equal(f.amountWithGstPaise, 1_180_000);
  assert.equal(f.finalPaise, 1_175_000);
});

test("no rate means no money figures and no posting to stock", () => {
  const f = purchaseFigures({ ...base, quantity: 100 });
  assert.equal(f.finalPaise, null);
  assert.equal(postsToStock(null), false);
  assert.equal(postsToStock(0), false);
  assert.equal(postsToStock(1), true);
});

test("a kg purchase with no density cannot be converted and says zero litres rather than guessing", () => {
  assert.equal(purchaseFigures({ ...base, quantity: 500, unit: "Kg" }).inLitre, 0);
});

test("the lot number, the short label and the PR/bill label", () => {
  assert.equal(lotNumber("RS", "TOL", 1228), "RSTOL1228");
  assert.equal(shortLabel("Toulene", ["Toulene=Stoving", "Acetone=Acet"]), "Stoving");
  assert.equal(shortLabel("Xylene", ["Toulene=Stoving"]), "Xylene");
  assert.equal(prBillLabel(1228, "RS/2210", "2026-09-12"), "1228 RS/2210 12-Sep-26");
});

test("the verifier sets only Purchase Verified; everybody else the two before it", () => {
  assert.deepEqual(settableStatuses(true), ["Purchase Verified"]);
  assert.deepEqual(settableStatuses(false), ["Invoice Received", "Purchase Matched"]);
});
