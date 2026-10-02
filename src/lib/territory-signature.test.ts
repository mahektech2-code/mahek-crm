import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { areasSignature } from "./territory-signature";

test("the office and the handset compute the signature with the same code", () => {
  assert.equal(
    readFileSync("mbos-app/src/lib/territory-signature.ts", "utf8"),
    readFileSync("src/lib/territory-signature.ts", "utf8"),
    "the two copies of territory-signature.ts have drifted — an acceptance would read as stale, or as current, wrongly",
  );
});

test("order, case, spacing and regions do not change the signature", () => {
  const a = areasSignature([
    { kind: "city", value: "Pune", parent: "Maharashtra" },
    { kind: "state", value: "Goa", parent: null },
    { kind: "region", value: "West", parent: "" },
  ]);
  const b = areasSignature([
    { kind: "state", value: " goa ", parent: "" },
    { kind: "city", value: "PUNE", parent: "maharashtra" },
  ]);
  assert.equal(a, b);
});

test("a changed allocation is a different signature", () => {
  assert.notEqual(
    areasSignature([{ kind: "city", value: "Pune", parent: "Maharashtra" }]),
    areasSignature([{ kind: "city", value: "Nashik", parent: "Maharashtra" }]),
  );
  assert.equal(areasSignature([]), "");
});
