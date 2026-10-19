import { test } from "node:test";
import assert from "node:assert/strict";
import { matchOptions, matcher, nearEnd } from "./option-match";

const SKUS = [
  "Mahek Universal Thinner - 0.5 Liter (25 Can/Box)",
  "Mahek Universal Thinner - 0.5 Liter (Loose)",
  "Mahek Universal Thinner - 1 Liter (16 Can/Box)",
  "Mahek Universal Thinner - 1 Liter (32 Can/Box)",
  "Mahek Universal Thinner - 5 Liter (Loose)",
  "Mahek Universal Thinner - 20 Liter (Loose)",
  "Nano Thinner - 1 Liter (12 Can/Box)",
];

test("every word typed must appear, in any order", () => {
  assert.deepEqual(matchOptions(SKUS, "universal 1 liter"), [SKUS[2], SKUS[3]]);
  assert.deepEqual(matchOptions(SKUS, "1 liter universal"), [SKUS[2], SKUS[3]]);
  assert.deepEqual(matchOptions(SKUS, "nano universal"), []);
});

test("a pack size is found however it is typed", () => {
  for (const q of ["universal 1liter", "universal 1 ltr", "universal 1 litre", "universal 1l", "Universal 1 LITER"])
    assert.deepEqual(matchOptions(SKUS, q), [SKUS[2], SKUS[3]], q);
});

test("a number matches the whole size, not part of another", () => {
  assert.deepEqual(matchOptions(SKUS, "universal 20"), [SKUS[5]]);
  assert.deepEqual(matchOptions(SKUS, "universal 0.5"), [SKUS[0], SKUS[1]]);
});

test("1 does not find 16, but a last number being typed does", () => {
  const opts = ["Universal 16 Liter (Loose)", "Universal 1 Liter (Loose)"];
  assert.deepEqual(matchOptions(opts, "universal 1 liter"), ["Universal 1 Liter (Loose)"]);
  assert.deepEqual(matchOptions(opts, "universal 1"), opts);
});

test("a word still being typed matches", () => {
  assert.deepEqual(matchOptions(SKUS, "univ loo"), [SKUS[1], SKUS[4], SKUS[5]]);
});

test("the whole phrase ranks first, then the given order", () => {
  const opts = ["Thinner Universal blend", "Universal Thinner"];
  assert.deepEqual(matchOptions(opts, "universal thinner"), ["Universal Thinner", "Thinner Universal blend"]);
  assert.equal(matcher("")("anything"), 0);
});

test("an empty query keeps every option, in order", () => {
  assert.deepEqual(matchOptions(SKUS, "  "), SKUS);
});

test("objects are searched on what the caller reads", () => {
  const items = [{ l: "Bhiwandi", sub: "Thane" }, { l: "Nagpur", sub: "Vidarbha" }];
  assert.deepEqual(matchOptions(items, "thane", (i) => `${i.l} ${i.sub}`), [items[0]]);
});

test("a list near its end draws the next rows", () => {
  assert.equal(nearEnd({ scrollTop: 800, clientHeight: 300, scrollHeight: 1150 }), true);
  assert.equal(nearEnd({ scrollTop: 0, clientHeight: 300, scrollHeight: 1150 }), false);
});
