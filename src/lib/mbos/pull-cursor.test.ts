import test from "node:test";
import assert from "node:assert/strict";
import { CURSOR_OVERLAP_MS, nextPullCursorAt } from "./pull-cursor";

const NOW = new Date("2026-10-04T10:00:00.000Z");

test("with nothing capped, the cursor steps back by the overlap", () => {
  /* A write that committed after the pull's reads but started before them is
     stamped below `now`; the overlap is what lets the next pull see it. */
  const at = nextPullCursorAt(NOW, [null, null]);
  assert.equal(at.getTime(), NOW.getTime() - CURSOR_OVERLAP_MS);
});

test("a full page holds the cursor at its last row, a millisecond before it", () => {
  const last = new Date("2026-10-04T08:00:00.000Z");
  const at = nextPullCursorAt(NOW, [null, last]);
  assert.equal(at.getTime(), last.getTime() - 1);
});

test("the earliest full page wins, because every channel shares one cursor", () => {
  const a = new Date("2026-10-04T08:00:00.000Z");
  const b = new Date("2026-10-04T07:00:00.000Z");
  assert.equal(nextPullCursorAt(NOW, [a, b]).getTime(), b.getTime() - 1);
});

test("a full page newer than the overlap does not move the cursor forward", () => {
  const recent = new Date(NOW.getTime() - 1000);
  assert.equal(
    nextPullCursorAt(NOW, [recent]).getTime(),
    NOW.getTime() - CURSOR_OVERLAP_MS,
  );
});

test("an unreadable instant is ignored rather than producing an invalid cursor", () => {
  const at = nextPullCursorAt(NOW, [new Date("nonsense")]);
  assert.equal(at.getTime(), NOW.getTime() - CURSOR_OVERLAP_MS);
});
