import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromHometown } from "./expense-hometown";

const base = {
  hometown: "Nagpur",
  visitCities: [],
  destinationCity: null,
  overnight: false,
  recorded: true,
};

test("no hometown keeps what the handset recorded", () => {
  assert.equal(
    awayFromHometown({ ...base, hometown: null, recorded: true }),
    true,
  );
  assert.equal(
    awayFromHometown({ ...base, hometown: "  ", recorded: false }),
    false,
  );
});

test("a day of shops in his own town is a day at home, whatever the spelling", () => {
  assert.equal(
    awayFromHometown({ ...base, visitCities: ["NAGPUR", "nagpur ", null] }),
    false,
  );
});

test("one shop in another town makes it a day away", () => {
  assert.equal(
    awayFromHometown({ ...base, visitCities: ["Nagpur", "Wardha"] }),
    true,
  );
});

test("a named destination elsewhere, or a night out, is a day away", () => {
  assert.equal(
    awayFromHometown({ ...base, destinationCity: "Amravati" }),
    true,
  );
  assert.equal(awayFromHometown({ ...base, overnight: true }), true);
});

test("a day with no visits and no destination is at home", () => {
  assert.equal(awayFromHometown(base), false);
});

test("a town typed as a whole address is home when it names the hometown", () => {
  assert.equal(
    awayFromHometown({
      ...base,
      hometown: "Thane",
      visitCities: ["06, Mahadev Towers, LBS Marg, Thane, Maharashtra"],
    }),
    false,
  );
});
