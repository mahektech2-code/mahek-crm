/**
 * The write-path rules of the price desk that need no database: when an old
 * version stops being in force, which list states take a price, and that a
 * shop's agreed prices sit on top of the list it is assigned.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  draftOnlyRefusal,
  newVersionRefusal,
  scopeDatesProblem,
  supersededStatusOn,
  withdrawRefusal,
} from "./price-supersede";
import {
  AGREED_SCOPE_PRIORITY,
  resolvePriceList,
  type CustomerGeo,
  type ListMeta,
  type ScopeRow,
} from "./price-resolution";

const geo: CustomerGeo = {
  customerId: "cus_1",
  salesmanIds: [],
  beatKeys: [],
  areaKeys: [],
  cityKeys: ["thane"],
  districtKeys: [],
  stateKeys: ["maharashtra"],
  customerType: null,
  freightTerm: "to_pay",
};

function list(id: string, over: Partial<ListMeta> = {}): ListMeta {
  return { id, name: id, status: "published", effectiveFrom: "2026-01-01", effectiveTo: null, freightTerm: "not_stated", version: 1, ...over };
}

function scope(id: string, priceListId: string, over: Partial<ScopeRow> = {}): ScopeRow {
  return {
    id,
    priceListId,
    scopeKind: "customer",
    scopeValue: "cus_1",
    parentKey: "",
    freightTermMatch: "any",
    priority: 0,
    validFrom: null,
    validTo: null,
    ...over,
  };
}

describe("a version that starts later does not cut the old one off today", () => {
  test("the old list stays published until the day before the new one starts has passed", () => {
    assert.equal(supersededStatusOn("2026-11-30", "2026-10-29"), "published");
    assert.equal(supersededStatusOn("2026-10-29", "2026-10-29"), "published", "its last day is still a day it prices");
    assert.equal(supersededStatusOn("2026-10-28", "2026-10-29"), "superseded");
  });

  test("the resolver keeps pricing a dated-out list until its last day, and the successor from its first", () => {
    const lists = [
      list("v1", { effectiveTo: "2026-11-30" }),
      list("v2", { effectiveFrom: "2026-12-01", version: 2 }),
      list("standard"),
    ];
    const scopes = [
      scope("s1", "v1", { scopeKind: "state", scopeValue: "maharashtra" }),
      scope("s2", "v2", { scopeKind: "state", scopeValue: "maharashtra" }),
      scope("s3", "standard", { scopeKind: "everybody", scopeValue: "" }),
    ];
    assert.equal(resolvePriceList(geo, scopes, lists, "2026-11-15")?.listId, "v1");
    assert.equal(resolvePriceList(geo, scopes, lists, "2026-11-30")?.listId, "v1");
    assert.equal(resolvePriceList(geo, scopes, lists, "2026-12-01")?.listId, "v2");
  });
});

describe("a shop's agreed prices layer over the list it is assigned", () => {
  test("the agreed scope wins inside the customer kind, even against a freight-matching assigned list", () => {
    const lists = [list("assigned", { freightTerm: "to_pay" }), list("agreed", { effectiveFrom: "2025-06-01" })];
    const scopes = [scope("a", "assigned"), scope("g", "agreed", { priority: AGREED_SCOPE_PRIORITY })];
    assert.equal(resolvePriceList(geo, scopes, lists, "2026-10-29")?.listId, "agreed");
  });

  test("without the agreed priority the freight term still decides, as it always did", () => {
    const lists = [list("assigned", { freightTerm: "to_pay" }), list("other", { effectiveFrom: "2026-06-01" })];
    const scopes = [scope("a", "assigned"), scope("o", "other", { priority: 50 })];
    assert.equal(resolvePriceList(geo, scopes, lists, "2026-10-29")?.listId, "assigned");
  });
});

describe("which list states take which writes", () => {
  test("a price or a discount is set on a draft and nowhere else", () => {
    assert.equal(draftOnlyRefusal("draft", "Changing a price on it"), null);
    for (const status of ["published", "superseded", "withdrawn"]) {
      assert.match(draftOnlyRefusal(status, "Changing a price on it") ?? "", new RegExp(status));
    }
  });

  test("only a published list is withdrawn", () => {
    assert.equal(withdrawRefusal("published"), null);
    assert.match(withdrawRefusal("draft") ?? "", /Delete it/);
    assert.match(withdrawRefusal("superseded") ?? "", /replaced/);
    assert.match(withdrawRefusal("withdrawn") ?? "", /already been withdrawn/);
  });

  test("a new version is not made from a list that has ended", () => {
    assert.equal(newVersionRefusal("published"), null);
    assert.equal(newVersionRefusal("draft"), null);
    assert.ok(newVersionRefusal("superseded"));
    assert.ok(newVersionRefusal("withdrawn"));
  });

  test("a scope cannot stop applying before it starts", () => {
    assert.equal(scopeDatesProblem(null, null), null);
    assert.equal(scopeDatesProblem("2026-10-01", null), null);
    assert.equal(scopeDatesProblem("2026-10-01", "2026-10-01"), null);
    assert.ok(scopeDatesProblem("2026-10-02", "2026-10-01"));
  });
});
