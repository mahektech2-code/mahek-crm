import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ago,
  arrivals,
  dwellMs,
  pruneAnnounced,
  soundOn,
  splitForDisplay,
  toneOf,
  type FeedItem,
} from "./notification-feed";

const NOW = "2026-10-06T12:00:00.000Z";
const item = (id: string, minutesAgo: number, read = false, kind = "info"): FeedItem => ({
  id,
  title: `t-${id}`,
  body: "",
  kind,
  href: null,
  read,
  createdAt: new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString(),
});

test("on a fresh page only recent, unread, never-announced notifications pop", () => {
  const answer = { now: NOW, items: [item("a", 2), item("b", 30), item("c", 1, true), item("d", 3)] };
  const got = arrivals(answer, null, new Set(["d"]));
  assert.deepEqual(got.map((n) => n.id), ["a"]);
});

test("after the first answer anything unread and unseen pops, even if another tab chimed", () => {
  const answer = { now: NOW, items: [item("new", 0), item("old", 60), item("seen", 1)] };
  const got = arrivals(answer, new Set(["seen"]), new Set(["new"]));
  assert.deepEqual(got.map((n) => n.id).sort(), ["new", "old"]);
});

test("a notification already read is never popped", () => {
  const answer = { now: NOW, items: [item("x", 0, true)] };
  assert.equal(arrivals(answer, new Set(), new Set()).length, 0);
});

test("arrivals come oldest first, and the newest are the ones flown", () => {
  const answer = { now: NOW, items: [item("n3", 0), item("n1", 4), item("n2", 2), item("n4", 0.5)] };
  const got = arrivals(answer, new Set(), new Set());
  assert.deepEqual(got.map((n) => n.id), ["n1", "n2", "n4", "n3"]);
  const { show, more } = splitForDisplay(got, 3);
  assert.deepEqual(show.map((n) => n.id), ["n2", "n4", "n3"]);
  assert.equal(more, 1);
});

test("kinds fold onto four tones, and anything unknown is ordinary news", () => {
  assert.equal(toneOf("warn"), "warn");
  assert.equal(toneOf("warning"), "warn");
  assert.equal(toneOf("danger"), "danger");
  assert.equal(toneOf("rejected"), "danger");
  assert.equal(toneOf("success"), "success");
  assert.equal(toneOf("lead"), "info");
  assert.equal(toneOf(null), "info");
  assert.ok(dwellMs("danger") > dwellMs("info"));
});

test("sound is on unless somebody turned it off", () => {
  assert.equal(soundOn(null), true);
  assert.equal(soundOn("on"), true);
  assert.equal(soundOn("off"), false);
});

test("ages read in words, and the announced list stays bounded", () => {
  const now = Date.parse(NOW);
  assert.equal(ago(NOW, now), "just now");
  assert.equal(ago(item("a", 5).createdAt, now), "5 min ago");
  assert.equal(ago(item("a", 180).createdAt, now), "3 h ago");
  const map = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`id${i}`, i]));
  const kept = pruneAnnounced(map, 4);
  assert.deepEqual(Object.keys(kept).sort(), ["id6", "id7", "id8", "id9"]);
});

test("the live bell is mounted once, in the root layout, so every app gets it", () => {
  const root = readFileSync(join(import.meta.dirname, "../app/layout.tsx"), "utf8");
  assert.match(root, /<NotificationCenter \/>/);
});

test("marking one notification read is limited to the caller's own", () => {
  const src = readFileSync(join(import.meta.dirname, "actions/crm.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function markNotificationRead("));
  assert.match(fn.slice(0, 600), /eq\(notifications\.userId, ctx\.user\.id\)/);
});
