import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loopThrough, reportsToRefusal, type ReportsToPerson } from "./reports-to";

/* Asha → Ravi → Kiran (Kiran at the top), plus Dev on his own and Old, who
   has been deactivated. */
const people: ReportsToPerson[] = [
  { id: "kiran", name: "Kiran", active: true, reportsToId: null },
  { id: "ravi", name: "Ravi", active: true, reportsToId: "kiran" },
  { id: "asha", name: "Asha", active: true, reportsToId: "ravi" },
  { id: "dev", name: "Dev", active: true, reportsToId: null },
  { id: "old", name: "Old", active: false, reportsToId: null },
];
const up = (id: string) => people.find((p) => p.id === id)?.reportsToId ?? null;

test("a manager outside the chain closes no loop", () => {
  assert.equal(loopThrough("asha", "dev", up), null);
  assert.equal(loopThrough("kiran", "dev", up), null);
});

test("putting the top of a chain under somebody below them is a loop, and the path says how", () => {
  assert.deepEqual(loopThrough("kiran", "asha", up), ["asha", "ravi", "kiran"]);
  assert.deepEqual(loopThrough("kiran", "ravi", up), ["ravi", "kiran"]);
});

test("moving somebody further UP their own chain is not a loop", () => {
  assert.equal(loopThrough("asha", "kiran", up), null);
});

test("a loop already in the data above is stopped, not followed for ever", () => {
  const looped: Record<string, string | null> = { a: "b", b: "a", c: null };
  assert.equal(loopThrough("c", "a", (id) => looped[id] ?? null), null);
});

test("the refusals, in words", () => {
  assert.equal(reportsToRefusal("asha", null, people), null, "reporting to nobody is always allowed");
  assert.equal(reportsToRefusal("asha", "dev", people), null);
  assert.match(reportsToRefusal("asha", "asha", people) ?? "", /themselves/);
  assert.match(reportsToRefusal("asha", "nobody-here", people) ?? "", /no longer exists/);
  assert.match(reportsToRefusal("asha", "old", people) ?? "", /deactivated/);
  const loop = reportsToRefusal("kiran", "asha", people) ?? "";
  assert.match(loop, /loop/);
  assert.match(loop, /Asha → Ravi → Kiran/);
});
