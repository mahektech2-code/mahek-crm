/**
 * Who decides what an order line costs: the field order's office check (B7,
 * B8) and the ERP desk's discount authority (B9). Pure.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveDiscountBp,
  judgeFieldOrderPrices,
  lineAuthority,
  mergeOfficeRatesIntoTags,
  pricedFromList,
  type OfficeRate,
} from "./order-price-authority";
import { discountAuthority } from "./price-math";

const list = (ratePaise: number, extra: Partial<OfficeRate & { listId: string }> = {}) =>
  ({ ratePaise, source: "list", basis: "Western line", offered: true, listId: "pl_1", ...extra }) as OfficeRate & { listId: string };

describe("a field order is held to the office's rate, whatever the payload says", () => {
  const office = new Map([["a", list(10_000)], ["b", list(5_000)]]);

  test("every line is checked — no price tag in the payload is needed for the check to run", () => {
    const v = judgeFieldOrderPrices([{ productId: "a", quantityCans: 2, ratePaise: 1 }], office, { totalAmountPaise: 2, valueUnavailable: false });
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.code, "price_changed");
    assert.equal(!v.ok && v.officePaise, 10_000);
  });

  test("a line quoted at the office's rate passes, and names the list it came from", () => {
    const lines = [{ productId: "a", quantityCans: 2, ratePaise: 10_000 }, { productId: "b", quantityCans: 1, ratePaise: 5_000 }];
    assert.deepEqual(judgeFieldOrderPrices(lines, office, { totalAmountPaise: 25_000, valueUnavailable: false }), { ok: true });
    assert.equal(pricedFromList(lines, office), "pl_1");
  });

  test("a total above what the lines add up to is refused; below (a scheme) is not", () => {
    const lines = [{ productId: "a", quantityCans: 2, ratePaise: 10_000 }];
    assert.equal(judgeFieldOrderPrices(lines, office, { totalAmountPaise: 20_001, valueUnavailable: false }).ok, false);
    assert.equal(judgeFieldOrderPrices(lines, office, { totalAmountPaise: 18_000, valueUnavailable: false }).ok, true);
  });

  test("a product the list prints a dash for cannot be sold", () => {
    const v = judgeFieldOrderPrices([{ productId: "a", quantityCans: 1 }], new Map([["a", list(0, { offered: false })]]), { totalAmountPaise: 0, valueUnavailable: true });
    assert.equal(!v.ok && v.code, "not_offered");
  });

  test("no office rate keeps the typed one; an unrated line has nothing to compare", () => {
    assert.equal(judgeFieldOrderPrices([{ productId: "z", quantityCans: 1, ratePaise: 7 }], office, { totalAmountPaise: 7, valueUnavailable: false }).ok, true);
    assert.equal(judgeFieldOrderPrices([{ productId: "a", quantityCans: 1 }], office, { totalAmountPaise: 0, valueUnavailable: true }).ok, true);
  });

  test("two lists, or the tag table, name no single list", () => {
    const mixed = new Map([["a", list(1, { listId: "pl_1" })], ["b", list(1, { listId: "pl_2" })]]);
    assert.equal(pricedFromList([{ productId: "a", quantityCans: 1 }, { productId: "b", quantityCans: 1 }], mixed), null);
    const tag = new Map([["a", { ratePaise: 1, source: "tag" as const, basis: "DEALER", offered: true, listId: null }]]);
    assert.equal(pricedFromList([{ productId: "a", quantityCans: 1 }], tag), null);
  });
});

describe("the handset's table carries the office's rate where one list speaks for a tag", () => {
  test("list rates replace the tag's, a dash removes the product, duplicates collapse to the first", () => {
    const merged = mergeOfficeRatesIntoTags(
      [
        { priceTag: "DEALER", productId: "a", ratePaise: 900 },
        { priceTag: "DEALER", productId: "b", ratePaise: 400 },
        { priceTag: "DEALER", productId: "c", ratePaise: 300 },
        { priceTag: "DEALER", productId: "c", ratePaise: 250 },
        { priceTag: "OTHER", productId: "a", ratePaise: 800 },
      ],
      new Map([["DEALER", new Map<string, number | null>([["a", 1_000], ["b", null], ["d", 2_000]])]]),
    );
    assert.deepEqual(merged, [
      { priceTag: "DEALER", productId: "a", ratePaise: 1_000 },
      { priceTag: "DEALER", productId: "c", ratePaise: 300 },
      { priceTag: "DEALER", productId: "d", ratePaise: 2_000 },
      { priceTag: "OTHER", productId: "a", ratePaise: 800 },
    ]);
  });
});

describe("the ERP desk: one discount, rate and discount together", () => {
  const ceilings = { associateMaxBp: 0, managerMaxBp: 1_000 };

  test("a rate typed under the list is a discount", () => {
    assert.equal(effectiveDiscountBp({ listRatePaise: 10_000, ratePaise: 9_000, discountBp: null }), 1_000);
    assert.equal(effectiveDiscountBp({ listRatePaise: 10_000, ratePaise: 9_000, discountBp: 1_000 }), 1_900);
    assert.equal(effectiveDiscountBp({ listRatePaise: 10_000, ratePaise: 11_000, discountBp: 500 }), 500);
    assert.equal(effectiveDiscountBp({ listRatePaise: null, ratePaise: 9_000, discountBp: 300 }), 300);
  });

  test("an associate may give nothing on their own, on the discount or through the rate", () => {
    assert.equal(lineAuthority({ listRatePaise: 10_000, ratePaise: 10_000, discountBp: 100 }, "associate", ceilings).allowed, false);
    const viaRate = lineAuthority({ listRatePaise: 10_000, ratePaise: 9_900, discountBp: null }, "associate", ceilings);
    assert.equal(viaRate.allowed, false);
    assert.match(viaRate.reason ?? "", /under the list/);
    assert.equal(lineAuthority({ listRatePaise: 10_000, ratePaise: 10_000, discountBp: null }, "associate", ceilings).allowed, true);
  });

  test("a manager is capped at the manager's ceiling, and is named as the authority above the associate's", () => {
    const ok = lineAuthority({ listRatePaise: 10_000, ratePaise: 10_000, discountBp: 1_000 }, "manager", ceilings);
    assert.equal(ok.allowed, true);
    assert.equal(ok.needsAuthority, true);
    assert.equal(lineAuthority({ listRatePaise: 10_000, ratePaise: 9_500, discountBp: 600 }, "manager", ceilings).allowed, false);
  });

  test("a rate above the list is an override to record, never room for a bigger discount", () => {
    const v = lineAuthority({ listRatePaise: 10_000, ratePaise: 20_000, discountBp: 1_500 }, "manager", ceilings);
    assert.equal(v.rateOverridden, true);
    assert.equal(v.allowed, false);
  });

  test("a rate typed where the list has none is recorded; the list's own rate is not", () => {
    assert.equal(lineAuthority({ listRatePaise: null, ratePaise: 500, discountBp: null }, "associate", ceilings).rateOverridden, true);
    assert.equal(lineAuthority({ listRatePaise: 500, ratePaise: 500, discountBp: null }, "associate", ceilings).rateOverridden, false);
  });

  test("it answers exactly as the CRM's check does for a plain discount", () => {
    for (const level of ["associate", "manager", "admin"] as const) {
      for (const bp of [0, 300, 1_000, 1_001, 5_000]) {
        assert.equal(
          lineAuthority({ listRatePaise: 10_000, ratePaise: 10_000, discountBp: bp }, level, ceilings).allowed,
          discountAuthority(bp, level, ceilings).allowed,
          `${level} ${bp}`,
        );
      }
    }
  });
});
