import { test } from "node:test";
import assert from "node:assert/strict";

import { cached, forget } from "./reference-cache";

/**
 * The reference cache. Every one of these fails SILENTLY in production — a
 * stampede is invisible except as load, and a cache that never fills is
 * invisible except as the app being exactly as slow as it was.
 */

test("a second read inside the window does not call the loader again", async () => {
  forget();
  let calls = 0;
  const load = async () => {
    calls += 1;
    return calls;
  };
  assert.equal(await cached("k1", load), 1);
  assert.equal(await cached("k1", load), 1, "served from the cache");
  assert.equal(calls, 1);
});

test("TEN CONCURRENT READS OF A COLD KEY MAKE ONE QUERY", async () => {
  forget();
  let calls = 0;
  const load = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return "v";
  };
  const all = await Promise.all(Array.from({ length: 10 }, () => cached("k2", load)));
  assert.deepEqual(all, Array(10).fill("v"));
  assert.equal(
    calls,
    1,
    "without the in-flight guard every request after a deploy misses at once",
  );
});

test("a loader that throws is not remembered as a value", async () => {
  forget();
  let calls = 0;
  const boom = async () => {
    calls += 1;
    throw new Error("no");
  };
  await assert.rejects(() => cached("k3", boom));
  /* The next caller must be allowed to try. A cached rejection would mean one
     bad moment poisoned the key for the whole TTL. */
  await assert.rejects(() => cached("k3", boom));
  assert.equal(calls, 2);
});

test("forget drops one key, and forget() drops everything", async () => {
  forget();
  let calls = 0;
  const load = async () => ++calls;
  await cached("a", load);
  await cached("b", load);
  forget("a");
  await cached("a", load);
  await cached("b", load);
  assert.equal(calls, 3, "a reloaded, b did not");
  forget();
  await cached("b", load);
  assert.equal(calls, 4);
});
