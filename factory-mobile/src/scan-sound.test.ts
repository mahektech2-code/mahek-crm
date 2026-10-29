import { test } from "node:test";
import assert from "node:assert/strict";
import { scanTone, type ScanMoment } from "./scan-sound";

const idle: ScanMoment = { open: true, route: "flow", res: null, feed: null, lorryRes: null, half: null };

test("an accepted label beeps, a refused one buzzes", () => {
  assert.equal(scanTone(idle, { ...idle, res: { ok: true } }), "ok");
  assert.equal(scanTone(idle, { ...idle, res: { ok: false } }), "bad");
});

test("a lorry refusal is bad, and outranks anything else that changed", () => {
  assert.equal(scanTone(idle, { ...idle, lorryRes: {}, feed: { tone: "ok", at: 1 } }), "bad");
});

test("a band over the camera sounds its own tone, once per box", () => {
  const fed = { ...idle, feed: { tone: "warn" as const, at: 5 } };
  assert.equal(scanTone(idle, fed), "warn");
  assert.equal(scanTone(fed, fed), null);
  assert.equal(scanTone(fed, { ...idle, feed: { tone: "ok", at: 6 } }), "ok");
});

test("half of a pair, or a scan that moved the screen on, counts as taken", () => {
  assert.equal(scanTone(idle, { ...idle, half: {} }), "ok");
  assert.equal(scanTone(idle, { ...idle, open: false }), "ok");
  assert.equal(scanTone(idle, { ...idle, route: "drum" }), "ok");
});

test("a scan that changed nothing makes no sound", () => {
  assert.equal(scanTone(idle, { ...idle }), null);
  const refused = { ...idle, res: { ok: false } };
  assert.equal(scanTone(refused, refused), null);
});
