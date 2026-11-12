import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { istDateKey } from "../date";
import type { EntryDesigns } from "./festival-calendar";
import { DEFAULT_REMINDER_PREFS, EMPTY_REMINDER_STATE, dismiss, dueReminders } from "./reminder";
import {
  NO_POSTER_MESSAGE,
  candidateKey,
  diffReminder,
  formValuesOf,
  occurrencesInMonth,
  parseReminderInput,
  personCandidates,
  posterActionFor,
  upcomingShared,
  type ReminderInput,
  type SharedReminder,
} from "./shared-reminder";

const TODAY = "2026-10-22";
const form = (over: Record<string, unknown> = {}) => ({ kind: "birthday", personName: "Meera Shah", company: "", month: "11", day: "3", year: "", note: "", leadDays: "7", crmKind: "", crmId: "", ...over });
const ok = (over: Record<string, unknown> = {}) => {
  const r = parseReminderInput(form(over), TODAY);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const errors = (over: Record<string, unknown> = {}) => {
  const r = parseReminderInput(form(over), TODAY);
  assert.equal(r.ok, false);
  return r.ok ? {} : r.fieldErrors;
};

const actor = { id: "u1", label: "Seema" };
const rem = (id: string, date: string, over: Partial<SharedReminder> = {}): SharedReminder => ({
  id,
  kind: "birthday",
  personName: `Person ${id}`,
  company: null,
  date,
  note: null,
  leadDays: 7,
  crmKind: null,
  crmId: null,
  version: 1,
  createdBy: actor,
  createdAt: 1,
  updatedBy: actor,
  updatedAt: 1,
  deletedAt: null,
  deletedBy: null,
  ...over,
});

describe("the Add / Edit form", () => {
  test("a minimal manual reminder needs no CRM record, no company, no year and no note", () => {
    assert.deepEqual(ok(), { kind: "birthday", personName: "Meera Shah", company: null, date: "--11-03", note: null, leadDays: 7, crmKind: null, crmId: null });
  });
  test("with a year the date is a full date; with an optional company and note they are kept", () => {
    const v = ok({ year: "1985", company: "  Shah  Traders ", note: "  Likes sweets " });
    assert.equal(v.date, "1985-11-03");
    assert.equal(v.company, "Shah Traders");
    assert.equal(v.note, "Likes sweets");
  });
  test("each problem is reported against its own field and nothing is repaired", () => {
    assert.ok(errors({ kind: "wedding" }).kind);
    assert.ok(errors({ personName: "   " }).personName);
    assert.ok(errors({ personName: "<b>x</b>" }).personName);
    assert.ok(errors({ personName: "x".repeat(121) }).personName);
    assert.ok(errors({ company: "y".repeat(121) }).company);
    assert.ok(errors({ note: "z".repeat(501) }).note);
    assert.ok(errors({ leadDays: "5" }).leadDays);
    assert.ok(errors({ leadDays: "" }).leadDays);
    assert.ok(errors({ month: "", day: "" }).date);
    assert.ok(errors({ year: "85" }).date);
  });
  test("a date that does not exist is refused: 31 April, 30 February, month 13", () => {
    for (const [month, day] of [["4", "31"], ["2", "30"], ["13", "1"], ["0", "5"], ["6", "0"]]) assert.ok(errors({ month, day }).date, `${month}-${day}`);
  });
  test("29 February: allowed with no year or a leap year, refused in a year that has none", () => {
    assert.equal(ok({ month: "2", day: "29" }).date, "--02-29");
    assert.equal(ok({ month: "2", day: "29", year: "2000" }).date, "2000-02-29");
    assert.match(errors({ month: "2", day: "29", year: "2001" }).date ?? "", /29 February does not exist in 2001/);
    assert.ok(errors({ month: "2", day: "29", year: "1900" }).date, "1900 was not a leap year");
  });
  test("a year before 1900, in the future, or a date after today is refused", () => {
    assert.ok(errors({ year: "1850" }).date);
    assert.ok(errors({ year: "2027" }).date);
    assert.ok(errors({ year: "2026", month: "12", day: "1" }).date);
    assert.equal(ok({ year: "2026", month: "10", day: "22" }).date, "2026-10-22");
  });
  test("the CRM reference is optional, but if given it needs a kind and a safe id, and only those are kept", () => {
    assert.deepEqual([ok({ crmKind: "lead", crmId: "lead_123" }).crmKind, ok({ crmKind: "lead", crmId: "lead_123" }).crmId], ["lead", "lead_123"]);
    assert.ok(errors({ crmKind: "lead", crmId: "" }).crm);
    assert.ok(errors({ crmKind: "", crmId: "abc" }).crm);
    assert.ok(errors({ crmKind: "vendor", crmId: "abc" }).crm);
    assert.ok(errors({ crmKind: "customer", crmId: "a b/../c" }).crm);
    assert.ok(errors({ crmKind: "customer", crmId: "x".repeat(101) }).crm);
  });
  test("non-text input never throws", () => {
    const r = parseReminderInput({ kind: 5, personName: null, month: {}, day: [], leadDays: undefined }, TODAY);
    assert.equal(r.ok, false);
  });
  test("the Edit form is filled back from a stored reminder, with and without a year", () => {
    assert.deepEqual(formValuesOf({ ...ok({ year: "1990", crmKind: "customer", crmId: "c1", note: "n", company: "Co" }) }), { kind: "birthday", personName: "Meera Shah", company: "Co", month: "11", day: "3", year: "1990", note: "n", leadDays: "7", crmKind: "customer", crmId: "c1" });
    assert.equal(formValuesOf(ok()).year, "");
  });
});

describe("what changed (the history)", () => {
  const base: ReminderInput = ok();
  test("nothing changed gives no entry", () => assert.deepEqual(diffReminder(base, { ...base }), []));
  test("only the fields that differ, in a fixed order, with readable values", () => {
    const after: ReminderInput = { ...base, personName: "Meera S. Shah", date: "1985-11-03", leadDays: 3, note: "Likes sweets" };
    assert.deepEqual(
      diffReminder(base, after).map((c) => [c.label, c.from, c.to]),
      [["Name", "Meera Shah", "Meera S. Shah"], ["Date", "--11-03", "1985-11-03"], ["Note", null, "Likes sweets"], ["Remind", "7 days before", "3 days before"]],
    );
    assert.deepEqual(diffReminder({ ...base, leadDays: 3 }, { ...base, leadDays: 1 }).map((c) => c.to), ["1 day before"]);
  });
  test("a change of type and a linked CRM record are recorded", () => {
    const c = diffReminder(base, { ...base, kind: "anniversary", crmKind: "lead", crmId: "L1" });
    assert.deepEqual(c.map((x) => x.field), ["kind", "crmKind", "crmId"]);
    assert.equal(c[0]?.to, "Anniversary");
  });
});

describe("yearly recurrence", () => {
  test("a reminder repeats every year without being added again", () => {
    const r = [rem("a", "1990-03-14")];
    assert.equal(upcomingShared(r, "2026-03-01").items[0]?.occurrence.date, "2026-03-14");
    assert.equal(upcomingShared(r, "2026-03-15").items[0]?.occurrence.date, "2027-03-14");
    assert.equal(upcomingShared(r, "2031-03-15").items[0]?.occurrence.date, "2032-03-14");
  });
  test("today counts, and the age or number of years is given when the year is known", () => {
    const i = upcomingShared([rem("a", "1990-10-22")], TODAY).items[0];
    assert.deepEqual([i?.occurrence.daysUntil, i?.occurrence.years], [0, 36]);
    assert.equal(upcomingShared([rem("b", "--10-22")], TODAY).items[0]?.occurrence.years, null);
  });
  test("the 7-day and 30-day windows include their last day and exclude the next", () => {
    const list = [rem("d7", "--10-29"), rem("d8", "--10-30"), rem("d30", "--11-21"), rem("d31", "--11-22")];
    assert.deepEqual(upcomingShared(list, TODAY, { withinDays: 7 }).items.map((x) => x.reminder.id), ["d7"]);
    assert.deepEqual(upcomingShared(list, TODAY, { withinDays: 30 }).items.map((x) => x.reminder.id), ["d7", "d8", "d30"]);
    assert.equal(upcomingShared(list, TODAY).items.length, 4);
    assert.deepEqual(upcomingShared([rem("t", "--10-22"), ...list], TODAY, { withinDays: 0 }).items.map((x) => x.reminder.id), ["t"]);
  });
  test("29 February is marked on 28 February in a year without one, and on the 29th in a leap year", () => {
    const r = [rem("leap", "2000-02-29")];
    const a = upcomingShared(r, "2027-02-10").items[0];
    assert.deepEqual([a?.occurrence.date, a?.occurrence.observedOnFallback], ["2027-02-28", true]);
    const b = upcomingShared(r, "2027-03-01").items[0];
    assert.deepEqual([b?.occurrence.date, b?.occurrence.observedOnFallback], ["2028-02-29", false]);
    assert.equal(upcomingShared([rem("y", "--02-29")], "2028-02-29").items[0]?.occurrence.daysUntil, 0);
  });
  test("India time zone: 18:31 UTC on 31 December is already 1 January", () => {
    const r = [rem("ny", "--01-01")];
    const after = istDateKey(new Date("2026-12-31T18:31:00Z"));
    const before = istDateKey(new Date("2026-12-31T18:29:00Z"));
    assert.equal(upcomingShared(r, after).items[0]?.occurrence.daysUntil, 0);
    assert.equal(upcomingShared(r, before).items[0]?.occurrence.daysUntil, 1);
  });
  test("deleted, unusable and duplicate rows: deleted never listed, unusable reported not guessed, a repeated id counted once", () => {
    const list = [rem("ok", "--11-01"), rem("ok", "--11-01"), rem("gone", "--11-01", { deletedAt: 5 }), rem("bad", "--02-30"), rem("worse", "garbage")];
    const { items, unusable } = upcomingShared(list, TODAY);
    assert.deepEqual(items.map((x) => x.reminder.id), ["ok"]);
    assert.deepEqual(unusable.map((x) => x.id), ["bad", "worse"]);
  });
  test("birthdays and anniversaries can be separated, soonest first then by name", () => {
    const list = [rem("b", "--11-02", { personName: "Zed" }), rem("a", "--11-02", { personName: "Amy" }), rem("n", "--10-30", { kind: "anniversary" })];
    assert.deepEqual(upcomingShared(list, TODAY, { kind: "birthday" }).items.map((x) => x.reminder.personName), ["Amy", "Zed"]);
    assert.deepEqual(upcomingShared(list, TODAY).items.map((x) => x.reminder.id), ["n", "a", "b"]);
  });
  test("an empty list is empty, not an error", () => assert.deepEqual(upcomingShared([], TODAY), { items: [], unusable: [] }));
});

describe("the month calendar", () => {
  test("a yearly reminder appears in its month of every year; 29 February falls on 28 in a non-leap year", () => {
    const list = [rem("a", "1990-03-14"), rem("b", "--03-14", { personName: "B" }), rem("leap", "2000-02-29"), rem("gone", "--03-14", { deletedAt: 1 })];
    assert.deepEqual(occurrencesInMonth(list, 2031, 3).map((e) => [e.id, e.date]), [["b", "2031-03-14"], ["a", "2031-03-14"]]);
    assert.deepEqual(occurrencesInMonth(list, 2027, 2).map((e) => e.date), ["2027-02-28"]);
    assert.deepEqual(occurrencesInMonth(list, 2028, 2).map((e) => e.date), ["2028-02-29"]);
    assert.deepEqual(occurrencesInMonth(list, 2027, 4), []);
  });
});

describe("notifications for shared reminders", () => {
  test("a reminder uses its OWN lead time, and the key has the date in it", () => {
    const list = [rem("a", "--10-25", { leadDays: 3 }), rem("b", "--10-30", { leadDays: 7 }), rem("c", "--11-03", { leadDays: 7 })];
    const due = dueReminders(personCandidates(list, TODAY), DEFAULT_REMINDER_PREFS, EMPTY_REMINDER_STATE, TODAY);
    assert.deepEqual(due.map((d) => d.key), [candidateKey({ kind: "birthday", id: "a" }, "2026-10-25")]);
    const later = dueReminders(personCandidates(list, TODAY), DEFAULT_REMINDER_PREFS, EMPTY_REMINDER_STATE, "2026-10-24");
    assert.deepEqual(later.map((d) => d.title), ["Person a's birthday", "Person b's birthday"]);
  });
  test("a personal switch turns people reminders off without touching festivals", () => {
    const list = [rem("a", "--10-23")];
    const cands = [...personCandidates(list, TODAY), { key: "fest-2026", kind: "festival" as const, title: "Fest", date: "2026-10-23", hasDesign: false }];
    assert.equal(dueReminders(cands, { ...DEFAULT_REMINDER_PREFS, people: false }, EMPTY_REMINDER_STATE, TODAY).length, 1);
    assert.equal(dueReminders(cands, DEFAULT_REMINDER_PREFS, EMPTY_REMINDER_STATE, TODAY).length, 2);
    // "only festivals with a design" does not hide birthdays
    assert.equal(dueReminders(cands, { ...DEFAULT_REMINDER_PREFS, onlyWithDesigns: true }, EMPTY_REMINDER_STATE, TODAY).length, 1);
  });
  test("dismissed stays dismissed for that year only: next year's occurrence is a new notification", () => {
    const r = [rem("a", "--10-23")];
    const first = personCandidates(r, TODAY);
    const state = dismiss(EMPTY_REMINDER_STATE, { key: first[0]!.key, date: first[0]!.date });
    assert.equal(dueReminders(personCandidates(r, TODAY), DEFAULT_REMINDER_PREFS, state, TODAY).length, 0);
    assert.equal(dueReminders(personCandidates(r, "2027-10-20"), DEFAULT_REMINDER_PREFS, state, "2027-10-20").length, 1);
  });
  test("deleted reminders and an unusable date give no notification", () => {
    assert.deepEqual(personCandidates([rem("g", "--10-23", { deletedAt: 1 }), rem("x", "--02-30")], TODAY), []);
  });
});

describe("the poster action", () => {
  const none: EntryDesigns = { lead: 0, customer: 0, any: false, occasionId: null };
  const both: EntryDesigns = { lead: 2, customer: 1, any: true, occasionId: "birthday" };
  const leadOnly: EntryDesigns = { lead: 1, customer: 0, any: true, occasionId: "birthday" };
  test("no approved design: the exact message, whatever the link", () => {
    assert.deepEqual(posterActionFor({ crmKind: null, crmId: null }, none), { type: "none", message: "No approved poster design available." });
    assert.equal(posterActionFor({ crmKind: "lead", crmId: "L1" }, none).type, "none");
    assert.equal(NO_POSTER_MESSAGE, "No approved poster design available.");
  });
  test("a design exists but the person is typed in by hand: a poster needs a linked lead or customer", () => {
    assert.equal(posterActionFor({ crmKind: null, crmId: null }, both).type, "needs-recipient");
  });
  test("a design exists and a CRM record is linked: the action points at that record and occasion", () => {
    assert.deepEqual(posterActionFor({ crmKind: "customer", crmId: "C9" }, both), { type: "make", recipientKind: "customer", recipientId: "C9", occasionId: "birthday" });
  });
  test("a design that is not offered to that kind of recipient gives no poster", () => {
    assert.equal(posterActionFor({ crmKind: "customer", crmId: "C9" }, leadOnly).type, "none");
    assert.equal(posterActionFor({ crmKind: "lead", crmId: "L1" }, leadOnly).type, "make");
  });
});
