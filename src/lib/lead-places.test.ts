import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodePlace,
  decodePlaces,
  encodePlace,
  placeLabel,
  placeSentence,
  samePlace,
} from "./lead-places";
import { splitFilter } from "./lead-filters";

test("a plain pick reads as itself in the URL", () => {
  assert.equal(encodePlace({ state: "Maharashtra" }), "Maharashtra");
  assert.equal(encodePlace({ state: "Maharashtra", city: "Nagpur" }), "Maharashtra>Nagpur");
  assert.equal(
    encodePlace({ state: "Maharashtra", city: "Nagpur", beat: "Sadar" }),
    "Maharashtra>Nagpur>Sadar",
  );
});

test("a city carrying commas survives the comma-separated parameter", () => {
  /* 355 of the 1,165 city strings on the real book carry a comma. Unescaped,
     one pick becomes eight that all have to match, and the filter answers
     nothing with no screen saying why. */
  const pick = {
    state: "Maharashtra",
    city: "06, MAHADEV TOWERS CO-OP HSG SOC, LTD, LBS MARG, Thane, 400602",
  };
  const param = [encodePlace(pick), encodePlace({ state: "Kerala" })].join(",");

  assert.equal(splitFilter(param).length, 2, "two picks, however many commas are inside one");
  assert.deepEqual(decodePlaces(splitFilter(param)), [pick, { state: "Kerala" }]);
});

test("a rung separator typed into a city name does not split it", () => {
  const pick = { state: "Goa", city: "A > B" };
  assert.deepEqual(decodePlace(encodePlace(pick)), pick);
});

test("a percent sign round trips rather than eating the escaping", () => {
  const pick = { state: "Kerala", city: "100% Cotton Lane, Kochi" };
  assert.deepEqual(decodePlace(encodePlace(pick)), pick);
});

test("a path anybody could type is read as far as it makes sense", () => {
  assert.equal(decodePlace(""), null);
  assert.equal(decodePlace(">>"), null);
  assert.deepEqual(decodePlace("Maharashtra>"), { state: "Maharashtra" });
  /* A fourth rung is dropped rather than refused: there are three, and a
     screen that will not draw over a typo is worse than a wider list. */
  assert.deepEqual(decodePlace("A>B>C>D"), { state: "A", city: "B", beat: "C" });
});

test("two spellings of one place are one place", () => {
  assert.ok(samePlace({ state: "Kerala", city: "Kochi" }, { state: " kerala ", city: "KOCHI" }));
  assert.ok(!samePlace({ state: "Kerala" }, { state: "Kerala", city: "Kochi" }));
});

test("the chip names the narrowest rung and the one above it", () => {
  assert.equal(placeLabel({ state: "Maharashtra" }), "Maharashtra");
  assert.equal(placeLabel({ state: "Maharashtra", city: "Nagpur" }), "Nagpur in Maharashtra");
  assert.equal(
    placeLabel({ state: "Maharashtra", city: "Nagpur", beat: "Sadar" }),
    "Sadar in Nagpur",
  );
});

test("the sentence says a whole state is a whole state", () => {
  assert.equal(placeSentence([]), "everywhere");
  assert.equal(
    placeSentence([{ state: "Kerala" }, { state: "Maharashtra", city: "Nagpur" }]),
    "the whole of Kerala; Nagpur in Maharashtra",
  );
});
