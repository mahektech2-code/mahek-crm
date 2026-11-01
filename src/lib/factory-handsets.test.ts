import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, handsetIssues, handsetName, newestOf, otaStatus, type FactoryHandsetRow } from "./factory-handsets";

const NOW = Date.parse("2026-11-01T10:00:00Z");
const row = (o: Partial<FactoryHandsetRow> = {}): FactoryHandsetRow => ({
  deviceId: "FD-1", userId: "u1", name: "Suresh", phone: null, area: "dispatch", roleLabel: null, godown: "Ambernath",
  lastSeenAt: "2026-11-01T09:58:00Z", firstSeenAt: "2026-10-30T09:00:00Z", appVersion: "2.4.0", updateId: "aaaa", updateCreatedAt: "2026-11-01T05:00:00Z",
  embedded: false, channel: "production", os: "android", osVersion: "13", apiLevel: 33, brand: "samsung", manufacturer: "samsung", model: "SM-A145F",
  network: "wifi", internet: true, queuePending: 0, queueHeld: 0, queueOldestAt: null, camera: "granted", screen: "360x780", fontScalePct: 100,
  clockSkewMs: 300, lang: "hi", scansToday: 0, lastScanAt: null, medianWaitMs: null, disagreeToday: 0, ...o,
});

test("versions compare by number, not by text", () => {
  assert.ok(compareVersions("2.10.0", "2.4.0") > 0);
  assert.equal(compareVersions("2.4", "2.4.0"), 0);
});

test("the newest is the highest APK, and on it the newest update any phone has", () => {
  const rows = [
    row({ appVersion: "2.3.0", updateId: "zzzz", updateCreatedAt: "2026-11-05T00:00:00Z" }),
    row({ updateId: "old1", updateCreatedAt: "2026-10-29T00:00:00Z" }),
    row({ updateId: "new1", updateCreatedAt: "2026-11-01T05:00:00Z" }),
    row({ deviceId: null, appVersion: null, updateId: null, updateCreatedAt: null }),
  ];
  const n = newestOf(rows);
  assert.deepEqual(n, { version: "2.4.0", updateId: "new1", updateCreatedAt: "2026-11-01T05:00:00Z" });
  assert.equal(otaStatus(rows[0], n), "apk", "an older APK needs the APK, whatever update it has");
  assert.equal(otaStatus(rows[1], n), "ota", "the right APK on an older update has one waiting");
  assert.equal(otaStatus(rows[2], n), "latest");
  assert.equal(otaStatus(rows[3], n), "none");
  assert.equal(otaStatus(row({ appVersion: null }), n), "unknown");
  assert.equal(otaStatus(row({ updateId: null, updateCreatedAt: null, embedded: true }), n), "ota", "the APK's own bundle, when an update exists for it");
  assert.equal(newestOf([]).version, null);
});

test("a healthy phone has no problems to show", () => {
  assert.deepEqual(handsetIssues(row(), NOW), []);
  assert.deepEqual(handsetIssues(row({ deviceId: null }), NOW), []);
});

test("problems are the ones somebody can walk over and fix, worst first", () => {
  const issues = handsetIssues(
    row({ camera: "denied", queuePending: 3, queueOldestAt: "2026-11-01T08:00:00Z", queueHeld: 1, internet: false, clockSkewMs: -600_000, fontScalePct: 150, disagreeToday: 2 }),
    NOW,
  );
  assert.deepEqual(issues.map((i) => i.text), [
    "Camera not allowed — it cannot scan",
    "3 jobs not sent for 2 h",
    "1 held back by the server",
    "No internet at last report",
    "Clock 10 min slow",
    "Font size 150% — screens may cut off",
    "2 scan judgements differed from the server today",
  ]);
  assert.deepEqual(issues.slice(0, 2).map((i) => i.tone), ["danger", "danger"]);
  /* Work waiting a few minutes is a phone between flushes, not stuck. */
  assert.deepEqual(handsetIssues(row({ queuePending: 2, queueOldestAt: "2026-11-01T09:55:00Z" }), NOW), []);
});

test("the handset is named once, maker then model", () => {
  assert.equal(handsetName(row()), "Samsung SM-A145F");
  assert.equal(handsetName(row({ manufacturer: "Xiaomi", model: "Xiaomi 13" })), "Xiaomi 13");
  assert.equal(handsetName(row({ model: null })), "Samsung");
  assert.equal(handsetName(row({ model: null, manufacturer: null, brand: null })), null);
});
