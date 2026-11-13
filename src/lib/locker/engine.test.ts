import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionDays,
  endFromValidity,
  isComplete,
  isUnchecked,
  rungsSentOn,
  sendDayFor,
  statusOf,
  validityFromDates,
} from "./engine";
import { DEFAULT_LADDERS } from "./catalogue";

/* The Locker's rules, pinned on fixed days (spec §14.4). 2026-10-09 is a Friday. */
const T = "2026-10-09";
const WEEK = [1, 2, 3, 4, 5, 6];

test("grace produces in_grace, not expired; past grace is expired", () => {
  const t = { leadDays: 45, graceDays: 15 };
  assert.equal(statusOf({ endDate: "2026-10-01", stage: null }, t, T), "in_grace");
  assert.equal(statusOf({ endDate: "2026-09-01", stage: null }, t, T), "expired");
});

test("a stage somebody set wins over the dates — renewal applied stays applied after the end date", () => {
  assert.equal(statusOf({ endDate: "2026-09-01", stage: "renewal_filed" }, { leadDays: 0, graceDays: 0 }, T), "renewal_filed");
});

test("inside the lead time it is due; inside 90 days it is expiring; lifetime is active", () => {
  const t = { leadDays: 60, graceDays: 0 };
  assert.equal(statusOf({ endDate: "2026-11-20", stage: null }, t, T), "renewal_due");
  assert.equal(statusOf({ endDate: "2026-12-30", stage: null }, t, T), "expiring");
  assert.equal(statusOf({ endDate: null, stage: null }, t, T), "active");
});

test("a term contract's action day is its notice deadline, before the expiry", () => {
  assert.equal(actionDays({ endDate: "2027-01-07", noticeDays: 90 }, "term_contract", T), 0);
  assert.equal(actionDays({ endDate: "2027-01-07", noticeDays: 90 }, "document", T), 90);
});

test("a business-critical asset fires all 13 ladder rungs on their days", () => {
  const action = "2027-06-30";
  const L = DEFAULT_LADDERS[4];
  let fired = 0;
  for (let i = -200; i <= 1; i++) {
    const d = new Date(Date.UTC(2027, 5, 30 + i)).toISOString().slice(0, 10);
    fired += rungsSentOn(L, action, d, [1, 2, 3, 4, 5, 6, 7]).length;
  }
  assert.equal(fired, 13);
});

test("a reminder due on a Sunday fires on the Saturday before", () => {
  /* 2026-10-11 is a Sunday. */
  assert.equal(sendDayFor("2026-10-11", WEEK), "2026-10-10");
  assert.deepEqual(rungsSentOn([0], "2026-10-11", "2026-10-10", WEEK), [0]);
  assert.deepEqual(rungsSentOn([0], "2026-10-11", "2026-10-11", WEEK), []);
});

test("after the last rung it repeats daily until resolved", () => {
  assert.deepEqual(rungsSentOn([-7, 0, 1], "2026-10-01", "2026-10-06", WEEK), [5]);
});

test("validity either direction: three years from 14 Mar 2026 ends 13 Mar 2029, and back", () => {
  assert.equal(endFromValidity("2026-03-14", 3, "years"), "2029-03-13");
  assert.deepEqual(validityFromDates("2026-03-14", "2029-03-13"), { n: 3, unit: "years" });
  assert.deepEqual(validityFromDates("2026-03-14", "2026-03-20"), { n: 7, unit: "days" });
});

test("never checked is unchecked; a critical asset with no backup is incomplete", () => {
  assert.equal(isUnchecked({ lastCheckedAt: null, criticality: 2 }, T), true);
  assert.equal(isUnchecked({ lastCheckedAt: "2026-09-01", criticality: 4 }, T), false);
  const base = { endDate: null, stage: null, criticality: 4, noticeDays: 0, ownerId: "u1", backupId: null, lastCheckedAt: "2026-10-01" };
  assert.equal(isComplete(base, T), false);
  assert.equal(isComplete({ ...base, backupId: "u2" }, T), true);
});
