import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  boxesFor,
  canValueOrders,
  canonicalName,
  describeQuantity,
  lineValuePaise,
  litresFor,
  matchKey,
  weightFor,
} from "./catalogue";
import { FINISHED_GOODS, SKUS, BRANDS, FORMULATIONS } from "@/db/catalogue-seed";

/* ---------------------------------------------------------------------------
 * The catalogue's rules, tested without a database — they are pure, and the
 * generated seed is data rather than I/O, so the shape of the product master
 * itself can be asserted here too.
 * ------------------------------------------------------------------------- */

describe("names", () => {
  test("normalising fixes the three things the source spells inconsistently", () => {
    assert.equal(canonicalName("Nano  Thinner - 5 Liter(6 can/box)"), "Nano Thinner - 5 Liter (6 Can/Box)");
    assert.equal(canonicalName("  Mylac Thinner - 20 Liter (2 Can/box) "), "Mylac Thinner - 20 Liter (2 Can/Box)");
  });

  test("the match key ignores exactly what a typist varies", () => {
    // Legacy order lines carry typed text, so these three must be one product.
    const a = matchKey("Nano Thinner - 5 Liter (6 Can/Box)");
    assert.equal(matchKey("nano thinner 5 liter (6 can/box)"), a);
    assert.equal(matchKey("Nano  Thinner-5 Liter(6 Can/Box)"), a);
  });

  test("it does not merge two products that differ by one word", () => {
    assert.notEqual(
      matchKey("Nano Thinner - 20 Liter (Loose)"),
      matchKey("Astar Nano Thinner - 20 Liter (Loose)"),
    );
  });
});

describe("quantity is cans", () => {
  const boxed = { millilitresPerCan: 5000, cansPerBox: 6 };
  const loose = { millilitresPerCan: 20000, cansPerBox: 1 };

  test("litres are derived from the can count, never stored", () => {
    assert.equal(litresFor(6, boxed), 30);
    assert.equal(litresFor(3, { millilitresPerCan: 500, cansPerBox: 25 }), 1.5);
    assert.equal(litresFor(1, { millilitresPerCan: 800, cansPerBox: 44 }), 0.8);
  });

  test("a row with no pack size derives nothing rather than guessing", () => {
    assert.equal(litresFor(6, { millilitresPerCan: null, cansPerBox: 1 }), null);
  });

  test("boxes and the cans left over", () => {
    assert.deepEqual(boxesFor(13, boxed), { boxes: 2, looseCans: 1 });
    assert.deepEqual(boxesFor(12, boxed), { boxes: 2, looseCans: 0 });
  });

  test("a loose SKU has no boxes, and says so as a remainder not a zero", () => {
    assert.deepEqual(boxesFor(4, loose), { boxes: 0, looseCans: 4 });
  });

  test("weight follows its basis, because the two cannot be added together", () => {
    // Per box: 13 cans is three boxes' worth of lorry, not two.
    assert.equal(weightFor(13, { ...boxed, weightGrams: 27000, weightBasis: "box" }), 81000);
    assert.equal(weightFor(4, { ...loose, weightGrams: 18000, weightBasis: "can" }), 72000);
  });

  test("no weight on the SKU means no weight, not zero", () => {
    assert.equal(weightFor(4, { ...loose, weightGrams: null, weightBasis: "can" }), null);
  });

  test("one phrasing for a quantity, so two screens cannot differ", () => {
    assert.equal(describeQuantity(13, boxed), "13 cans · 65 L · 2 boxes + 1");
    assert.equal(describeQuantity(1, loose), "1 can · 20 L");
  });
});

describe("order valuation is blocked until a price source is confirmed", () => {
  test("unset means nothing may be valued", () => {
    assert.equal(canValueOrders("unset"), false);
    assert.equal(lineValuePaise("unset", 6, { sellingPricePaise: 45000 }, 250000), null);
  });

  test("manual means the typed figure stands and the catalogue has no opinion", () => {
    assert.equal(lineValuePaise("manual", 6, { sellingPricePaise: null }, 250000), 250000);
  });

  test("a product with no price is not a free product", () => {
    assert.equal(lineValuePaise("product", 6, { sellingPricePaise: null }, 250000), null);
  });

  test("a product price multiplies by cans", () => {
    assert.equal(lineValuePaise("product", 6, { sellingPricePaise: 45000 }, null), 270000);
  });
});

describe("the product master itself", () => {
  test("every level is populated and the counts are the document's", () => {
    assert.equal(FORMULATIONS.length, 19);
    assert.equal(BRANDS.length, 32);
    assert.equal(FINISHED_GOODS.length, 107);
    assert.equal(SKUS.length, 213);
  });

  test("the canonical name is unique, because it is the join key to legacy orders", () => {
    const seen = new Set(SKUS.map((s) => matchKey(s.name)));
    assert.equal(seen.size, SKUS.length);
  });

  test("every SKU hangs off a finished good, a brand and a formulation", () => {
    const goods = new Set(FINISHED_GOODS.map((g) => g.name));
    const brands = new Set(BRANDS.map((b) => b.name));
    const forms = new Set(FORMULATIONS.map((f) => f.name));
    for (const s of SKUS) {
      assert.ok(goods.has(s.finishedGood), `${s.name} has no finished good`);
      assert.ok(brands.has(s.brand), `${s.name} has no brand`);
      assert.ok(forms.has(s.formulation), `${s.name} has no formulation`);
    }
  });

  test("a loose SKU has no box, so it has no packing cost", () => {
    for (const s of SKUS) {
      if (!s.loose) continue;
      assert.equal(s.packingCostPaise, null, `${s.name} carries a box cost with no box`);
    }
  });

  test("a drum is not loose — it is a container, and it costs something", () => {
    const drums = SKUS.filter((s) => s.packing === "Drum");
    assert.ok(drums.length > 0);
    for (const d of drums) {
      assert.equal(d.loose, false, `${d.name} is a drum reported as loose`);
      assert.ok(d.packingCostPaise, `${d.name} is a drum with no drum cost`);
    }
  });

  test("every SKU names its packing", () => {
    for (const s of SKUS) assert.ok(s.packing.trim().length > 0, s.name);
  });

  test("weight is per box where there is a box and per can where there is not", () => {
    for (const s of SKUS) {
      assert.equal(s.weightBasis, s.cansPerBox > 1 ? "box" : "can", s.name);
    }
  });

  test("fifteen names carry more than one legacy ID and none is auto-picked", () => {
    const flagged = SKUS.filter((s) => s.duplicated);
    assert.equal(flagged.length, 15);
    for (const s of flagged) assert.ok(s.externalIds.length > 1, s.name);
  });

  test("no SKU carries a price, because the document has none", () => {
    for (const s of SKUS) {
      assert.ok(!("sellingPricePaise" in s), `${s.name} claims a price the source never gave`);
    }
  });
});
