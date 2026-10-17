import test from "node:test";
import assert from "node:assert/strict";
import { landingFigures, lotNumber, netWeight, postsToStock, prBillLabel, purchaseFigures, settableStatuses, shareInwardCost, shortLabel, transportCostPaise } from "./purchase";

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

test("transport cost: our own vehicle is km × the approved rate, never typed", () => {
  assert.equal(transportCostPaise({ mode: "own_vehicle", billedPaise: 99999, km: 42.5, ratePerKmPaise: 1800 }), 76500);
  assert.equal(transportCostPaise({ mode: "own_vehicle", billedPaise: null, km: 40, ratePerKmPaise: 0 }), null, "no approved rate is no figure, not zero");
  assert.equal(transportCostPaise({ mode: "own_vehicle", billedPaise: null, km: null, ratePerKmPaise: 1800 }), null);
  assert.equal(transportCostPaise({ mode: "supplier", billedPaise: 236000, km: 10, ratePerKmPaise: 1800 }), 236000);
  assert.equal(transportCostPaise({ mode: "third_party", billedPaise: 150000, km: null, ratePerKmPaise: null }), 150000);
  assert.equal(transportCostPaise({ mode: "none", billedPaise: 5000, km: null, ratePerKmPaise: null }), 0);
});

test("the inward cost is shared by value, adds up to the paise spent, and waits for lots with no rate", () => {
  const { shares, unallocatedPaise } = shareInwardCost(
    [
      { id: "a", materialPaise: 300000 },
      { id: "b", materialPaise: 100000 },
      { id: "c", materialPaise: null },
    ],
    1001,
  );
  assert.equal(shares.get("a"), 751);
  assert.equal(shares.get("b"), 250);
  assert.equal(shares.get("c"), 0, "a lot with no rate takes no share yet");
  assert.equal([...shares.values()].reduce((x, y) => x + y, 0), 1001);
  assert.equal(unallocatedPaise, 0);
  const none = shareInwardCost([{ id: "a", materialPaise: null }], 5000);
  assert.equal(none.unallocatedPaise, 5000, "nothing valued yet: the whole cost is said to be unallocated");
});

test("landing cost is material + share, and the landed rate is per purchase unit", () => {
  const f = landingFigures({ quantity: 200, ratePaise: 9000, sharePaise: 40000 });
  assert.equal(f.materialPaise, 1800000);
  assert.equal(f.landingPaise, 1840000);
  assert.equal(f.landedRatePaise, 9200);
  assert.deepEqual(landingFigures({ quantity: 200, ratePaise: null, sharePaise: 40000 }), { materialPaise: null, landingPaise: null, landedRatePaise: null });
});

test("net weight is the gross off the scale less every empty drum", () => {
  assert.equal(netWeight(1040, 5, 18), 950);
  assert.equal(netWeight(218.5, 1, 18.25), 200.25);
  assert.equal(netWeight(90, 5, 18), null, "drums as heavy as the load is a misread scale");
  assert.equal(netWeight(1040, 5, null), null);
  assert.equal(netWeight(null, 5, 18), null);
});
