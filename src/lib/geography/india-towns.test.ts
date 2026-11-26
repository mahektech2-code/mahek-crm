import { test } from "node:test";
import assert from "node:assert/strict";

import { placeKey } from "../place-parse";
import { INDIA_GEOGRAPHY } from "./india-districts";
import { INDIA_TOWNS, TOWN_CORRECTIONS, UNRESOLVED_TOWNS, townsOf } from "./india-towns";
import { zeroShopProblem, zeroShopTowns } from "./territory-options";
import { mergeMasterWithBook } from "./territory-options";
import type { PlaceTree } from "../services/sales-service";

const all = Object.values(INDIA_TOWNS).flatMap((d) => Object.values(d).flat());

test("every state and district the town list names is on the master", () => {
  for (const [state, districts] of Object.entries(INDIA_TOWNS)) {
    const master = INDIA_GEOGRAPHY.find((s) => s.name === state);
    assert.ok(master, state);
    for (const district of Object.keys(districts)) {
      assert.ok(master!.districts.some((d) => d.name === district), `${state} / ${district}`);
    }
  }
});

test("every source body is kept, unresolved, or removed by a named correction", () => {
  const codes = new Set([...all.map((t) => t[1]), ...UNRESOLVED_TOWNS.map((u) => u.code)].filter(Boolean));
  assert.equal(codes.size, 5075);
  assert.equal(new Set(TOWN_CORRECTIONS.removed.map((r) => r.code)).size, 3);
  assert.equal(all.length, 5083);
  assert.equal(UNRESOLVED_TOWNS.length, 19);
  assert.ok(all.every((t) => t[0] && t[2]), "a name and a type on every row");
  assert.deepEqual(
    all.filter((t) => !/^\d+$/.test(t[1]!)).map((t) => [t[0], t[1]]),
    [["Delhi Cantonment Board", ""]],
    "only the correction has no code, and none is invented",
  );
});

test("Delhi: the three merged corporations are gone, and nothing is invented for the unified one", () => {
  assert.deepEqual(Object.keys(INDIA_TOWNS.Delhi!), ["New Delhi"]);
  assert.deepEqual(townsOf("Delhi", "New Delhi").map((t) => t[0]).sort(), ["Delhi Cantonment Board", "New Delhi Municipal Council"]);
  assert.ok(!all.some((t) => /(North|South|East) Delhi Municipal Corporation|^Municipal Corporation of Delhi$/i.test(t[0]!)));
});

test("a picked town with no shop is named; one with shops, and a whole district, are not", () => {
  const tree: PlaceTree = {
    statelessShops: 0,
    states: [{ state: "Maharashtra", shops: 4, undistricted: 0, districts: [{ district: "Raigad", shops: 4, towns: [{ town: "Panvel", shops: 4 }, { town: "Karjat", shops: 0 }] }] }],
  };
  const town = (value: string) => ({ kind: "town", value, parent: "Raigad, Maharashtra" });
  assert.deepEqual(zeroShopTowns(tree, [town("panvel")]), []);
  assert.deepEqual(zeroShopTowns(tree, [{ kind: "district", value: "Raigad", parent: "Maharashtra" }]), []);
  assert.deepEqual(zeroShopTowns(tree, [town("Karjat"), town("Panvel"), town("Nowhere")]), ["Karjat · Raigad", "Nowhere · Raigad"]);
});

test("a changed save with a zero-shop town is refused until that very town is confirmed", () => {
  const towns = ["Karjat · Raigad"];
  assert.equal(zeroShopProblem({ changed: false, towns, acknowledged: undefined }), null);
  assert.equal(zeroShopProblem({ changed: true, towns: [], acknowledged: undefined }), null);
  assert.match(zeroShopProblem({ changed: true, towns, acknowledged: undefined }) ?? "", /Karjat · Raigad has no shops/);
  assert.match(zeroShopProblem({ changed: true, towns, acknowledged: ["Pen · Raigad"] }) ?? "", /Confirm/);
  assert.equal(zeroShopProblem({ changed: true, towns, acknowledged: towns }), null);
});

test("a district offers its towns at zero after the book's, each name once", () => {
  const book: PlaceTree = {
    statelessShops: 0,
    states: [{ state: "Maharashtra", shops: 4, undistricted: 0, districts: [{ district: "Raigad", shops: 4, towns: [{ town: "panvel", shops: 4 }] }] }],
  };
  const raigad = mergeMasterWithBook(book).states.find((s) => s.state === "Maharashtra")!.districts.find((d) => d.district === "Raigad")!;
  assert.deepEqual(raigad.towns[0], { town: "panvel", shops: 4 });
  const keys = raigad.towns.map((t) => placeKey(t.town));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(townsOf("Maharashtra", "Raigad").length > 1);
  assert.ok(raigad.towns.length >= townsOf("Maharashtra", "Raigad").length);
});
