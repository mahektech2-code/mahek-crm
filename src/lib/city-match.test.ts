import { test } from "node:test";
import assert from "node:assert/strict";

import { cityKey, hasNoPlace, matchesCity, splitBook } from "./city-match";

/**
 * The rules the journey picker filters on. Pinned because every one of them
 * fails QUIETLY: a day gets arranged out of the wrong list and nothing on the
 * screen looks broken.
 */

test("case and punctuation are folded — this book spells Gwalior two ways", () => {
  assert.equal(cityKey("GWALIOR"), "gwalior");
  assert.equal(cityKey("Gwalior"), "gwalior");
  assert.ok(matchesCity({ city: "GWALIOR" }, "Gwalior"));
  assert.ok(matchesCity({ city: "Gwalior" }, "GWALIOR"));
});

test("a city buried in a postal address is still that city", () => {
  const row = {
    city: "06, MAHADEV TOWERS CO-OP HSG SOC, LTD, LBS MARG, HARINIWAS CIRCLE, Thane, Maharashtra, 400602",
  };
  assert.ok(matchesCity(row, "Thane"));
  assert.ok(!matchesCity(row, "Pune"));
});

test("a WHOLE word, so Pune does not match Punewadi Road", () => {
  assert.ok(!matchesCity({ city: "Punewadi Road" }, "Pune"));
  assert.ok(matchesCity({ city: "Shop 4, Punewadi Road, Pune" }, "Pune"));
});

test("the area and the beat are looked at too", () => {
  assert.ok(matchesCity({ city: null, area: "Indore" }, "indore"));
  assert.ok(matchesCity({ city: "Gole Bazar", beat: "Rewa" }, "Rewa"));
});

test("a shop nothing can place is its own answer, not 'elsewhere'", () => {
  assert.ok(hasNoPlace({ city: null, area: null, beat: null }));
  assert.ok(hasNoPlace({ city: "   ", area: "-" }));
  assert.ok(!hasNoPlace({ city: "Bhopal" }));
});

test('the placeholder "Unknown" the server writes for a lead with no town is no place', () => {
  assert.ok(hasNoPlace({ city: "Unknown" }));
  assert.ok(hasNoPlace({ city: "UNKNOWN" }));
  assert.ok(hasNoPlace({ city: " unknown " }));
  assert.ok(hasNoPlace({ city: "Unknown." }));
  assert.ok(hasNoPlace({ city: "Unknown", area: null, beat: "Unknown" }));
});

test('"Unknown" beside a real area, or inside a real address, is still a place', () => {
  assert.ok(!hasNoPlace({ city: "Unknown", area: "Mahad" }));
  assert.ok(!hasNoPlace({ city: "Unknown", beat: "Mahad" }));
  assert.ok(!hasNoPlace({ city: "Unknown Road, Mahad" }));
});

test('a lead with city "Unknown" goes to the shops nothing can place', () => {
  const { here, elsewhere, unplaceable } = splitBook([{ id: "x", city: "Unknown" }], "Mahad");
  assert.deepEqual(unplaceable.map((r) => r.id), ["x"]);
  assert.equal(here.length, 0);
  assert.equal(elsewhere.length, 0);
});

test('a lead with city "Unknown" but area Mahad is still in Mahad', () => {
  const { here, elsewhere, unplaceable } = splitBook(
    [{ id: "x", city: "Unknown", area: "Mahad" }],
    "Mahad",
  );
  assert.deepEqual(here.map((r) => r.id), ["x"]);
  assert.equal(elsewhere.length, 0);
  assert.equal(unplaceable.length, 0);
});

test("a real city elsewhere is still elsewhere", () => {
  const { here, elsewhere, unplaceable } = splitBook([{ id: "b", city: "Bhopal" }], "Mahad");
  assert.deepEqual(elsewhere.map((r) => r.id), ["b"]);
  assert.equal(here.length, 0);
  assert.equal(unplaceable.length, 0);
});

test("with the placeholder in the mix, nothing is lost", () => {
  const book = [
    { id: "a", city: "Mahad" },
    { id: "b", city: "Bhopal" },
    { id: "c", city: "Unknown" },
    { id: "d", city: "Unknown", area: "Mahad" },
    { id: "e", city: null },
  ];
  const { here, elsewhere, unplaceable } = splitBook(book, "Mahad");
  assert.deepEqual(here.map((r) => r.id), ["a", "d"]);
  assert.deepEqual(elsewhere.map((r) => r.id), ["b"]);
  assert.deepEqual(unplaceable.map((r) => r.id), ["c", "e"]);
  assert.equal(here.length + elsewhere.length + unplaceable.length, book.length);
});

test("the book splits three ways, and nothing is lost", () => {
  const book = [
    { id: "a", city: "Gwalior" },
    { id: "b", city: "GWALIOR" },
    { id: "c", city: "Bhopal" },
    { id: "d", city: null },
  ];
  const { here, elsewhere, unplaceable } = splitBook(book, "gwalior");
  assert.deepEqual(here.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(elsewhere.map((r) => r.id), ["c"]);
  assert.deepEqual(unplaceable.map((r) => r.id), ["d"]);
  assert.equal(here.length + elsewhere.length + unplaceable.length, book.length);
});

test("NO city proposed leaves the book exactly as it was", () => {
  const book = [{ city: "Bhopal" }, { city: null }];
  const split = splitBook(book, "  ");
  assert.equal(split.here.length, 2, "nothing to be elsewhere of");
  assert.equal(split.elsewhere.length, 0);
  assert.equal(split.unplaceable.length, 0);
});
