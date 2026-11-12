import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REMINDER_PREFS, EMPTY_REMINDER_STATE, dismiss, dueReminders, markRead, parseReminderPrefs, pruneState, unreadCount, type ReminderCandidate } from "./reminder";

const cand = (key: string, date: string, hasDesign = true): ReminderCandidate => ({ key, kind: "festival", title: key, date, hasDesign });
const TODAY = "2026-10-22";
const list = [cand("today", "2026-10-22"), cand("d1", "2026-10-23"), cand("d3", "2026-10-25"), cand("d7", "2026-10-29"), cand("d8", "2026-10-30"), cand("past", "2026-10-21")];
const keys = (r: { key: string }[]) => r.map((x) => x.key);

describe("preferences", () => {
  test("defaults", () => assert.deepEqual(parseReminderPrefs(undefined), DEFAULT_REMINDER_PREFS));
  test("only 1, 3 or 7 days are accepted; anything else falls back to the default", () => {
    assert.equal(parseReminderPrefs({ leadDays: "3" }).leadDays, 3);
    assert.equal(parseReminderPrefs({ leadDays: 1 }).leadDays, 1);
    assert.equal(parseReminderPrefs({ leadDays: 5 }).leadDays, 7);
    assert.equal(parseReminderPrefs({ leadDays: "abc" }).leadDays, 7);
  });
  test("each field falls back on its own", () => {
    assert.deepEqual(parseReminderPrefs({ enabled: false, leadDays: 99, onlyWithDesigns: "yes" }), { enabled: false, leadDays: 7, onlyWithDesigns: false, people: true });
  });
});

describe("which reminders are due", () => {
  test("lead time 1, 3 and 7 days (the day itself included, past excluded)", () => {
    const due = (leadDays: 1 | 3 | 7) => keys(dueReminders(list, { ...DEFAULT_REMINDER_PREFS, leadDays }, EMPTY_REMINDER_STATE, TODAY));
    assert.deepEqual(due(1), ["today", "d1"]);
    assert.deepEqual(due(3), ["today", "d1", "d3"]);
    assert.deepEqual(due(7), ["today", "d1", "d3", "d7"]);
  });
  test("switched off gives nothing", () => assert.deepEqual(dueReminders(list, { ...DEFAULT_REMINDER_PREFS, enabled: false }, EMPTY_REMINDER_STATE, TODAY), []));
  test("only-with-designs drops occasions that have no approved design", () => {
    const l = [cand("a", "2026-10-23", true), cand("b", "2026-10-23", false)];
    assert.deepEqual(keys(dueReminders(l, { ...DEFAULT_REMINDER_PREFS, onlyWithDesigns: true }, EMPTY_REMINDER_STATE, TODAY)), ["a"]);
    assert.deepEqual(keys(dueReminders(l, DEFAULT_REMINDER_PREFS, EMPTY_REMINDER_STATE, TODAY)), ["a", "b"]);
  });
  test("an invalid date is skipped, not shown", () => {
    assert.deepEqual(dueReminders([cand("x", "2026-02-30")], DEFAULT_REMINDER_PREFS, EMPTY_REMINDER_STATE, TODAY), []);
  });
  test("the same occasion listed twice is one reminder", () => {
    assert.equal(dueReminders([cand("d1", "2026-10-23"), cand("d1", "2026-10-23")], DEFAULT_REMINDER_PREFS, EMPTY_REMINDER_STATE, TODAY).length, 1);
  });
  test("daysUntil is the India-date difference", () => {
    assert.deepEqual(dueReminders(list, DEFAULT_REMINDER_PREFS, EMPTY_REMINDER_STATE, TODAY).map((r) => r.daysUntil), [0, 1, 3, 7]);
  });
});

describe("read, dismissed and no repeated notification", () => {
  const prefs = DEFAULT_REMINDER_PREFS;
  test("everything starts unread", () => assert.equal(unreadCount(dueReminders(list, prefs, EMPTY_REMINDER_STATE, TODAY)), 4));
  test("mark read keeps the reminder but not as new", () => {
    const due = dueReminders(list, prefs, EMPTY_REMINDER_STATE, TODAY);
    const state = markRead(EMPTY_REMINDER_STATE, due);
    const after = dueReminders(list, prefs, state, TODAY);
    assert.equal(after.length, 4);
    assert.equal(unreadCount(after), 0);
  });
  test("dismissed does not come back", () => {
    const state = dismiss(EMPTY_REMINDER_STATE, { key: "d3", date: "2026-10-25" });
    assert.ok(!keys(dueReminders(list, prefs, state, TODAY)).includes("d3"));
    assert.ok(!keys(dueReminders(list, prefs, state, "2026-10-24")).includes("d3"));
  });
  test("changing the lead time does not revive a dismissed or already-read reminder", () => {
    let state = dismiss(EMPTY_REMINDER_STATE, { key: "d3", date: "2026-10-25" });
    state = markRead(state, [{ key: "d1", date: "2026-10-23" }]);
    for (const leadDays of [1, 3, 7] as const) {
      const r = dueReminders(list, { ...prefs, leadDays }, state, TODAY);
      assert.ok(!keys(r).includes("d3"));
      assert.equal(r.find((x) => x.key === "d1")?.unread ?? false, false);
    }
  });
  test("next year's occurrence has its own key and is new again", () => {
    const state = dismiss(EMPTY_REMINDER_STATE, { key: "diwali-2026", date: "2026-11-08" });
    const r = dueReminders([cand("diwali-2027", "2027-10-29")], prefs, state, "2027-10-25");
    assert.equal(r.length, 1);
    assert.equal(r[0]?.unread, true);
  });
  test("marks are not changed by working out the reminders (pure)", () => {
    const state = markRead(EMPTY_REMINDER_STATE, [{ key: "a", date: "2026-10-23" }]);
    const copy = structuredClone(state);
    dueReminders(list, prefs, state, TODAY);
    assert.deepEqual(state, copy);
  });
  test("old marks are dropped after 30 days", () => {
    const state = markRead(EMPTY_REMINDER_STATE, [{ key: "old", date: "2026-09-01" }, { key: "recent", date: "2026-10-10" }]);
    assert.deepEqual(Object.keys(pruneState(state, TODAY).read), ["recent"]);
  });
});
