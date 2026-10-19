/**
 * The stock cache's bounds (`ledger-cache-policy.ts`): what it holds is
 * counted in rows, a moved stamp empties it, and a page's own lot list is
 * never kept. These are what stopped it filling the heap between requests.
 *
 *   npm run test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StampedRowCache } from "./ledger-cache-policy";

const policy = { maxRows: 100, maxParams: 3 };

test("an answer is kept under its stamp and found again under it", () => {
  const c = new StampedRowCache<string>(policy);
  c.set("a", "1:1", "rows of a", 10);
  assert.equal(c.get("a", "1:1"), "rows of a");
});

test("a moved stamp empties the cache: nothing under the old one can be asked for again", () => {
  const c = new StampedRowCache<string>(policy);
  c.set("a", "1:1", "x", 10);
  c.set("b", "1:1", "y", 10);
  assert.equal(c.get("a", "2:5"), undefined);
  assert.deepEqual(c.size(), { entries: 0, rows: 0 }, "the stale answers are gone, not merely unanswered");
});

test("what is kept adds up to the row budget, the oldest dropped first", () => {
  const c = new StampedRowCache<string>(policy);
  c.set("a", "s", "a", 40);
  c.set("b", "s", "b", 40);
  c.get("a", "s");
  c.set("c", "s", "c", 40);
  assert.equal(c.get("b", "s"), undefined, "b was the least recently asked");
  assert.equal(c.get("a", "s"), "a");
  assert.equal(c.get("c", "s"), "c");
  assert.ok(c.size().rows <= policy.maxRows);
});

test("one answer larger than the whole budget is not kept", () => {
  const c = new StampedRowCache<string>(policy);
  c.set("big", "s", "big", 101);
  assert.equal(c.get("big", "s"), undefined);
  assert.deepEqual(c.size(), { entries: 0, rows: 0 });
});

test("re-keeping an answer replaces it rather than counting it twice", () => {
  const c = new StampedRowCache<string>(policy);
  c.set("a", "s", "pending", 0);
  c.set("a", "s", "landed", 30);
  assert.deepEqual(c.size(), { entries: 1, rows: 30 });
});

test("a statement with a long parameter list — a page's own lots — is not admitted", () => {
  const c = new StampedRowCache<string>(policy);
  assert.ok(c.admits(3));
  assert.ok(!c.admits(4));
});

test("a read that lands after the stamp moved is not kept, and takes nothing with it", () => {
  const c = new StampedRowCache<string>(policy);
  c.set("slow", "1:1", "pending", 0);
  assert.equal(c.get("fresh", "2:2"), undefined);
  c.set("fresh", "2:2", "new", 10);
  c.set("slow", "1:1", "landed late", 10);
  assert.equal(c.get("fresh", "2:2"), "new", "the answer read since the write survives");
  assert.equal(c.get("slow", "2:2"), undefined);
  assert.deepEqual(c.size(), { entries: 1, rows: 10 });
});

test("a failed read forgets only its own answer", () => {
  const c = new StampedRowCache<string>(policy);
  c.set("a", "s", "first", 0);
  c.set("a", "s", "second", 5);
  c.drop("a", "first");
  assert.equal(c.get("a", "s"), "second");
  c.drop("a", "second");
  assert.equal(c.get("a", "s"), undefined);
});
