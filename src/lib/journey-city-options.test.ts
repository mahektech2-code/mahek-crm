import { test } from "node:test";
import assert from "node:assert/strict";
import { allocatedCities, proposeCityOptions } from "./journey-city-options";
import { normaliseCities } from "./journey-cities";

const book = ["Pune", "Nagpur", "Kolhapur", "", null, "Pune"];

test("allocated cities come before book cities", () => {
  const out = proposeCityOptions([{ kind: "town", value: "Wardha" }], book);
  assert.deepEqual(out, ["Wardha", "Kolhapur", "Nagpur", "Pune"]);
});

test("a name in both lists appears once, in the allocated position", () => {
  const out = proposeCityOptions([{ kind: "town", value: "Pune" }, { kind: "town", value: "Akola" }], book);
  assert.deepEqual(out, ["Akola", "Pune", "Kolhapur", "Nagpur"]);
});

test("case and punctuation folds are one entry and the allocated spelling wins", () => {
  const out = proposeCityOptions([{ kind: "town", value: "Kolhapur" }], ["KOLHAPUR", "Nagpur"]);
  assert.deepEqual(out, ["Kolhapur", "Nagpur"]);
});

test("no allocation leaves exactly the old book list: unique, sorted", () => {
  const old = [...new Set(book.filter(Boolean))].sort();
  assert.deepEqual(proposeCityOptions([], book), old);
  assert.deepEqual(proposeCityOptions([{ kind: "state", value: "Maharashtra" }, { kind: "district", value: "Pune" }], book), old);
});

test("legacy city rows and current town rows both count; beat, district, state, region do not", () => {
  const rows = [
    { kind: "city", value: "Satara" },
    { kind: "town", value: "Karad" },
    { kind: "beat", value: "Camp" },
    { kind: "district", value: "Kolhapur" },
    { kind: "state", value: "Maharashtra" },
    { kind: "region", value: "West" },
  ];
  assert.deepEqual(allocatedCities(rows), ["Karad", "Satara"]);
});

test("distinct names are never merged into one", () => {
  const out = proposeCityOptions([{ kind: "town", value: "Pimpri-Chinchwad" }, { kind: "town", value: "Pune" }], []);
  assert.deepEqual(out, ["Pimpri-Chinchwad", "Pune"]);
});

test("an allocated town with no customers is offered; free text still goes through normaliseCities", () => {
  assert.deepEqual(proposeCityOptions([{ kind: "town", value: "Sikkim Town" }], []), ["Sikkim Town"]);
  // The box adds whatever is typed, whether or not it is on the list.
  assert.deepEqual(normaliseCities(["Pune"], "A town nobody sold in"), ["Pune", "A town nobody sold in"]);
});

test("official-geography cities sit after working towns and before the book, once each", () => {
  const out = proposeCityOptions([{ kind: "town", value: "Wardha" }], ["Nagpur", "Kolhapur"], ["Kolhapur", "Chandgad."]);
  assert.deepEqual(out, ["Wardha", "Chandgad.", "Kolhapur", "Nagpur"]);
});

test("with nothing allocated anywhere the list is still exactly his book", () => {
  assert.deepEqual(proposeCityOptions([], ["Pune", "Akola"], []), ["Akola", "Pune"]);
});
