import { test } from "node:test";
import assert from "node:assert/strict";
import { promptDue, SNOOZE_MS, snoozeUntil, updateVerdict } from "./update";

const m = { version: "2.2.0", versionCode: 150, url: "https://one.mahekindia.com/downloads/factory.apk" };

test("a newer build is offered by its versionCode, with its name", () => {
  assert.deepEqual(updateVerdict(m, 149), { kind: "available", version: "2.2.0", versionCode: 150, url: m.url });
});

test("the same or an older build is not offered, and never as a downgrade", () => {
  assert.equal(updateVerdict(m, 150).kind, "current");
  assert.equal(updateVerdict(m, 151).kind, "current");
});

test("a manifest nobody can trust is read as nothing to do", () => {
  assert.equal(updateVerdict(null, 100).kind, "current");
  assert.equal(updateVerdict("<html>", 100).kind, "current");
  assert.equal(updateVerdict({ ...m, versionCode: "150" }, 100).kind, "current");
  assert.equal(updateVerdict({ ...m, url: "http://one.mahekindia.com/downloads/factory.apk" }, 100).kind, "current");
  assert.equal(updateVerdict(m, null).kind, "current", "a build that cannot say what it is cannot know it is behind");
});

test("Update later keeps the prompt away for three hours, and a refresh press asks anyway", () => {
  const now = 1_000_000;
  const until = snoozeUntil(now);
  assert.equal(until - now, SNOOZE_MS);
  assert.equal(SNOOZE_MS, 3 * 60 * 60 * 1000);
  assert.equal(promptDue(now + 60_000, until), false);
  assert.equal(promptDue(until, until), true);
  assert.equal(promptDue(now + 60_000, until, true), true);
  assert.equal(promptDue(now, null), true);
});
