import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ago,
  arrivals,
  nextPopups,
  popsUpIn,
  clampIndex,
  isSnoozeCode,
  remindAtFor,
  pruneAnnounced,
  soundOn,
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
  app: null,
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

test("arrivals come oldest first", () => {
  const answer = { now: NOW, items: [item("n3", 0), item("n1", 4), item("n2", 2), item("n4", 0.5)] };
  const got = arrivals(answer, new Set(), new Set());
  assert.deepEqual(got.map((n) => n.id), ["n1", "n2", "n4", "n3"]);
});

test("kinds fold onto four tones, and anything unknown is ordinary news", () => {
  assert.equal(toneOf("warn"), "warn");
  assert.equal(toneOf("warning"), "warn");
  assert.equal(toneOf("danger"), "danger");
  assert.equal(toneOf("rejected"), "danger");
  assert.equal(toneOf("success"), "success");
  assert.equal(toneOf("lead"), "info");
  assert.equal(toneOf(null), "info");
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

test("the live bell is mounted once, in the root layout, so every app gets it — and never on a public link", () => {
  const root = readFileSync(join(import.meta.dirname, "../app/layout.tsx"), "utf8");
  assert.match(root, /<StaffChrome \/>/);
  const chrome = readFileSync(join(import.meta.dirname, "../components/shell/staff-chrome.tsx"), "utf8");
  assert.match(chrome, /if \(isPublicPath\(pathname\)\) return null;/);
  assert.match(chrome, /<NotificationCenter \/>/);
});

test("marking one notification read is limited to the caller's own", () => {
  const src = readFileSync(join(import.meta.dirname, "actions/crm.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function markNotificationRead("));
  assert.match(fn.slice(0, 600), /eq\(notifications\.userId, ctx\.user\.id\)/);
});

test("every web app pops up; only the handset's notifications never reach a browser", () => {
  for (const app of ["erp", "crm", "accounts", "sales", "hrms", "tasks", "founder", null]) assert.equal(popsUpIn(app), true);
  assert.equal(popsUpIn("field"), false);
});

test("the reminder choices are codes, and the server works out the instant", () => {
  const now = Date.parse("2026-11-13T06:00:00Z"); // 11:30 IST
  assert.equal(remindAtFor("15m", now).toISOString(), "2026-11-13T06:15:00.000Z");
  assert.equal(remindAtFor("30m", now).toISOString(), "2026-11-13T06:30:00.000Z");
  assert.equal(remindAtFor("1h", now).toISOString(), "2026-11-13T07:00:00.000Z");
  assert.equal(remindAtFor("3h", now).toISOString(), "2026-11-13T09:00:00.000Z");
  assert.equal(remindAtFor("tomorrow", now).toISOString(), "2026-11-14T04:30:00.000Z", "10:00 IST the next day");
  /* 23:00 UTC on the 13th is already 04:30 on the 14th in India: tomorrow is the 15th. */
  assert.equal(remindAtFor("tomorrow", Date.parse("2026-11-13T23:00:00Z")).toISOString(), "2026-11-15T04:30:00.000Z");
  assert.equal(isSnoozeCode("1h"), true);
  assert.equal(isSnoozeCode("525600m"), false, "a year is not a choice");
  assert.equal(isSnoozeCode(60), false);
});

test("the stack keeps its place after an answer", () => {
  assert.equal(clampIndex(2, 3), 2);
  assert.equal(clampIndex(3, 3), 2, "the last one answered: the one before it shows");
  assert.equal(clampIndex(-1, 3), 0);
  assert.equal(clampIndex(4, 0), 0);
});

test("the pop-up says which of how many, and a shown one comes back until it is answered", () => {
  const modal = readFileSync(join(import.meta.dirname, "../components/shell/notification-modal.tsx"), "utf8");
  assert.match(modal, /Notification \{index \+ 1\} of \{total\}/);
  assert.match(modal, /SNOOZE_CHOICES\.map/);
  const centre = readFileSync(join(import.meta.dirname, "../components/shell/notification-center.tsx"), "utf8");
  assert.match(centre, /answerNotifications\(unanswered, "shown"\)/);
});

test("answering checks the snooze choice on the server, and only touches your own unread rows", () => {
  const src = readFileSync(join(import.meta.dirname, "actions/crm.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function answerNotifications("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /isSnoozeCode\(snooze\)/);
  assert.match(body, /eq\(notifications\.userId, ctx\.user\.id\)/);
  assert.match(body, /eq\(notifications\.read, false\)/);
  assert.match(body, /isNull\(notifications\.remindAt\)/, "showing never overwrites a reminder");
});

test("the pop-up queue keeps who is waiting, then what came due, then what arrived", () => {
  const answer = { now: NOW, items: [item("old", 5), item("new", 0)], due: [item("due", 90)] };
  assert.deepEqual(nextPopups([item("old", 5)], answer, [item("new", 0)]).map((n) => n.id), ["old", "due", "new"]);
  assert.deepEqual(nextPopups([item("old", 5)], answer, [item("old", 5)]).map((n) => n.id), ["old", "due"], "never twice");
});

test("a pop-up answered somewhere else leaves the queue", () => {
  const later = new Date(Date.parse(NOW) + 60_000).toISOString();
  const answer = { now: NOW, items: [item("read", 1, true), { ...item("snoozed", 1), remindAt: later }], due: [] };
  assert.deepEqual(nextPopups([item("read", 1), item("snoozed", 1), item("gone", 99)], answer, []).map((n) => n.id), ["gone"]);
});

test("a reminder still to come does not pop on a fresh page, and one that has passed does", () => {
  const later = new Date(Date.parse(NOW) + 60_000).toISOString();
  const past = new Date(Date.parse(NOW) - 60_000).toISOString();
  const answer = { now: NOW, items: [], due: [] };
  assert.deepEqual(nextPopups([], answer, [{ ...item("a", 1), remindAt: later }]), []);
  assert.equal(nextPopups([], answer, [{ ...item("b", 1), remindAt: past }]).length, 1);
});
