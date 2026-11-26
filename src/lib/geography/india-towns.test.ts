import { test } from "node:test";
import assert from "node:assert/strict";

import { placeKey } from "../place-parse";
import { INDIA_GEOGRAPHY } from "./india-districts";
import { INDIA_TOWNS, UNRESOLVED_TOWNS, townsOf } from "./india-towns";
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

test("5,078 local bodies are kept: listed under a district, or marked unresolved", () => {
  const codes = new Set([...all.map((t) => t[1]), ...UNRESOLVED_TOWNS.map((u) => u.code)]);
  assert.equal(codes.size, 5078);
  assert.equal(all.length, 5094);
  assert.equal(UNRESOLVED_TOWNS.length, 19);
  assert.ok(all.every((t) => t[0] && /^\d+$/.test(t[1]!) && t[2]), "a name, a numeric code and a type on every row");
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
