import { test } from "node:test";
import assert from "node:assert/strict";

import { citiesInWords, cityColumns, normaliseCities, planCityList, sameCityList } from "./journey-cities";
import { splitBook, splitBookMany } from "./city-match";
import { dayWhere } from "./journey-days";

test("normaliseCities keeps the order, drops blanks, and folds spellings of one city into the first", () => {
  assert.deepEqual(normaliseCities("Pune", ["Thane", " pune ", "", "THANE", "Nagpur"]), ["Pune", "Thane", "Nagpur"]);
  assert.deepEqual(normaliseCities(null, undefined, [null, "  "]), []);
  assert.deepEqual(normaliseCities("  New   Delhi "), ["New Delhi"], "whitespace is collapsed, the words are kept");
});

test("there is no maximum", () => {
  const many = Array.from({ length: 40 }, (_, i) => `City ${i}`);
  assert.equal(normaliseCities(many).length, 40);
});

test("planCityList: `cities` where set, otherwise just `city`, otherwise nothing", () => {
  assert.deepEqual(planCityList({ city: "Pune", cities: null }), ["Pune"]);
  assert.deepEqual(planCityList({ city: "Pune" }), ["Pune"]);
  assert.deepEqual(planCityList({ city: "Pune", cities: ["Pune", "Thane"] }), ["Pune", "Thane"]);
  assert.deepEqual(planCityList({ city: "Pune", cities: ["Thane"] }), ["Pune", "Thane"], "the primary is always first");
  assert.deepEqual(planCityList({ city: null, cities: null }), []);
});

test("cityColumns: `city` is the first and is never a joined string; `cities` only where there are several", () => {
  assert.deepEqual(cityColumns(["Pune"]), { city: "Pune", cities: null });
  assert.deepEqual(cityColumns(["Pune", "Thane"]), { city: "Pune", cities: ["Pune", "Thane"] });
  assert.deepEqual(cityColumns([]), { city: null, cities: null });
  assert.ok(!/[,;/]/.test(cityColumns(["Pune", "Thane", "Nagpur"]).city ?? ""));
});

test("sameCityList compares the cities and their order — the first is the primary", () => {
  assert.equal(sameCityList(["Pune", "Thane"], ["pune", "THANE"]), true);
  assert.equal(sameCityList(["Pune", "Thane"], ["Thane", "Pune"]), false);
  assert.equal(sameCityList([], []), true);
  assert.equal(sameCityList(["Pune"], ["Pune", "Thane"]), false);
});

test("citiesInWords", () => {
  assert.equal(citiesInWords(["Pune"]), "Pune");
  assert.equal(citiesInWords(["Pune", "Thane"]), "Pune and Thane");
  assert.equal(citiesInWords(["Pune", "Thane", "Nagpur"]), "Pune, Thane and Nagpur");
  assert.equal(citiesInWords([]), "");
});

const BOOK = [
  { id: "1", city: "Pune", area: null, beat: null },
  { id: "2", city: "Thane", area: null, beat: null },
  { id: "3", city: "06, Mahadev Towers, LBS Marg, Thane, Maharashtra, 400602", area: null, beat: null },
  { id: "4", city: "Nagpur", area: "Sitabuldi", beat: null },
  { id: "5", city: null, area: null, beat: null },
  { id: "6", city: "Bhopal", area: null, beat: null },
];

test("splitBookMany with ONE city is identical to splitBook, row for row", () => {
  for (const city of ["Pune", "Thane", "Nagpur", "Sitabuldi", "Bhopal", "Wardha"]) {
    assert.deepEqual(splitBookMany(BOOK, [city]), splitBook(BOOK, city), city);
  }
});

test("splitBookMany with several cities is the union: a shop in ANY of them is here", () => {
  const r = splitBookMany(BOOK, ["Pune", "Thane"]);
  assert.deepEqual(r.here.map((c) => c.id), ["1", "2", "3"], "an address with the town in it still counts, as it always did");
  assert.deepEqual(r.elsewhere.map((c) => c.id), ["4", "6"]);
  assert.deepEqual(r.unplaceable.map((c) => c.id), ["5"], "a shop nobody can place is named, never filed under somewhere else");
});

test("splitBookMany with no city names puts the whole book here, as an empty city always did", () => {
  assert.deepEqual(splitBookMany(BOOK, []), splitBook(BOOK, ""));
  assert.deepEqual(splitBookMany(BOOK, ["", "  "]), splitBook(BOOK, ""));
});

test("dayWhere: one city reads exactly as it did; several are all said, primary first", () => {
  assert.deepEqual(dayWhere({ city: "Pune" }), { text: "Pune", fromShops: false });
  assert.deepEqual(dayWhere({ city: "Pune", cities: null }), { text: "Pune", fromShops: false });
  assert.deepEqual(dayWhere({ city: "Pune", cities: ["Pune", "Thane", "Nagpur"] }), {
    text: "Pune, Thane, Nagpur",
    fromShops: false,
  });
  assert.deepEqual(dayWhere({ city: null, shopCities: ["Pune"] }), { text: "Pune", fromShops: true }, "no city: read off the shops, as before");
  assert.deepEqual(dayWhere({ city: null, beat: "Camp" }), { text: "Camp", fromShops: false });
  assert.deepEqual(dayWhere({ city: null }), { text: null, fromShops: false });
});
