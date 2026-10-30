/**
 * One price list per shop, and leaving shops out of a list — the rules with
 * no database behind them.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { booksOnShop, doubleListed, introducedClashes, isExcludable, listReach } from "./price-one-list";
import { resolvePriceList, type CustomerGeo, type ListMeta, type ScopeRow } from "./price-resolution";

const DAY = "2026-10-30";

function geo(id: string, over: Partial<CustomerGeo> = {}): CustomerGeo {
  return {
    customerId: id,
    salesmanIds: [],
    beatKeys: [],
    areaKeys: [],
    cityKeys: ["nagpur"],
    districtKeys: ["nagpur"],
    stateKeys: ["maharashtra"],
    customerType: null,
    freightTerm: "to_pay",
    ...over,
  };
}

function list(id: string, over: Partial<ListMeta> = {}): ListMeta {
  return { id, name: id, status: "published", effectiveFrom: "2026-01-01", effectiveTo: null, freightTerm: "not_stated", version: 1, ...over };
}

let n = 0;
function scope(listId: string, kind: ScopeRow["scopeKind"], value: string, over: Partial<ScopeRow> = {}): ScopeRow {
  return { id: `s${++n}`, priceListId: listId, scopeKind: kind, scopeValue: value, parentKey: "", freightTermMatch: "any", priority: 0, validFrom: null, validTo: null, ...over };
}

describe("leaving shops out", () => {
  const lists = [list("std"), list("mh")];
  const scopes = [scope("std", "everybody", ""), scope("mh", "state", "maharashtra"), scope("mh", "customer", "a", { excluded: true })];

  test("a left-out shop falls through to the next list", () => {
    assert.equal(resolvePriceList(geo("a"), scopes, lists, DAY)?.listId, "std");
    assert.equal(resolvePriceList(geo("b"), scopes, lists, DAY)?.listId, "mh");
  });

  test("a leave-out row is not a way onto a list", () => {
    const only = [scope("mh", "customer", "b", { excluded: true })];
    assert.equal(resolvePriceList(geo("b"), only, lists, DAY), null);
  });

  test("leaving out a salesman's shops leaves out exactly those", () => {
    const s = [scope("std", "everybody", ""), scope("mh", "state", "maharashtra"), scope("mh", "salesman", "u1", { excluded: true })];
    assert.equal(resolvePriceList(geo("a", { salesmanIds: ["u1"] }), s, lists, DAY)?.listId, "std");
    assert.equal(resolvePriceList(geo("b", { salesmanIds: ["u2"] }), s, lists, DAY)?.listId, "mh");
  });

  test("only shop, salesman and place kinds can be left out", () => {
    assert.equal(isExcludable("customer"), true);
    assert.equal(isExcludable("district"), true);
    assert.equal(isExcludable("everybody"), false);
    assert.equal(isExcludable("customer_type"), false);
    assert.equal(isExcludable("state"), false);
  });

  test("reach counts what the rules name, less what they leave out", () => {
    const r = listReach([geo("a"), geo("b"), geo("c", { stateKeys: ["gujarat"], cityKeys: [], districtKeys: [] })], scopes.filter((s) => s.priceListId === "mh"));
    assert.deepEqual([r.reached, r.leftOut, r.priced], [2, 1, 1]);
  });
});

describe("one list per shop", () => {
  test("Standard and agreed prices are not a second list", () => {
    const lists = [list("std"), list("mh"), list("ag", { kind: "agreed" })];
    const scopes = [scope("std", "everybody", ""), scope("mh", "state", "maharashtra"), scope("ag", "customer", "a", { priority: 1000 })];
    assert.deepEqual(booksOnShop(geo("a"), scopes, lists, DAY).map((b) => b.bookId), ["mh"]);
  });

  test("two revisions of one book are one list", () => {
    const lists = [list("v1", { bookId: "v1", effectiveTo: "2026-11-14", status: "superseded" }), list("v2", { bookId: "v1", effectiveFrom: "2026-11-15", version: 2 })];
    const scopes = [scope("v1", "state", "maharashtra"), scope("v2", "state", "maharashtra")];
    const books = booksOnShop(geo("a"), scopes, lists, DAY);
    assert.equal(books.length, 1);
    assert.equal(books[0].listId, "v1");
  });

  test("Paid and To Pay lists over one place do not clash", () => {
    const lists = [list("paid", { freightTerm: "paid" }), list("topay", { freightTerm: "to_pay" })];
    const scopes = [scope("paid", "state", "maharashtra"), scope("topay", "state", "maharashtra")];
    assert.equal(booksOnShop(geo("a", { freightTerm: "paid" }), scopes, lists, DAY).length, 1);
    assert.equal(booksOnShop(geo("b", { freightTerm: null }), scopes, lists, DAY).length, 2);
  });

  test("an ended rule or list allocates nobody; a scheduled one does", () => {
    const lists = [list("mh"), list("old", { effectiveTo: "2026-10-01" }), list("next", { effectiveFrom: "2026-12-01" })];
    const scopes = [scope("mh", "state", "maharashtra"), scope("old", "city", "nagpur"), scope("next", "customer", "a")];
    assert.deepEqual(booksOnShop(geo("a"), scopes, lists, DAY).map((b) => b.bookId).sort(), ["mh", "next"]);
  });

  test("doubles already stored are listed", () => {
    const lists = [list("mh"), list("ngp")];
    const scopes = [scope("mh", "state", "maharashtra"), scope("ngp", "city", "nagpur")];
    assert.equal(doubleListed([geo("a"), geo("b", { cityKeys: ["pune"], districtKeys: ["pune"] })], scopes, lists, DAY).length, 1);
  });

  test("only an edit that ADDS a double is a clash", () => {
    const lists = [list("mh"), list("ngp")];
    const before = { scopes: [scope("mh", "state", "maharashtra"), scope("ngp", "city", "nagpur")], lists };
    /* Already on both: re-saving the book introduces nothing. */
    assert.equal(introducedClashes([geo("a")], before, before, "ngp", DAY).length, 0);

    const fresh = { scopes: [scope("mh", "state", "maharashtra")], lists };
    const added = { scopes: [...fresh.scopes, scope("ngp", "customer", "a")], lists };
    const clashes = introducedClashes([geo("a"), geo("b")], fresh, added, "ngp", DAY);
    assert.deepEqual(clashes.map((c) => c.customerId), ["a"]);
    assert.deepEqual(clashes[0].others.map((o) => o.bookId), ["mh"]);

    /* Answered "keep where it is": the new list leaves it out, and nothing clashes. */
    const kept = { scopes: [...added.scopes, scope("ngp", "customer", "a", { excluded: true })], lists };
    assert.equal(introducedClashes([geo("a")], fresh, kept, "ngp", DAY).length, 0);
    /* Answered "move here": the old list leaves it out. */
    const moved = { scopes: [...added.scopes, scope("mh", "customer", "a", { excluded: true })], lists };
    assert.equal(introducedClashes([geo("a")], fresh, moved, "ngp", DAY).length, 0);
  });
});
