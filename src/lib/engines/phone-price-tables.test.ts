import test from "node:test";
import assert from "node:assert/strict";
import { phonePriceTables, phoneRateKey } from "./order-price-authority";

test("a shop's key is its tag where its tag is one list, and tag::list where it is not", () => {
  assert.equal(phoneRateKey("DEALER", "pl_1", true), "DEALER");
  assert.equal(phoneRateKey("DEALER", "pl_2", false), "DEALER::pl_2");
  assert.equal(phoneRateKey(null, "pl_3", false), "::pl_3");
  assert.equal(phoneRateKey("DEALER", null, false), "DEALER");
  assert.equal(phoneRateKey(null, null, true), null);
});

test("two lists under one tag become two keys, each with its own rate and the tag's for what it lacks", () => {
  const t = phonePriceTables(
    [
      { priceTag: "DEALER", productId: "a", ratePaise: 900 },
      { priceTag: "DEALER", productId: "z", ratePaise: 100 },
    ],
    [
      { key: "DEALER::pl_1", tag: "DEALER", rates: new Map([["a", 1_000]]), customerIds: ["c1"] },
      { key: "DEALER::pl_2", tag: "DEALER", rates: new Map<string, number | null>([["a", 1_200], ["b", null]]), customerIds: ["c2", "c3"] },
    ],
  );
  const rate = (key: string, p: string) => t.priceList.find((r) => r.priceTag === key && r.productId === p)?.ratePaise;
  assert.equal(rate("DEALER::pl_1", "a"), 1_000);
  assert.equal(rate("DEALER::pl_2", "a"), 1_200);
  assert.equal(rate("DEALER::pl_1", "z"), 100, "the tag table stands in for what the list does not carry");
  assert.equal(rate("DEALER", "a"), 900, "the plain tag is left exactly as an older build reads it");
  assert.equal(rate("DEALER::pl_2", "b"), undefined, "a dash is no rate");
  assert.deepEqual(t.priceKeys, [
    { customerId: "c1", priceKey: "DEALER::pl_1" },
    { customerId: "c2", priceKey: "DEALER::pl_2" },
    { customerId: "c3", priceKey: "DEALER::pl_2" },
  ]);
  assert.deepEqual(t.priceUnoffered, [{ priceKey: "DEALER::pl_2", productId: "b" }]);
});

test("a uniform tag keeps its old rows and needs no key, but still says its dashes", () => {
  const t = phonePriceTables(
    [{ priceTag: "RETAIL", productId: "a", ratePaise: 500 }],
    [{ key: "RETAIL", tag: "RETAIL", rates: new Map<string, number | null>([["a", 550], ["b", null]]), customerIds: ["c9"] }],
  );
  assert.deepEqual(t.priceList, [{ priceTag: "RETAIL", productId: "a", ratePaise: 550 }]);
  assert.deepEqual(t.priceKeys, []);
  assert.deepEqual(t.priceUnoffered, [{ priceKey: "RETAIL", productId: "b" }]);
});
