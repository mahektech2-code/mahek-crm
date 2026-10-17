import { test } from "node:test";
import assert from "node:assert/strict";
import {
  batchState,
  boxFigures,
  fgLotCode,
  fgReorderPercent,
  fillFigures,
  fillRefusal,
  packBatchNo,
  packCosting,
  rmReorderPercent,
  rmRequired,
  sfgLotCode,
  sfgRate,
  sfgTotalUse,
  sfgYield,
} from "./production";

test("an SFG line uses batches × quantity, and yields that less what was lost", () => {
  assert.equal(sfgTotalUse(2.5, 40), 100);
  assert.equal(sfgYield(100, 3.5), 96.5);
  assert.equal(sfgLotCode(12, "ASTOL1001"), "12ASTOL1001");
});

test("the SFG rate is a weighted average, and unknown when any line's rate is", () => {
  assert.equal(sfgRate([{ totalUse: 100, rmRatePaise: 10000 }, { totalUse: 300, rmRatePaise: 6000 }]), 7000);
  assert.equal(sfgRate([{ totalUse: 100, rmRatePaise: 10000 }, { totalUse: 1, rmRatePaise: null }]), null);
});

test("FG and packing lot codes take the godown's first two letters", () => {
  assert.equal(fgLotCode(41, "Bhiwandi"), "FG41BH");
  assert.equal(packBatchNo(7, "ambernath"), "FP7AM");
});

test("a can fill is costed per can, a drum fill per litre, and a Naket fill pays no packing", () => {
  const can = fillFigures({ canSize: 5, cans: 10, canAdjusted: 1, packingType: "Can", sfgRatePaise: 7000, packingRatePaise: 3000 });
  assert.equal(can.useLitres, 50);
  assert.equal(can.cansAvailable, 9, "posting is net of cans lost (A-12)");
  assert.equal(can.costingPaise, 7000 * 50 + 10 * 3000);
  assert.equal(can.ratePaise, 38000);
  const drum = fillFigures({ canSize: 200, cans: 2, canAdjusted: 0, packingType: "Drum", sfgRatePaise: 7000, packingRatePaise: 150000 });
  assert.equal(drum.rateBasis, "litre");
  assert.equal(drum.ratePaise, Math.round((7000 * 400 + 2 * 150000) / 400));
  const naket = fillFigures({ canSize: 20, cans: 1, canAdjusted: 0, packingType: "Naket", sfgRatePaise: 100, packingRatePaise: null });
  assert.equal(naket.costingPaise, 2000);
});

test("each failed fill check says its own thing (A-11)", () => {
  const base = { useLitres: 50, sfgAvailable: 100, cans: 10, packingAvailable: 20, packingType: "Can" };
  assert.equal(fillRefusal(base), null);
  assert.equal(fillRefusal({ ...base, cans: 0 }), "Minus Quantity Not Allowed");
  assert.equal(fillRefusal({ ...base, useLitres: 101 }), "Low SFG Stock");
  assert.equal(fillRefusal({ ...base, packingAvailable: 0 }), "Low Packing Quantity");
  assert.equal(fillRefusal({ ...base, packingAvailable: null, packingType: "Naket" }), null);
});

test("a packing batch is complete only when its lines draw exactly its cans", () => {
  assert.deepEqual(batchState(10, 6, [{ id: "a", cans: 40 }]), { totalCans: 60, usedCans: 40, remaining: 20, complete: false });
  assert.equal(batchState(10, 6, [{ id: "a", cans: 40 }, { id: "b", cans: 20 }]).complete, true);
});

test("a batch's boxes are paid for once, shared by cans (A-13)", () => {
  const { emptyBoxes, boxAmountPaise } = boxFigures(10, 1, 2500);
  assert.equal(emptyBoxes, 10);
  const c = packCosting(
    [
      { id: "a", cans: 40, fgRatePaise: 1000 },
      { id: "b", cans: 20, fgRatePaise: 1200 },
    ],
    boxAmountPaise,
  );
  assert.equal((c.get("a") ?? 0) + (c.get("b") ?? 0), 40 * 1000 + 20 * 1200 + 25000);
});

test("levels: re-order % from the midpoint, required to reach the maximum", () => {
  assert.equal(rmReorderPercent(150, 100, 200), 0);
  assert.equal(rmReorderPercent(75, 100, 200), -50);
  assert.equal(rmRequired(150, 200), 50);
  assert.equal(rmRequired(250, 200), null);
  assert.equal(rmRequired(null, 200), null);
  assert.equal(fgReorderPercent(30, 60), 50);
});

test("a suggested level is cover days of average use, and says when recent use has swung", async () => {
  const { suggestLevel } = await import("./production");
  const s = suggestLevel({ used: 900, lookbackDays: 90, recentUsed: 600, recentDays: 30, minCover: 7, maxCover: 21, unit: "L" })!;
  assert.equal(s.min, 70);
  assert.equal(s.max, 210);
  assert.match(s.swing ?? "", /well above/);
  assert.equal(suggestLevel({ used: 0, lookbackDays: 90, recentUsed: 0, recentDays: 30, minCover: 7, maxCover: 21, unit: "L" }), null);
});
