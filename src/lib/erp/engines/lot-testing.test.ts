import { test } from "node:test";
import assert from "node:assert/strict";
import { STOCK_WORDS, testBucket, waitedTooLong, waitingText } from "./lot-testing";

test("a lot with no test is To test; recorded and undecided is To verify", () => {
  assert.equal(testBucket(null), "toTest");
  /* The stored default is Not Verified before anybody decides: still waiting, never failed. */
  assert.equal(testBucket({ status: "Not Verified", decidedAt: null }), "toVerify");
  assert.equal(testBucket({ status: "Verified", decidedAt: new Date() }), "verified");
  assert.equal(testBucket({ status: "Not Verified", decidedAt: "2026-11-20T10:00:00Z" }), "failed");
});

test("the stock of a lot waiting is held", () => {
  assert.equal(STOCK_WORDS.toTest, "Held until tested");
  assert.equal(STOCK_WORDS.toVerify, "Held until tested");
});

test("waiting reads in minutes, hours, then days", () => {
  assert.equal(waitingText(20_000), "just now");
  assert.equal(waitingText(5 * 60_000), "5 min");
  assert.equal(waitingText(3_600_000), "1 hour");
  assert.equal(waitingText(2 * 3_600_000 + 59 * 60_000), "2 hours");
  assert.equal(waitingText(24 * 3_600_000), "1 day");
  assert.equal(waitingText(50 * 3_600_000), "2 days");
});

test("waiting is too long only past the threshold, and a threshold of 0 never flags", () => {
  assert.equal(waitedTooLong(23 * 3_600_000, 24), false);
  assert.equal(waitedTooLong(24 * 3_600_000, 24), false);
  assert.equal(waitedTooLong(25 * 3_600_000, 24), true);
  assert.equal(waitedTooLong(1e10, 0), false);
});
