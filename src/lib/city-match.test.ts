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
