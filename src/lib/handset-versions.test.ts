import test from "node:test";
import assert from "node:assert/strict";
import { ago, newestVersion, parseBuildLabel, presence, versionStatus } from "./handset-versions";

test("a build label splits into version, build and bundle", () => {
  assert.deepEqual(parseBuildLabel("1.15.0 (21) · a1b2c3d4"), { version: "1.15.0", build: "21", bundle: "a1b2c3d4" });
  assert.deepEqual(parseBuildLabel("1.15.0 (21) · embedded"), { version: "1.15.0", build: "21", bundle: "embedded" });
  assert.deepEqual(parseBuildLabel("1.9.0 · updates off"), { version: "1.9.0", build: null, bundle: "updates off" });
  assert.deepEqual(parseBuildLabel("1.4.2"), { version: "1.4.2", build: null, bundle: null });
  assert.equal(parseBuildLabel(null), null);
  assert.equal(parseBuildLabel("  "), null);
});

test("status: no handset, unknown, behind, latest", () => {
  assert.equal(versionStatus({ deviceId: null, appVersion: null }, "1.15.0"), "none");
  assert.equal(versionStatus({ deviceId: "d", appVersion: null }, "1.15.0"), "unknown");
  assert.equal(versionStatus({ deviceId: "d", appVersion: "1.14.0 (20) · embedded" }, null), "unknown");
  assert.equal(versionStatus({ deviceId: "d", appVersion: "1.14.0 (20) · embedded" }, "1.15.0"), "behind");
  assert.equal(versionStatus({ deviceId: "d", appVersion: "1.15.0 (21) · a1b2c3d4" }, "1.15.0"), "latest");
  /* A phone ahead of the setting is not behind it. */
  assert.equal(versionStatus({ deviceId: "d", appVersion: "1.16.0 (22) · embedded" }, "1.15.0"), "latest");
});

test("the newest version compares numbers, not strings", () => {
  assert.equal(newestVersion(["1.9.0 (9) · embedded", "1.15.0 (21) · x", "1.10.0 (10) · y", null]), "1.15.0");
  assert.equal(newestVersion([null, "garbage"]), null);
});

test("presence and ago read the clock they are given", () => {
  const now = Date.parse("2026-10-03T10:00:00Z");
  assert.equal(presence(null, now), "never");
  assert.equal(presence("2026-10-03T09:59:30Z", now), "online");
  assert.equal(presence("2026-10-03T09:45:00Z", now), "recent");
  assert.equal(presence("2026-10-03T08:00:00Z", now), "quiet");
  assert.equal(ago("2026-10-03T09:59:40Z", now), "just now");
  assert.equal(ago("2026-10-03T09:56:00Z", now), "4 min ago");
  assert.equal(ago("2026-10-03T07:00:00Z", now), "3 h ago");
  assert.equal(ago("2026-10-01T10:00:00Z", now), "2 d ago");
  assert.equal(ago("2026-10-03T10:05:00Z", now), "just now");
});
