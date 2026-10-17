import { test } from "node:test";
import assert from "node:assert/strict";
import { godownAt } from "./godown-fence";

const AMBERNATH = { id: "g1", name: "Ambernath", lat: 19.2094, lng: 73.1856 };
const BHIWANDI = { id: "g2", name: "Bhiwandi", lat: 19.2967, lng: 73.0631 };

test("a fix inside one fence picks that godown", () => {
  const v = godownAt([AMBERNATH, BHIWANDI], { lat: 19.2967, lng: 73.0641, accuracyM: 20 }, 300);
  assert.equal(v.kind, "inside");
  assert.equal(v.kind === "inside" && v.godown.name, "Bhiwandi");
});

test("outside every fence names the nearest but switches nothing", () => {
  const v = godownAt([AMBERNATH, BHIWANDI], { lat: 19.25, lng: 73.12, accuracyM: 15 }, 300);
  assert.equal(v.kind, "outside");
  assert.ok(v.kind === "outside" && v.nearest && v.nearest.metres > 300);
});

test("an accuracy circle wider than the fence is not a verdict", () => {
  const v = godownAt([BHIWANDI], { lat: 19.2967, lng: 73.0631, accuracyM: 1200 }, 300);
  assert.deepEqual(v, { kind: "imprecise", accuracyM: 1200 });
});

test("an unknown accuracy is measured, not refused", () => {
  assert.equal(godownAt([BHIWANDI], { lat: 19.2967, lng: 73.0631, accuracyM: null }, 300).kind, "inside");
});

test("a godown without a pin can never be found by location", () => {
  assert.deepEqual(
    godownAt([{ id: "g3", name: "Nagpur", lat: null, lng: null }], { lat: 21.1, lng: 79.0, accuracyM: 10 }, 300),
    { kind: "unpinned" },
  );
});

test("where two fences overlap the nearer pin wins", () => {
  const near = { id: "a", name: "Yard A", lat: 19.0, lng: 73.0 };
  const far = { id: "b", name: "Yard B", lat: 19.0, lng: 73.002 };
  const v = godownAt([far, near], { lat: 19.0, lng: 73.0005, accuracyM: 10 }, 500);
  assert.equal(v.kind === "inside" && v.godown.id, "a");
});
