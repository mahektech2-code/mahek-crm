import { test } from "node:test";
import assert from "node:assert/strict";
import { chainFromRow, indexPlaces, matchTypedPlace, placeLine, type PlaceNode } from "./place-tree";
import { placePickPatch, placeFilterParams, anyPlacePicked } from "./place-filters";

/* A small tree with the two traps the real one carries: a town name shared by
   two states (Nagpur), and an area typed as though it were the city. */
const N = (id: string, kind: PlaceNode["kind"], name: string, parentId: string | null, shops = 1): PlaceNode => ({
  id,
  kind,
  name,
  key: name.toLowerCase().replace(/[^a-z0-9]/g, ""),
  parentId,
  shops,
});
const TREE = indexPlaces([
  N("mh", "state", "Maharashtra", null, 300),
  N("mp", "state", "Madhya Pradesh", null, 50),
  N("d-mum", "district", "Mumbai", "mh", 240),
  N("d-ngp", "district", "Nagpur", "mh", 230),
  N("d-nimar", "district", "East Nimar", "mp", 3),
  N("c-mum", "city", "Mumbai", "d-mum", 240),
  N("c-ngp", "city", "Nagpur", "d-ngp", 223),
  N("c-ngp-mp", "city", "Nagpur", "d-nimar", 1),
  N("a-bhandup", "area", "Bhandup", "c-mum", 6),
  N("a-sadar-1", "area", "Sadar", "c-ngp", 4),
  N("a-sadar-2", "area", "Sadar", "c-mum", 2),
]);

test("a reviewed row becomes a chain, and a hole in it is refused", () => {
  assert.deepEqual(chainFromRow({ state: "Maharashtra", district: "Mumbai", city: "Mumbai", area: "" }), [
    { kind: "state", name: "Maharashtra" },
    { kind: "district", name: "Mumbai" },
    { kind: "city", name: "Mumbai" },
  ]);
  assert.equal(chainFromRow({ state: "Maharashtra", district: "", city: "Pawane" }), null);
});

test("the region names the state and the typed city is found under it", () => {
  assert.deepEqual(matchTypedPlace(TREE, { region: "MAHARASHTRA", city: "nagpur", address: null }), {
    state: "mh",
    district: "d-ngp",
    city: "c-ngp",
  });
});

test("a suburb typed as the city lands as an area under its city", () => {
  assert.deepEqual(matchTypedPlace(TREE, { region: "Maharashtra", city: "Bhandup", address: null }), {
    state: "mh",
    district: "d-mum",
    city: "c-mum",
    area: "a-bhandup",
  });
});

test("two areas of one name in a state is no answer — the shop stays at its state", () => {
  assert.deepEqual(matchTypedPlace(TREE, { region: "Maharashtra", city: "Sadar", address: null }), {
    state: "mh",
  });
});

test("no region: the state is read off the address", () => {
  const ids = matchTypedPlace(TREE, {
    region: null,
    city: "Somewhere Road",
    address: "Shop 4, Bhandup, Mumbai, Maharashtra 400078, India",
  });
  assert.equal(ids.state, "mh");
  assert.equal(ids.city, "c-mum");
  assert.equal(ids.area, "a-bhandup");
});

test("no state anywhere: an overwhelming namesake wins, a close one does not", () => {
  assert.equal(matchTypedPlace(TREE, { region: null, city: "Nagpur", address: null }).city, "c-ngp");
  assert.deepEqual(matchTypedPlace(TREE, { region: null, city: "Sadar", address: null }), {});
});

test("a place reads narrowest first, and a district that repeats the city is dropped", () => {
  assert.equal(
    placeLine({ state: "Maharashtra", district: "Mumbai", city: "Mumbai", area: "Bhandup" }),
    "Bhandup, Mumbai, Maharashtra",
  );
  assert.equal(
    placeLine({ state: "Maharashtra", district: "Thane", city: "Bhiwandi", area: null }),
    "Bhiwandi, Thane, Maharashtra",
  );
});

test("changing a rung clears the rungs below it and nothing above", () => {
  assert.deepEqual(placePickPatch("district", ["d-mum"]), {
    district: "d-mum",
    city: undefined,
    area: undefined,
  });
  assert.deepEqual(placePickPatch("state", []), {
    state: undefined,
    district: undefined,
    city: undefined,
    area: undefined,
  });
});

test("the four are read off the URL and an empty one is no filter", () => {
  const params: Record<string, string> = { state: "mh", city: "" };
  const values = placeFilterParams((k) => params[k] || undefined);
  assert.deepEqual(values, { state: "mh" });
  assert.equal(anyPlacePicked(values), true);
  assert.equal(anyPlacePicked({}), false);
});
