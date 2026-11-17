import { test } from "node:test";
import assert from "node:assert/strict";
import { pullRows, syncTimingHeader } from "./sync-timing";

test("each phase is a Server-Timing entry with its duration, ingest carries the item count", () => {
  const h = syncTimingHeader(
    [{ name: "auth", ms: 3.14 }, { name: "ingest", ms: 402.66 }, { name: "pull", ms: 600 }],
    { items: 5, bytes: 30123, pull: null },
  );
  assert.equal(h, 'auth;dur=3.1, ingest;dur=402.7;desc="5", pull;dur=600, bytes;desc="30123"');
});

test("the pull's channels: arrays counted when they sent rows, objects named", () => {
  assert.equal(pullRows({ customers: [1, 2], timeline: [], config: { a: 1 }, cursor: "x", expensePolicy: undefined }), "customers:2 config");
});

test("nothing that could break the header gets into it", () => {
  const h = syncTimingHeader([{ name: "bad name\"", ms: 1 }], { items: 0, bytes: 1, pull: { 'we"ird': [1] } });
  assert.ok(!h.slice(0, h.indexOf(";")).includes('"'));
  assert.match(h, /rows;desc="we_ird:1"$/);
});

test("the row list is capped so the header stays small", () => {
  const pull = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`channel${i}`, [1]]));
  assert.ok(syncTimingHeader([], { items: 0, bytes: 0, pull }).length < 700);
});
