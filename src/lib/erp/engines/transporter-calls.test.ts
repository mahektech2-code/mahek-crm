import { test } from "node:test";
import assert from "node:assert/strict";
import { callStats, lrChange, nextCallFor, outcomesFor, transporterKey } from "./transporter-calls";

test("only a phone call can go unanswered", () => {
  assert.deepEqual(outcomesFor("call"), ["update", "no_change", "no_answer", "call_back"]);
  assert.deepEqual(outcomesFor("whatsapp"), ["update", "no_change"]);
  assert.deepEqual(outcomesFor("tracking"), ["update", "no_change"]);
});

test("one key per transporter however the bills space or case it", () => {
  assert.equal(transporterKey("  Shree  Ganesh Roadlines "), "shree ganesh roadlines");
  assert.equal(transporterKey(null), "");
});

test("an LR moved only when something on it changed", () => {
  const before = { lrNo: "40118", stage: "In Transit", expectedOn: "2026-11-14" };
  assert.equal(lrChange(before, { stage: "In Transit", city: "  ", expectedOn: "2026-11-14" }), null);
  assert.equal(lrChange(before, { stage: "Reached Destination Area", city: "", expectedOn: "2026-11-14" }), "In transit → At destination");
  assert.equal(lrChange(before, { stage: "In Transit", city: "Nagpur", expectedOn: "" }), "Reached Nagpur");
  assert.match(lrChange(before, { stage: "In Transit", city: "", expectedOn: "2026-11-17" }) ?? "", /^Expected .+ → .+/);
  assert.match(lrChange({ ...before, expectedOn: null }, { stage: "In Transit", city: "", expectedOn: "2026-11-17" }) ?? "", /^Expected [A-Z]/);
});

test("the next call each answer books", () => {
  const t = "2026-11-16";
  assert.deepEqual(nextCallFor("update", null, t, 2), { ok: true, day: "2026-11-18" });
  assert.deepEqual(nextCallFor("no_change", "2026-11-20", t, 2), { ok: true, day: "2026-11-20" });
  /* Nobody answered: the calls stay due unless a day was picked. */
  assert.deepEqual(nextCallFor("no_answer", null, t, 2), { ok: true, day: null });
  assert.deepEqual(nextCallFor("call_back", t, t, 2), { ok: true, day: t });
  assert.equal(nextCallFor("call_back", null, t, 2).ok, false);
  assert.equal(nextCallFor("update", "2026-11-15", t, 2).ok, false);
});

test("the figures: our calls answered, and dates moved", () => {
  const t = "2026-11-16";
  const rows = [
    { outcome: "update" as const, source: "call" as const, day: "2026-11-16", changes: [{ lrNo: "1", what: "Expected Fri 13 Nov → Sun 15 Nov" }, { lrNo: "2", what: "Reached Nagpur" }] },
    { outcome: "no_answer" as const, source: "call" as const, day: "2026-11-15", changes: [] },
    { outcome: "no_change" as const, source: "call" as const, day: "2026-11-10", changes: [] },
    { outcome: "update" as const, source: "whatsapp" as const, day: "2026-11-12", changes: [{ lrNo: "3", what: "Expected Mon 16 Nov" }] },
    { outcome: "no_answer" as const, source: "call" as const, day: "2026-09-01", changes: [] },
  ];
  assert.deepEqual(callStats(rows, t), { calls: 3, answeredPct: 67, datesMoved: 1 });
  assert.deepEqual(callStats([], t), { calls: 0, answeredPct: null, datesMoved: 0 });
});
