import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isWorkedDay,
  leaveBalances,
  leaveDebitDays,
  leaveWorkingDays,
  type LeaveCalendar,
} from "./leave";

/*
 * Leave. The whole module had no test of any kind — not the engine, not the
 * sync handler, not the balance — which is most of why every one of the faults
 * pinned below survived to production. Nothing was ever wrong on a screen,
 * because nobody had ever asked for a day off.
 *
 * Mahek works a six-day week: Monday to Saturday, Sunday off.
 */
const MON_TO_SAT = [1, 2, 3, 4, 5, 6];

const calendar = (holidays: string[] = []): LeaveCalendar => ({
  workingDays: MON_TO_SAT,
  holidays: new Set(holidays),
});

describe("what a day off costs", () => {
  /* 2026-09-11 is a Friday, 12 a Saturday, 13 a Sunday, 14 a Monday. */

  test("a day nobody works is not a day of leave", () => {
    assert.equal(isWorkedDay("2026-09-11", calendar()), true, "Friday is worked");
    assert.equal(isWorkedDay("2026-09-13", calendar()), false, "Sunday is not");
  });

  test("a holiday is not a working day whatever the weekday says", () => {
    assert.equal(isWorkedDay("2026-09-14", calendar()), true);
    assert.equal(
      isWorkedDay("2026-09-14", calendar(["2026-09-14"])),
      false,
      "a Monday the company is shut is still a Monday nobody works",
    );
  });

  test("Friday to Monday costs two days, not four", () => {
    /* The fault this engine was written for: both ends counted plain calendar
       days, so a long weekend spent four days of somebody's balance to be
       absent for two. */
    assert.equal(leaveWorkingDays("2026-09-11", "2026-09-14", calendar()), 3);
    assert.equal(
      leaveWorkingDays("2026-09-12", "2026-09-14", calendar()),
      2,
      "Saturday and Monday, with the Sunday between them free",
    );
  });

  test("a holiday inside the range comes off the count too", () => {
    assert.equal(
      leaveWorkingDays("2026-09-14", "2026-09-16", calendar()),
      3,
      "Monday to Wednesday",
    );
    assert.equal(
      leaveWorkingDays("2026-09-14", "2026-09-16", calendar(["2026-09-15"])),
      2,
      "the Tuesday is a holiday, so it is not leave",
    );
  });

  test("a request made entirely of days nobody works counts nothing", () => {
    assert.equal(
      leaveWorkingDays("2026-09-13", "2026-09-13", calendar()),
      0,
      "asking for the Sunday off is not a request — the handler refuses it " +
        "rather than storing a day of leave that debits nothing",
    );
  });

  test("dates the wrong way round count nothing rather than looping", () => {
    assert.equal(leaveWorkingDays("2026-09-14", "2026-09-11", calendar()), 0);
  });

  test("a span longer than the ceiling stops rather than running away", () => {
    /* An unbounded loop between two dates a handset chose is a way to hang the
       sync endpoint with two characters. The handler refuses the span on its
       length; this only has to terminate. */
    const n = leaveWorkingDays("2026-01-01", "2099-01-01", calendar());
    assert.ok(n > 0 && n <= 400, `bounded, got ${n}`);
  });
});

describe("what the balance is actually debited", () => {
  test("a half day costs half a day", () => {
    /* The handset promises 0.5 on the form before the request is sent. The
       server stored `days` as an integer 1 and debited the whole of it, so a
       morning off cost a full day of casual leave and the only place the
       difference showed was the balance. */
    assert.equal(leaveDebitDays(1, true), 0.5);
    assert.equal(leaveDebitDays(1, false), 1);
  });

  test("a half-day marker on a range is ignored", () => {
    /* The middle days of a range are whole days whatever the marker says —
       the same reading the handset's own engine takes. */
    assert.equal(leaveDebitDays(3, true), 3);
  });

  test("nothing spans nothing", () => {
    assert.equal(leaveDebitDays(0, true), 0);
    assert.equal(leaveDebitDays(0, false), 0);
  });
});

describe("what somebody has left", () => {
  const entitlement = { casual: 12, sick: 6, earned: 12 };

  test("every kind is offered before anybody has taken any", () => {
    /* THE bug. The only code that created a balance row was the approval path,
       so a person had a row for a kind of leave only after taking some of it —
       and the handset builds its list of kinds from these rows. With none, the
       form could offer nothing but loss of pay, so every request a salesman
       could make was unpaid and no screen said why. */
    const rows = leaveBalances(entitlement, {});
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["casual", "earned", "sick"],
    );
    assert.deepEqual(
      rows.map((r) => r.available),
      [12, 12, 6],
      "a full year in hand, without a row existing anywhere",
    );
  });

  test("loss of pay is not a kind anybody has a balance of", () => {
    const rows = leaveBalances(entitlement, { loss_of_pay: 4 });
    assert.ok(
      !rows.some((r) => r.kind === "loss_of_pay"),
      "it is what leave becomes when the balance runs out, not an allowance",
    );
  });

  test("what has been spent comes off", () => {
    const [casual] = leaveBalances(entitlement, { casual: 2.5 });
    assert.deepEqual(casual, { kind: "casual", entitled: 12, used: 2.5, available: 9.5 });
  });

  test("a person on different terms overrides the configured entitlement", () => {
    const [casual] = leaveBalances(entitlement, { casual: 1 }, { casual: 20 });
    assert.equal(casual.entitled, 20);
    assert.equal(casual.available, 19);
  });

  test("an override of zero is a real answer, not a missing one", () => {
    const [casual] = leaveBalances(entitlement, {}, { casual: 0 });
    assert.equal(
      casual.entitled,
      0,
      "`?? ` and not `||` — somebody deliberately given no casual leave must " +
        "not silently fall back to everybody else's twelve days",
    );
  });

  test("an overdraft is shown rather than floored at zero", () => {
    const [casual] = leaveBalances(entitlement, { casual: 14 });
    assert.equal(
      casual.available,
      -2,
      "somebody granted more than they had is genuinely overdrawn, and the " +
        "screen is where that gets noticed instead of the payslip",
    );
  });

  test("a kind with no entitlement configured is not offered at all", () => {
    const rows = leaveBalances({ casual: 12 }, { sick: 3 });
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["casual"],
      "usage of a kind nobody is entitled to does not invent an entitlement",
    );
  });
});
