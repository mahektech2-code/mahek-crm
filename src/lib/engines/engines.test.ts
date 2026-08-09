import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  defaultConfig,
  validateSetting,
  checkConsistency,
} from "../config/registry";
import {
  businessDate,
  isWorkingDay,
  nextWorkingDay,
  daysBetween,
  addDays,
} from "../business-date";
import { buyingCycle } from "./buying-cycle";
import { buildQueue, type QueueCandidate } from "./queue";
import {
  escalationStage,
  isAttemptAllowed,
  isSlowPayer,
  effectiveDueDate,
  type EscalationBill,
} from "./escalation";
import {
  planPaymentFollowUps,
  callingOpensOn,
  nextMessageOn,
  nextCallOn,
  type FollowUpSubject,
} from "./payment-followup";
import { evaluateInactivity, watchAge } from "./inactivity";
import { resolveTarget, classifyShortfall } from "./targets";
import { aggregateEod, eodPreflight, formatMoney } from "./eod";

/* ---------------------------------------------------------------------------
 * Every engine takes an injected clock and injected configuration, so these
 * run with no database, no network and no ambient time.
 * ------------------------------------------------------------------------- */

const C = defaultConfig();
const TODAY = "2026-08-03"; // a Monday

/* ============================================================ configuration */

describe("configuration", () => {
  test("rejects a non-integer where an integer is required", () => {
    const r = validateSetting("queue.checkInIntervalDays", 3.5);
    assert.equal(r.ok, false);
  });

  test("rejects a value below the declared minimum", () => {
    const r = validateSetting("buyingCycle.minIntervals", 0);
    assert.equal(r.ok, false);
  });

  test("rejects a value outside a text setting's options", () => {
    const r = validateSetting("buyingCycle.method", "mode");
    assert.equal(r.ok, false);
  });

  test("coerces numeric strings, since form posts arrive as text", () => {
    const r = validateSetting("queue.checkInIntervalDays", "21");
    assert.deepEqual(r, { ok: true, value: 21 });
  });

  test("the shipped defaults agree with each other", () => {
    // The aging buckets used to be 0/30/60/90 against escalation thresholds of
    // 7/21/45, which meant the bills screen and the follow-up screen disagreed
    // about how overdue the same account was. The payment follow-up policy
    // settled it: the buckets now trace the quiet window, then calling, then
    // urgent, and stage 2 is the day the quiet window closes.
    assert.deepEqual(checkConsistency(C), []);
  });

  test("catches a quiet window that disagrees with when calling opens", () => {
    const bad = { ...C, "escalation.quietCallDays": 20 };
    assert.ok(
      checkConsistency(bad).some((p) => p.includes("quiet window")),
      "a 20-day quiet window against stage 2 on day 16 must be reported",
    );
  });

  test("catches an empty list of payment terms", () => {
    const bad = { ...C, "bills.creditDayOptions": [] };
    assert.ok(checkConsistency(bad).some((p) => p.includes("payment term")));
  });

  test("aligned boundaries produce no problems at all", () => {
    const aligned = { ...C, "bills.agingBuckets": [0, 7, 21, 45] };
    assert.deepEqual(checkConsistency(aligned), []);
  });

  test("catches escalation thresholds that do not increase", () => {
    const bad = { ...C, "escalation.stage2Days": 5 };
    assert.ok(
      checkConsistency(bad).some((p) => p.includes("stage 1 < stage 2")),
    );
  });

  test("catches aging buckets that disagree with escalation thresholds", () => {
    const bad = { ...C, "bills.agingBuckets": [0, 17, 34, 51] };
    assert.ok(
      checkConsistency(bad).some((p) => p.includes("share no boundary")),
    );
  });
});

/* =========================================================== business dates */

describe("business dates", () => {
  const wd = {
    timezone: "Asia/Kolkata",
    dayBoundaryHour: 5,
    workingDays: [1, 2, 3, 4, 5, 6],
  };

  test("2 am IST still belongs to the previous working day", () => {
    // 2026-08-03T20:35Z is 2026-08-04T02:05 IST — before the 5 am boundary.
    assert.equal(
      businessDate(new Date("2026-08-03T20:35:00Z"), wd),
      "2026-08-03",
    );
  });

  test("6 am IST belongs to the new day", () => {
    assert.equal(
      businessDate(new Date("2026-08-04T00:35:00Z"), wd),
      "2026-08-04",
    );
  });

  test("Sunday is not a working day; Saturday is", () => {
    assert.equal(isWorkingDay("2026-08-09", wd), false); // Sunday
    assert.equal(isWorkingDay("2026-08-08", wd), true); // Saturday
  });

  test("next working day skips Sunday", () => {
    assert.equal(nextWorkingDay("2026-08-08", wd), "2026-08-10");
  });

  test("day arithmetic crosses a month boundary", () => {
    assert.equal(addDays("2026-08-31", 1), "2026-09-01");
    assert.equal(daysBetween("2026-08-31", "2026-09-01"), 1);
  });
});

/* ============================================================ E1 buying cycle */

describe("E1 buying cycle", () => {
  test("insufficient history returns the configured default, marked as default", () => {
    const r = buyingCycle(["2026-07-01", "2026-07-15"], C);
    assert.equal(r.isDefault, true);
    assert.equal(r.days, C["buyingCycle.defaultDays"]);
  });

  test("no history at all returns the default", () => {
    assert.equal(buyingCycle([], C).isDefault, true);
  });

  test("a single outlier interval does not distort a median-based cycle", () => {
    // Intervals: 14, 14, 14, 200 — a festival gap.
    const dates = [
      "2026-01-01",
      "2026-01-15",
      "2026-01-29",
      "2026-02-12",
      "2026-08-31",
    ];
    const r = buyingCycle(dates, C);
    assert.equal(r.isDefault, false);
    assert.equal(r.days, 14, "median should ignore the 200-day outlier");
  });

  test("the same outlier does distort a mean, which is why median is the default", () => {
    const dates = [
      "2026-01-01",
      "2026-01-15",
      "2026-01-29",
      "2026-02-12",
      "2026-08-31",
    ];
    const r = buyingCycle(dates, { ...C, "buyingCycle.method": "mean" });
    assert.ok(r.days > 50, `mean was ${r.days}`);
  });

  test("results clamp to the configured minimum", () => {
    const dates = [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ];
    assert.equal(buyingCycle(dates, C).days, C["buyingCycle.minDays"]);
  });

  test("results clamp to the configured maximum", () => {
    const dates = ["2020-01-01", "2021-01-01", "2022-01-01", "2023-01-01"];
    assert.equal(buyingCycle(dates, C).days, C["buyingCycle.maxDays"]);
  });

  test("two orders on the same day are not an interval of zero", () => {
    const dates = [
      "2026-01-01",
      "2026-01-01",
      "2026-01-15",
      "2026-01-29",
      "2026-02-12",
    ];
    assert.equal(buyingCycle(dates, C).days, 14);
  });

  test("only the most recent orders within the lookback are used", () => {
    const config = { ...C, "buyingCycle.lookbackOrders": 4 };
    // Old cadence 60 days, recent cadence 10 days. Lookback 4 = last 3 intervals.
    const dates = [
      "2025-01-01",
      "2025-03-02",
      "2025-05-01",
      "2026-01-01",
      "2026-01-11",
      "2026-01-21",
      "2026-01-31",
    ];
    assert.equal(buyingCycle(dates, config).days, 10);
  });
});

/* ============================================================== E2 queue */

function candidate(over: Partial<QueueCandidate> = {}): QueueCandidate {
  return {
    customerId: "c1",
    name: "Test Customer",
    ownerId: "u1",
    lastOrderDate: null,
    cycleDays: 30,
    cycleIsDefault: false,
    lastContactDate: TODAY,
    createdDate: "2025-01-01",
    reminders: [],
    lastConfirmedWhatsappDate: null,
    activeInOrderSystem: false,
    calledToday: false,
    doNotContact: false,
    skippedTodayReason: null,
    lastNoOrderDate: null,
    onInactiveWatch: false,
    outstanding: 0,
    targetGap: 0,
    ...over,
  };
}

describe("E2 queue builder", () => {
  test("a customer qualifying under three reasons returns ONE entry with all three", () => {
    // Check-in is deliberately NOT one of them: it applies only where the
    // cycle could not be measured, so it cannot stack on an order reason.
    const c = candidate({
      // order overdue by a full cycle
      lastOrderDate: addDays(TODAY, -70),
      cycleDays: 30,
      lastContactDate: addDays(TODAY, -40),
      // one reminder overdue, one due today
      reminders: [
        { id: "r1", dueDate: addDays(TODAY, -2), note: "Call back" },
        { id: "r2", dueDate: TODAY, note: "Send the rate list" },
      ],
    });
    const { entries } = buildQueue([c], TODAY, C);

    assert.equal(entries.length, 1, "one entry, not three");
    assert.equal(entries[0].reasons.length, 3);
    assert.equal(entries[0].score, C["queue.tierWeights"].reminderOverdue);
    assert.equal(
      entries[0].reasons[0].kind,
      "reminderOverdue",
      "highest first",
    );
  });

  test("two overdue reminders are two reasons, each naming its own note", () => {
    const c = candidate({
      lastContactDate: addDays(TODAY, -40),
      reminders: [
        { id: "r1", dueDate: addDays(TODAY, -2), note: "Call back" },
        { id: "r2", dueDate: addDays(TODAY, -5), note: "Chase the rate list" },
      ],
    });
    const { entries } = buildQueue([c], TODAY, C);

    const overdue = entries[0].reasons.filter(
      (r) => r.kind === "reminderOverdue",
    );
    assert.equal(
      overdue.length,
      2,
      "collapsing them would hide one of the two things the customer was promised",
    );
    assert.notEqual(
      overdue[0].label,
      overdue[1].label,
      "each carries its own note and its own days overdue",
    );
  });

  test("a customer active in the order system is SUPPRESSED, not omitted", () => {
    const c = candidate({
      lastContactDate: addDays(TODAY, -40),
      activeInOrderSystem: true,
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0);
    assert.equal(r.suppressed.length, 1);
    assert.match(r.suppressed[0].reason, /order system/i);
  });

  test("a hand skip suppresses for the day, carrying the reason given", () => {
    const c = candidate({
      lastContactDate: addDays(TODAY, -40),
      skippedTodayReason: "factory shut for stocktake",
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0);
    assert.equal(r.suppressed.length, 1);
    assert.match(r.suppressed[0].reason, /factory shut for stocktake/);
  });

  test("a CONFIRMED WhatsApp inside the cooldown suppresses", () => {
    const c = candidate({
      lastContactDate: addDays(TODAY, -40),
      lastConfirmedWhatsappDate: addDays(TODAY, -1),
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0);
    assert.match(r.suppressed[0].reason, /cooldown/i);
  });

  test("a COPIED BUT UNCONFIRMED WhatsApp does NOT suppress", () => {
    // The copy never sets lastConfirmedWhatsappDate, so the customer still
    // appears — the system does not know the message was sent.
    const c = candidate({
      lastContactDate: addDays(TODAY, -40),
      lastConfirmedWhatsappDate: null,
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 1);
    assert.equal(r.suppressed.length, 0);
  });

  test("a confirmed WhatsApp beyond the cooldown no longer suppresses", () => {
    const c = candidate({
      lastContactDate: addDays(TODAY, -40),
      lastConfirmedWhatsappDate: addDays(
        TODAY,
        -C["queue.whatsappCooldownDays"],
      ),
    });
    assert.equal(buildQueue([c], TODAY, C).entries.length, 1);
  });

  test("a customer already called today never appears", () => {
    const c = candidate({
      lastContactDate: addDays(TODAY, -40),
      calledToday: true,
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0);
    assert.match(r.suppressed[0].reason, /already called/i);
  });

  test("do-not-contact suppresses", () => {
    const c = candidate({
      lastContactDate: addDays(TODAY, -40),
      doNotContact: true,
    });
    assert.match(
      buildQueue([c], TODAY, C).suppressed[0].reason,
      /do not contact/i,
    );
  });

  test("a customer with no reason does not appear at all", () => {
    const r = buildQueue([candidate({ lastContactDate: TODAY })], TODAY, C);
    assert.equal(r.entries.length, 0);
    assert.equal(
      r.suppressed.length,
      0,
      "no reason means not a candidate, not suppressed",
    );
  });

  test("a customer who has never ordered is a PROSPECT, not a check-in", () => {
    const c = candidate({
      lastOrderDate: null,
      lastContactDate: addDays(TODAY, -40),
    });
    const { entries } = buildQueue([c], TODAY, C);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].reasons[0].kind, "prospect");
  });

  /* -------------------------------------------------- the quiet window */

  test("no order is chased inside the quiet window", () => {
    // Orders every 8 days, ordered 6 days ago, spoken to recently. They are
    // serving themselves and there is no check-in due either.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -6),
      cycleDays: 8,
      lastContactDate: addDays(TODAY, -1),
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0, "not called");
  });

  test("late by their own cycle but inside the quiet window is SUPPRESSED, not omitted", () => {
    // Cycle 8, ordered 12 days ago: overdue by their reckoning, but under 15.
    // Contacted yesterday, so no check-in is due to carry them onto the list.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -12),
      cycleDays: 8,
      lastContactDate: addDays(TODAY, -1),
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0);
    assert.equal(r.suppressed.length, 1);
    assert.match(r.suppressed[0].reason, /no order chased for 3 more days/);
  });

  /* --------------------------------- the weekly check-in on good customers */

  test("a fast-cycling customer gets NO weekly check-in", () => {
    // Ordered 2 days ago on an 8-day cycle, last spoken to 9 days ago. They
    // are in contact constantly through the orders themselves; a weekly call
    // on top is noise on both sides of the phone.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -2),
      cycleDays: 8,
      lastContactDate: addDays(TODAY, -9),
    });
    const { entries, suppressed } = buildQueue([c], TODAY, C);
    assert.equal(entries.length, 0);
    // Not held back either — two days after an order there is simply nothing
    // to call them about, which is a different thing from being suppressed.
    assert.equal(suppressed.length, 0);
  });

  test("past their call day but inside the quiet window, they are held back with a reason", () => {
    // Cycle 8, ordered 12 days ago: the order reason fires, the quiet window
    // silences it, and the telecaller is told why rather than left wondering.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -12),
      cycleDays: 8,
      lastContactDate: addDays(TODAY, -12),
    });
    const { entries, suppressed } = buildQueue([c], TODAY, C);
    assert.equal(entries.length, 0);
    assert.equal(suppressed.length, 1);
    assert.match(suppressed[0].reason, /order/i);
  });

  test("a fast-cycling customer comes back the moment they stop ordering", () => {
    // The same 8-day buyer, 20 days since their last order: out of the quiet
    // window, so the order reasons apply and they return for the reason that
    // actually matters.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -20),
      cycleDays: 8,
      lastContactDate: addDays(TODAY, -20),
    });
    const { entries } = buildQueue([c], TODAY, C);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].reasons.some((r) => r.kind.startsWith("order")));
  });

  test("a customer whose cycle is not measured yet still gets the check-in", () => {
    // No cycle to time a call from, so a steady cadence is all there is.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -12),
      cycleDays: 30,
      cycleIsDefault: true,
      lastContactDate: addDays(TODAY, -9),
    });
    const { entries } = buildQueue([c], TODAY, C);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].reasons[0].kind.startsWith("checkIn"));
    assert.match(entries[0].reasons[0].label, /cycle not established|Check-in due/);
  });

  test("a slow-cycling customer gets NO weekly check-in", () => {
    // A 60-day buyer contacted 9 days ago. Their cycle already says when to
    // call; a weekly check-in would ring them eight times before it is due.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -5),
      cycleDays: 60,
      lastContactDate: addDays(TODAY, -9),
    });
    assert.equal(buildQueue([c], TODAY, C).entries.length, 0);
  });

  test("past the quiet window, a fast-cycling customer is chased for an order", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -15),
      cycleDays: 8,
      lastContactDate: addDays(TODAY, -1),
    });
    const { entries } = buildQueue([c], TODAY, C);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].reasons.some((r) => r.kind.startsWith("order")));
  });

  test("a reminder overrides the quiet window", () => {
    // Ordered yesterday, but they asked to be called back today. A promise
    // the telecaller made outranks leaving a good customer alone.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -1),
      cycleDays: 8,
      reminders: [{ id: "r1", dueDate: TODAY, note: "Send the rate list" }],
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 1);
    assert.equal(r.suppressed.length, 0);
  });

  /* ------------------------------------------------------- the call day */

  test("a 22-day cycle is called on day 18", () => {
    const on17 = candidate({
      lastOrderDate: addDays(TODAY, -17),
      cycleDays: 22,
    });
    const on18 = candidate({
      lastOrderDate: addDays(TODAY, -18),
      cycleDays: 22,
    });
    assert.equal(
      buildQueue([on17], TODAY, C).entries.length,
      0,
      "day 17: too early",
    );
    assert.equal(
      buildQueue([on18], TODAY, C).entries.length,
      1,
      "day 18: called",
    );
  });

  test("the lead scales with the cycle and is capped at both ends", () => {
    const called = (cycleDays: number, sinceOrder: number) =>
      buildQueue(
        [candidate({ lastOrderDate: addDays(TODAY, -sinceOrder), cycleDays })],
        TODAY,
        C,
      ).entries.length === 1;

    // 20% of 30 = 6 → day 24.
    assert.equal(called(30, 23), false);
    assert.equal(called(30, 24), true);
    // 20% of 60 = 12, capped to 10 → day 50, not day 48.
    assert.equal(called(60, 49), false);
    assert.equal(called(60, 50), true);
    // 20% of 18 = 3.6 → 4 → day 14, but the quiet window floors it at 15.
    assert.equal(called(18, 14), false);
    assert.equal(called(18, 15), true);
  });

  test("a GUESSED cycle does not earn a call day", () => {
    // One order is not a pattern. Applying "call on day 18" to a cycle we
    // inferred would present a guess as a measurement.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -25),
      cycleDays: 30,
      cycleIsDefault: true,
      lastContactDate: addDays(TODAY, -2),
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0, "no order reason from a guessed cycle");
  });

  test("a customer with a guessed cycle falls through to check-in", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -60),
      cycleIsDefault: true,
      lastContactDate: addDays(TODAY, -20),
    });
    const { entries } = buildQueue([c], TODAY, C);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].reasons[0].kind.startsWith("checkIn"));
  });

  test("a customer imported with order history is dated from the order, not the row", () => {
    // The record was written today and the last order is 40 days old. Dating
    // the check-in from the row's creation holds a whole imported book off the
    // queue for a week — every screen empty, and nothing on any of them able
    // to say why.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleIsDefault: true,
      lastContactDate: null,
      createdDate: TODAY,
    });
    const { entries } = buildQueue([c], TODAY, C);
    assert.equal(entries.length, 1);
    assert.match(entries[0].reasons[0].label, /40 days/);
  });

  test("a real last-contact date still wins over the order date", () => {
    // Spoken to two days ago, ordered forty days ago: they have been
    // contacted, and the order is only a fallback for when nothing says so.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleIsDefault: true,
      lastContactDate: addDays(TODAY, -2),
      createdDate: TODAY,
    });
    assert.equal(buildQueue([c], TODAY, C).entries.length, 0);
  });

  /* -------------------------------------------------- no-order cooldown */

  test("a customer told us no is not asked again the next day", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      lastNoOrderDate: addDays(TODAY, -1),
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0);
    assert.match(r.suppressed[0].reason, /asking again in 6 days/);
  });

  test("a customer on the inactive watch is worked from that list, not the queue", () => {
    const c = candidate({
      // Well past twice their cycle, so the queue would otherwise rank them
      // among the most overdue customers on it — every day.
      lastOrderDate: addDays(TODAY, -200),
      cycleDays: 22,
      onInactiveWatch: true,
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0);
    assert.match(r.suppressed[0].reason, /inactive watch/i);
  });

  test("a reminder outranks the inactive watch", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -200),
      cycleDays: 22,
      onInactiveWatch: true,
      reminders: [{ id: "r1", dueDate: TODAY, note: "Ring back today" }],
    });
    // A callback the customer asked for is not chasing, and not making it is
    // worse than any wasted call.
    assert.equal(buildQueue([c], TODAY, C).entries.length, 1);
  });

  test("turning the setting off puts them back in the queue", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -200),
      cycleDays: 22,
      onInactiveWatch: true,
    });
    const off = { ...C, "queue.excludeInactiveWatch": false };
    assert.equal(buildQueue([c], TODAY, off).entries.length, 1);
  });

  test("the no-order cooldown expires", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      lastNoOrderDate: addDays(TODAY, -C["queue.noOrderCooldownDays"]),
    });
    assert.equal(buildQueue([c], TODAY, C).entries.length, 1);
  });

  test("a reminder overrides the no-order cooldown too", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      lastNoOrderDate: addDays(TODAY, -1),
      reminders: [{ id: "r1", dueDate: TODAY, note: "They said call today" }],
    });
    assert.equal(buildQueue([c], TODAY, C).entries.length, 1);
  });

  test("tie-breakers apply in order: outstanding, then target gap, then contact age", () => {
    const base = {
      lastContactDate: addDays(TODAY, -40), // same reason and weight for all
    };
    const low = candidate({
      ...base,
      customerId: "low",
      name: "Low",
      outstanding: 100,
    });
    const high = candidate({
      ...base,
      customerId: "high",
      name: "High",
      outstanding: 900,
    });
    const mid = candidate({
      ...base,
      customerId: "mid",
      name: "Mid",
      outstanding: 500,
    });

    const { entries } = buildQueue([low, high, mid], TODAY, C);
    assert.deepEqual(
      entries.map((e) => e.customerId),
      ["high", "mid", "low"],
    );

    // Equal outstanding falls through to target gap.
    const a = candidate({
      ...base,
      customerId: "a",
      outstanding: 100,
      targetGap: 10,
    });
    const b = candidate({
      ...base,
      customerId: "b",
      outstanding: 100,
      targetGap: 90,
    });
    assert.deepEqual(
      buildQueue([a, b], TODAY, C).entries.map((e) => e.customerId),
      ["b", "a"],
    );

    // Equal on both falls through to days since contact, oldest first.
    const recent = candidate({
      customerId: "recent",
      lastContactDate: addDays(TODAY, -30),
    });
    const stale = candidate({
      customerId: "stale",
      lastContactDate: addDays(TODAY, -90),
    });
    assert.deepEqual(
      buildQueue([recent, stale], TODAY, C).entries.map((e) => e.customerId),
      ["stale", "recent"],
    );
  });

  test("ranking puts an overdue reminder above an overdue order", () => {
    const reminder = candidate({
      customerId: "reminder",
      reminders: [{ id: "r", dueDate: addDays(TODAY, -1), note: "n" }],
    });
    const order = candidate({
      customerId: "order",
      lastOrderDate: addDays(TODAY, -70),
      cycleDays: 30,
    });
    assert.deepEqual(
      buildQueue([order, reminder], TODAY, C).entries.map((e) => e.customerId),
      ["reminder", "order"],
    );
  });

  test("truncates to the configured maximum but reports the true total", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      candidate({ customerId: `c${i}`, lastContactDate: addDays(TODAY, -40) }),
    );
    const r = buildQueue(many, TODAY, { ...C, "queue.maxSizePerUser": 4 });
    assert.equal(r.entries.length, 4);
    assert.equal(r.totalQualified, 10);
  });

  test("a maximum of 0 means unlimited", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      candidate({ customerId: `c${i}`, lastContactDate: addDays(TODAY, -40) }),
    );
    assert.equal(
      buildQueue(many, TODAY, { ...C, "queue.maxSizePerUser": 0 }).entries
        .length,
      10,
    );
  });
});

/* =========================================================== E3 escalation */

function bill(over: Partial<EscalationBill> = {}): EscalationBill {
  return {
    id: "b1",
    billNo: "MM/1",
    billDate: "2026-06-01",
    dueDate: "2026-07-01",
    amount: 100_000,
    paid: 0,
    disputed: false,
    ...over,
  };
}

describe("E3 escalation", () => {
  test("no overdue bills removes the customer from the worklist entirely", () => {
    assert.equal(escalationStage([], null, TODAY, C), null);
    assert.equal(
      escalationStage([bill({ dueDate: addDays(TODAY, 10) })], null, TODAY, C),
      null,
    );
  });

  test("full payment removes the customer immediately", () => {
    const paid = bill({ amount: 100_000, paid: 100_000 });
    assert.equal(escalationStage([paid], null, TODAY, C), null);
  });

  test("stage 1 prescribes WhatsApp and never a call", () => {
    const b = bill({ dueDate: addDays(TODAY, -10) }); // 10 days: stage 1 (7..20)
    const s = escalationStage([b], null, TODAY, C)!;
    assert.equal(s.stage, 1);
    assert.equal(s.nextChannel, "whatsapp");
  });

  test("a call attempt against stage 1 is rejected server-side", () => {
    const denied = isAttemptAllowed(1, "call");
    assert.equal(denied.allowed, false);
    assert.match((denied as { error: string }).error, /WhatsApp-only/i);
    assert.equal(isAttemptAllowed(1, "whatsapp").allowed, true);
  });

  test("stage 2 alternates channel across consecutive attempts", () => {
    const b = bill({ dueDate: addDays(TODAY, -25) }); // stage 2 (21..44)
    const afterWhatsapp = escalationStage(
      [b],
      { channel: "whatsapp", attemptedAt: addDays(TODAY, -1) },
      TODAY,
      C,
    )!;
    assert.equal(afterWhatsapp.stage, 2);
    assert.equal(afterWhatsapp.nextChannel, "call");

    const afterCall = escalationStage(
      [b],
      { channel: "call", attemptedAt: addDays(TODAY, -1) },
      TODAY,
      C,
    )!;
    assert.equal(afterCall.nextChannel, "whatsapp");
  });

  test("stage 3 prescribes a call", () => {
    const b = bill({ dueDate: addDays(TODAY, -60) });
    assert.equal(escalationStage([b], null, TODAY, C)!.nextChannel, "call");
  });

  test("boundaries are inclusive at the configured thresholds", () => {
    const at = (days: number) =>
      escalationStage(
        [bill({ dueDate: addDays(TODAY, -days) })],
        null,
        TODAY,
        C,
      )!.stage;
    // Stage 2 begins the day the quiet window closes: the same day the
    // calling list first offers the customer, and the first day a call may be
    // logged against them.
    assert.equal(at(15), 1);
    assert.equal(at(16), 2, "stage 2 begins exactly at its threshold");
    assert.equal(at(44), 2);
    assert.equal(at(45), 3, "stage 3 begins exactly at its threshold");
  });

  test("a customer with five overdue bills produces ONE entry", () => {
    const bills = Array.from({ length: 5 }, (_, i) =>
      bill({
        id: `b${i}`,
        billNo: `MM/${i}`,
        dueDate: addDays(TODAY, -10 - i),
        amount: 50_000,
      }),
    );
    const s = escalationStage(bills, null, TODAY, C)!;
    assert.equal(s.overdueCount, 5);
    assert.equal(s.totalOverdue, 250_000);
    assert.equal(s.anchorBillId, "b4", "oldest bill anchors by default");
  });

  test("the largest-bill driver anchors on value instead", () => {
    const bills = [
      bill({ id: "old", dueDate: addDays(TODAY, -40), amount: 10_000 }),
      bill({ id: "big", dueDate: addDays(TODAY, -10), amount: 900_000 }),
    ];
    const s = escalationStage(bills, null, TODAY, {
      ...C,
      "escalation.stageDriver": "largest",
    })!;
    assert.equal(s.anchorBillId, "big");
    assert.equal(s.daysOverdue, 10);
  });

  test("a disputed account holds at its current stage", () => {
    const b = bill({ dueDate: addDays(TODAY, -60), disputed: true }); // would be stage 3
    const s = escalationStage([b], null, TODAY, C, 1)!;
    assert.equal(s.stage, 1, "held at the stage it was already at");
    assert.equal(s.held, true);
    assert.match(s.heldReason!, /disputed/i);
  });

  test("a dispute does not hold when configuration says it should not", () => {
    const b = bill({ dueDate: addDays(TODAY, -60), disputed: true });
    const s = escalationStage(
      [b],
      null,
      TODAY,
      {
        ...C,
        "escalation.disputeHoldsEscalation": false,
      },
      1,
    )!;
    assert.equal(s.stage, 3);
    assert.equal(s.held, false);
  });

  test("a bill with no due date uses the default credit period", () => {
    const b = bill({ dueDate: null, billDate: "2026-06-01" });
    assert.equal(effectiveDueDate(b, C), "2026-07-01");
  });

  test("partial payment keeps the clock running by default", () => {
    const b = bill({
      dueDate: addDays(TODAY, -30),
      amount: 100_000,
      paid: 40_000,
    });
    const s = escalationStage([b], null, TODAY, C)!;
    assert.equal(s.daysOverdue, 30);
    assert.equal(s.totalOverdue, 60_000, "balance reduced, age unchanged");
  });

  test("slow payer flag counts late payments in the lookback", () => {
    const late = { dueDate: "2026-07-01", paidOn: "2026-07-20" };
    assert.equal(isSlowPayer([late, late], TODAY, C).slowPayer, false);
    assert.equal(isSlowPayer([late, late, late], TODAY, C).slowPayer, true);
  });

  test("on-time payments never earn the flag", () => {
    const onTime = { dueDate: "2026-07-20", paidOn: "2026-07-01" };
    assert.equal(
      isSlowPayer([onTime, onTime, onTime, onTime], TODAY, C).slowPayer,
      false,
    );
  });
});

/* ========================================================== E4 inactivity */

describe("E4 inactivity", () => {
  const cust = (cycleDays: number, lastOrderDate: string | null) => ({
    status: "active" as const,
    lastOrderDate,
    cycleDays,
    cycleIsDefault: false,
    avgOrderValue: 100_000,
  });

  test("a 30-day-cycle customer flags at exactly 60 days, and not at 59", () => {
    assert.equal(
      evaluateInactivity(cust(30, addDays(TODAY, -59)), TODAY, C).inactive,
      false,
    );
    assert.equal(
      evaluateInactivity(cust(30, addDays(TODAY, -60)), TODAY, C).inactive,
      true,
    );
  });

  test("a 15-day-cycle customer flags at 30", () => {
    assert.equal(
      evaluateInactivity(cust(15, addDays(TODAY, -29)), TODAY, C).inactive,
      false,
    );
    assert.equal(
      evaluateInactivity(cust(15, addDays(TODAY, -30)), TODAY, C).inactive,
      true,
    );
  });

  test("a 90-day-cycle customer flags at 180", () => {
    assert.equal(
      evaluateInactivity(cust(90, addDays(TODAY, -179)), TODAY, C).inactive,
      false,
    );
    assert.equal(
      evaluateInactivity(cust(90, addDays(TODAY, -180)), TODAY, C).inactive,
      true,
    );
  });

  test("the threshold is per customer, never global", () => {
    const day = addDays(TODAY, -100);
    assert.equal(evaluateInactivity(cust(15, day), TODAY, C).inactive, true);
    assert.equal(evaluateInactivity(cust(90, day), TODAY, C).inactive, false);
  });

  test("a customer with no order history is never flagged", () => {
    const r = evaluateInactivity(cust(30, null), TODAY, C);
    assert.equal(r.inactive, false);
    assert.match(r.skippedReason!, /no order history/i);
  });

  test("a customer already marked inactive stays flagged", () => {
    // The status is written from this result, so reading it back as a reason
    // to skip would make every flag erase itself the following night.
    const marked = {
      ...cust(30, addDays(TODAY, -90)),
      status: "inactive" as const,
    };
    const r = evaluateInactivity(marked, TODAY, C);
    assert.equal(r.inactive, true);
    assert.equal(r.skippedReason, null);
  });

  test("an order un-marks them - the same evaluation, a newer date", () => {
    const marked = {
      ...cust(30, addDays(TODAY, -90)),
      status: "inactive" as const,
    };
    assert.equal(
      evaluateInactivity({ ...marked, lastOrderDate: TODAY }, TODAY, C).inactive,
      false,
    );
  });

  test("a deactivated customer is never flagged", () => {
    const r = evaluateInactivity(
      { ...cust(30, addDays(TODAY, -300)), status: "deactivated" },
      TODAY,
      C,
    );
    assert.equal(r.inactive, false);
  });

  test("an incoming order clears the flag with no manual action", () => {
    const stale = cust(30, addDays(TODAY, -90));
    assert.equal(evaluateInactivity(stale, TODAY, C).inactive, true);
    // The only change is a newer order date — re-evaluation clears it.
    const ordered = { ...stale, lastOrderDate: TODAY };
    assert.equal(evaluateInactivity(ordered, TODAY, C).inactive, false);
  });

  test("cycles elapsed is reported to one decimal for the interface", () => {
    const r = evaluateInactivity(cust(30, addDays(TODAY, -72)), TODAY, C);
    assert.equal(r.cyclesElapsed, 2.4);
  });

  test("a watch record past the warning age needs a decision", () => {
    assert.equal(
      watchAge(addDays(TODAY, -20), false, TODAY, C).needsDecision,
      true,
    );
    assert.equal(
      watchAge(addDays(TODAY, -20), true, TODAY, C).needsDecision,
      false,
    );
    assert.equal(
      watchAge(addDays(TODAY, -3), false, TODAY, C).needsDecision,
      false,
    );
  });
});

/* ============================================================= E5 targets */

describe("E5 target resolver", () => {
  test("a manual target wins and is not marked as a default", () => {
    const r = resolveTarget(
      {
        manualAmount: 500_000,
        trailingAchievement: [1, 2, 3],
        customerSince: null,
        month: TODAY,
      },
      C,
    );
    assert.deepEqual(r, {
      amount: 500_000,
      isDefault: false,
      method: "manual",
    });
  });

  test("an unset target defaults to the trailing average, marked as default", () => {
    const r = resolveTarget(
      {
        manualAmount: null,
        trailingAchievement: [300, 200, 100],
        customerSince: null,
        month: TODAY,
      },
      C,
    );
    assert.equal(r.amount, 200);
    assert.equal(r.isDefault, true);
  });

  test("the uplift percentage applies to a defaulted target", () => {
    const r = resolveTarget(
      {
        manualAmount: null,
        trailingAchievement: [1000],
        customerSince: null,
        month: TODAY,
      },
      { ...C, "targets.defaultUpliftPercent": 10 },
    );
    assert.equal(r.amount, 1100);
  });

  test("a customer with no history defaults to zero rather than blank", () => {
    const r = resolveTarget(
      {
        manualAmount: null,
        trailingAchievement: [],
        customerSince: null,
        month: TODAY,
      },
      C,
    );
    assert.equal(r.amount, 0);
    assert.equal(r.isDefault, true);
  });

  test("a customer who joined mid-month is pro-rated", () => {
    const full = resolveTarget(
      {
        manualAmount: null,
        trailingAchievement: [3100],
        customerSince: null,
        month: "2026-08-03",
      },
      C,
    );
    const half = resolveTarget(
      {
        manualAmount: null,
        trailingAchievement: [3100],
        customerSince: "2026-08-16",
        month: "2026-08-03",
      },
      C,
    );
    assert.ok(
      half.amount < full.amount,
      `${half.amount} should be under ${full.amount}`,
    );
  });

  test("shortfall splits a coverage gap from a customer gap", () => {
    const onSchedule = {
      customerId: "contacted",
      name: "Contacted On Schedule",
      target: 1000,
      achieved: 200,
      contactsThisMonth: 10,
      cycleDays: 7,
    };
    const neglected = {
      customerId: "neglected",
      name: "Barely Contacted",
      target: 1000,
      achieved: 200,
      contactsThisMonth: 0,
      cycleDays: 7,
    };
    const r = classifyShortfall([onSchedule, neglected], TODAY);

    assert.deepEqual(
      r.customerGap.map((c) => c.customerId),
      ["contacted"],
    );
    assert.deepEqual(
      r.coverageGap.map((c) => c.customerId),
      ["neglected"],
    );
    assert.equal(r.totalShortfall, 1600);
  });

  test("customers on or above target are excluded from both groups", () => {
    const r = classifyShortfall(
      [
        {
          customerId: "ok",
          name: "On Target",
          target: 1000,
          achieved: 1000,
          contactsThisMonth: 0,
          cycleDays: 7,
        },
      ],
      TODAY,
    );
    assert.equal(r.coverageGap.length, 0);
    assert.equal(r.customerGap.length, 0);
  });

  test("groups are ordered by the size of the gap", () => {
    const mk = (id: string, achieved: number) => ({
      customerId: id,
      name: id,
      target: 1000,
      achieved,
      contactsThisMonth: 99,
      cycleDays: 7,
    });
    const r = classifyShortfall([mk("small", 900), mk("big", 100)], TODAY);
    assert.deepEqual(
      r.customerGap.map((c) => c.customerId),
      ["big", "small"],
    );
  });
});

/* ================================================================= E6 EOD */

describe("E6 EOD aggregator", () => {
  const input = {
    userName: "Priya Sharma",
    date: TODAY,
    callsAttempted: 42,
    callsConnected: 31,
    callsInbound: 5,
    callsMissed: 11,
    queueWorked: 42,
    ordersCaptured: 6,
    ordersCount: 6,
    ordersValue: 18_450_000,
    followUpsMade: 12,
    promisesCount: 4,
    promisesValue: 6_200_000,
    paymentsConfirmed: 0,
    remindersClosed: 8,
    remindersCreated: 5,
    remindersCarriedForward: 3,
    complaintsLogged: 1,
    whatsappSent: 9,
    ordersWithoutCall: 0,
    targetAchieved: 84_000_000,
    targetAmount: 120_000_000,
  };

  test("money uses Indian digit grouping", () => {
    assert.equal(formatMoney(18_450_000), "₹1,84,500");
    assert.equal(formatMoney(120_000_000), "₹12,00,000");
    assert.equal(formatMoney(100_000), "₹1,000");
    assert.equal(formatMoney(0), "₹0");
  });

  test("the WhatsApp text matches the specified shape", () => {
    const r = aggregateEod(input);
    assert.equal(
      r.whatsappText,
      [
        "*EOD - Priya Sharma*",
        "03 Aug 2026",
        "",
        "Calls: 42 attempted · 31 connected · 11 missed · 5 inbound",
        "Orders: 6 (₹1,84,500)",
        "Payments: 12 followed up · ₹62,000 promised",
        "Reminders: 8 closed · 3 carried forward",
        "Complaints: 1 logged",
        "Target: ₹8,40,000 of ₹12,00,000 (70%)",
      ].join("\n"),
    );
  });

  test("a day's work is not reported as nothing because accounts have not got to it", () => {
    // Three orders taken, one approved so far. The telecaller pastes this
    // into the team group as their record of the day.
    const r = aggregateEod({ ...input, ordersCaptured: 3, ordersCount: 1, ordersValue: 40_000_00 });
    const orders = r.lines.find((l) => l.label === "Orders");
    assert.equal(orders?.value, "3 taken · 1 approved · ₹40,000");
    assert.match(r.whatsappText, /Orders: 3 taken · 1 approved/);
  });

  test("a day where everything taken was approved reads as one number", () => {
    // The split is worth showing only when it means something.
    const r = aggregateEod({ ...input, ordersCaptured: 6, ordersCount: 6 });
    assert.equal(r.lines.find((l) => l.label === "Orders")?.value, "6 · ₹1,84,500");
    assert.match(r.whatsappText, /Orders: 6 \(₹1,84,500\)/);
  });

  test("the queue figure is a count of work done, not a second progress bar", () => {
    // It used to read "x of y" with a y computed differently from the Call
    // Log's, so the two screens disagreed about the same day.
    const r = aggregateEod({ ...input, queueWorked: 4 });
    assert.equal(
      r.lines.find((l) => l.label === "Customers called from the queue")?.value,
      "4",
    );
    assert.equal(r.lines.some((l) => l.value.includes(" of ")), true, "target line still reads 'of'");
  });

  test("the WhatsApp text contains nothing that renders badly", () => {
    const { whatsappText } = aggregateEod(input);
    assert.ok(!whatsappText.includes("|"), "no table pipes");
    assert.ok(!whatsappText.includes("\t"), "no tabs");
    assert.ok(!/^[-*+] /m.test(whatsappText), "no markdown bullets");
    assert.ok(
      whatsappText.split("\n").every((l) => l.length <= 60),
      "lines stay short enough not to wrap awkwardly",
    );
  });

  test("a zero-activity day still produces a report", () => {
    const zero = aggregateEod({
      ...input,
      callsAttempted: 0,
      callsConnected: 0,
      callsInbound: 0,
      callsMissed: 0,
      ordersWithoutCall: 0,
      ordersCaptured: 0,
      ordersCount: 0,
      ordersValue: 0,
      targetAchieved: 0,
    });
    assert.match(zero.whatsappText, /Calls: 0 attempted/);
    assert.match(zero.whatsappText, /\(0%\)/);
  });

  test("the pre-flight gate blocks while reminders due today are open", () => {
    const blocked = eodPreflight([
      {
        id: "r1",
        customerName: "Shree Paints",
        note: "Call back",
        dueDate: TODAY,
      },
    ]);
    assert.equal(blocked.canFinalise, false);
    assert.match((blocked as { message: string }).message, /still open/i);
  });

  test("the gate opens once nothing is left", () => {
    assert.equal(eodPreflight([]).canFinalise, true);
  });

  test("the gate wording is singular for one reminder", () => {
    const one = eodPreflight([
      { id: "r", customerName: "X", note: "n", dueDate: TODAY },
    ]) as { message: string };
    assert.match(one.message, /^1 reminder due today is still open/);
  });
});

/* =================================================== E7 payment follow-up */

function subject(over: Partial<FollowUpSubject> = {}): FollowUpSubject {
  return {
    customerId: "c1",
    name: "Shree Paints",
    anchorDueDate: addDays(TODAY, -20),
    totalOverdue: 250_000,
    overdueBillCount: 2,
    lastMessageOn: null,
    lastCallOn: null,
    doNotContact: false,
    contactedToday: false,
    held: false,
    heldReason: null,
    promisedDate: null,
    ...over,
  };
}

describe("E7 payment follow-up cadence", () => {
  test("the quiet window silences calls for fifteen days after the due date", () => {
    // Day 15 is the last quiet day; day 16 is the first calling day.
    const lastQuiet = planPaymentFollowUps(
      [subject({ anchorDueDate: addDays(TODAY, -15) })],
      TODAY,
      C,
    );
    assert.equal(lastQuiet.calls.length, 0);

    const firstCalling = planPaymentFollowUps(
      [subject({ anchorDueDate: addDays(TODAY, -16) })],
      TODAY,
      C,
    );
    assert.equal(firstCalling.calls.length, 1);
    assert.equal(firstCalling.calls[0].phase, "calling");
  });

  test("a customer held back inside the quiet window says so, and says until when", () => {
    const plan = planPaymentFollowUps(
      [subject({ anchorDueDate: addDays(TODAY, -2) })],
      TODAY,
      C,
    );
    const held = plan.heldBack.find((h) => h.channel === "call");
    assert.ok(held, "somebody expected on the calling list must be accounted for");
    assert.match(held.reason, /messages only until 2026-08-17/);
  });

  test("the first reminder goes one interval after the due date, not the morning after", () => {
    const dayThree = planPaymentFollowUps(
      [subject({ anchorDueDate: addDays(TODAY, -3) })],
      TODAY,
      C,
    );
    assert.equal(dayThree.messages.length, 0);

    const dayFour = planPaymentFollowUps(
      [subject({ anchorDueDate: addDays(TODAY, -4) })],
      TODAY,
      C,
    );
    assert.equal(dayFour.messages.length, 1);
  });

  test("reminders then run every four days from the last one actually sent", () => {
    const resting = planPaymentFollowUps(
      [subject({ lastMessageOn: addDays(TODAY, -3) })],
      TODAY,
      C,
    );
    assert.equal(resting.messages.length, 0);

    const due = planPaymentFollowUps(
      [subject({ lastMessageOn: addDays(TODAY, -4) })],
      TODAY,
      C,
    );
    assert.equal(due.messages.length, 1);
    assert.equal(due.messages[0].daysSinceLast, 4);
  });

  test("messages do not stop when calling begins - the two run alongside", () => {
    const plan = planPaymentFollowUps(
      [
        subject({
          anchorDueDate: addDays(TODAY, -30),
          lastMessageOn: addDays(TODAY, -5),
          lastCallOn: addDays(TODAY, -4),
        }),
      ],
      TODAY,
      C,
    );
    assert.equal(plan.calls.length, 1);
    assert.equal(plan.messages.length, 1);
  });

  test("a logged call buys three days of rest, and the rest is explained", () => {
    const resting = planPaymentFollowUps(
      [subject({ anchorDueDate: addDays(TODAY, -30), lastCallOn: addDays(TODAY, -2) })],
      TODAY,
      C,
    );
    assert.equal(resting.calls.length, 0);
    const restingHold = resting.heldBack.find((h) => h.channel === "call");
    assert.ok(restingHold, "a held-back call must say why");
    assert.match(restingHold.reason, /due again on 2026-08-04/);

    const due = planPaymentFollowUps(
      [subject({ anchorDueDate: addDays(TODAY, -30), lastCallOn: addDays(TODAY, -3) })],
      TODAY,
      C,
    );
    assert.equal(due.calls.length, 1);
  });

  test("resting after a call never brings a customer back before calling opens", () => {
    // Called on day 12 of the quiet window: three days later is day 15, which
    // is still quiet. The window wins.
    const s = subject({
      anchorDueDate: addDays(TODAY, -15),
      lastCallOn: addDays(TODAY, -3),
    });
    assert.equal(nextCallOn(s, C), addDays(TODAY, 1));
    assert.equal(planPaymentFollowUps([s], TODAY, C).calls.length, 0);
  });

  test("a live promise stops both channels; a broken one does not", () => {
    const live = planPaymentFollowUps(
      [subject({ anchorDueDate: addDays(TODAY, -30), promisedDate: addDays(TODAY, 2) })],
      TODAY,
      C,
    );
    assert.equal(live.calls.length, 0);
    assert.equal(live.messages.length, 0);
    assert.match(live.heldBack[0].reason, /promised by 2026-08-05/);

    const broken = planPaymentFollowUps(
      [subject({ anchorDueDate: addDays(TODAY, -30), promisedDate: addDays(TODAY, -1) })],
      TODAY,
      C,
    );
    assert.equal(broken.calls.length, 1);
  });

  test("a promise made for today is still live - chasing it is what breaks it", () => {
    const plan = planPaymentFollowUps(
      [subject({ anchorDueDate: addDays(TODAY, -30), promisedDate: TODAY })],
      TODAY,
      C,
    );
    assert.equal(plan.calls.length, 0);
  });

  test("do not contact, a dispute and today's call each stop the chasing", () => {
    const base = { anchorDueDate: addDays(TODAY, -30) };
    for (const [over, pattern] of [
      [{ doNotContact: true }, /do not contact/i],
      [{ held: true, heldReason: "Bill MM/44 is disputed" }, /disputed/],
      [{ contactedToday: true }, /already contacted today/i],
    ] as const) {
      const plan = planPaymentFollowUps([subject({ ...base, ...over })], TODAY, C);
      assert.equal(plan.calls.length, 0, JSON.stringify(over));
      assert.equal(plan.messages.length, 0, JSON.stringify(over));
      assert.match(plan.heldBack[0].reason, pattern);
    }
  });

  test("a customer not yet due appears nowhere at all", () => {
    const plan = planPaymentFollowUps(
      [subject({ anchorDueDate: addDays(TODAY, 5) })],
      TODAY,
      C,
    );
    assert.deepEqual(plan, { calls: [], messages: [], heldBack: [] });
  });

  test("the oldest debt leads the calling list", () => {
    const plan = planPaymentFollowUps(
      [
        subject({ customerId: "young", name: "A", anchorDueDate: addDays(TODAY, -20) }),
        subject({ customerId: "old", name: "B", anchorDueDate: addDays(TODAY, -90) }),
      ],
      TODAY,
      C,
    );
    assert.deepEqual(plan.calls.map((c) => c.customerId), ["old", "young"]);
  });

  test("the dates the cadence is built from are stated, not implied", () => {
    assert.equal(callingOpensOn("2026-07-01", C), "2026-07-17");
    assert.equal(nextMessageOn({ anchorDueDate: "2026-07-01", lastMessageOn: null }, C), "2026-07-05");
    assert.equal(
      nextMessageOn({ anchorDueDate: "2026-07-01", lastMessageOn: "2026-07-10" }, C),
      "2026-07-14",
    );
  });
});

/* ============================================ E3 manual stage floor */

describe("E3 the hand-raised stage floor", () => {
  const overdue = (days: number) => [bill({ dueDate: addDays(TODAY, -days) })];

  test("a floor raises a young account to the stage a refusal earned it", () => {
    // Ten days overdue is stage 1 on age alone.
    assert.equal(escalationStage(overdue(10), null, TODAY, C)!.stage, 1);

    const floored = escalationStage(overdue(10), null, TODAY, C, null, 2)!;
    assert.equal(floored.stage, 2);
    assert.equal(floored.floored, true, "the screen must be able to say why");
  });

  test("a floor never lowers a stage the account has aged into", () => {
    // Fifty days overdue is stage 3; a floor of 2 must not pull it back.
    const aged = escalationStage(overdue(50), null, TODAY, C, null, 2)!;
    assert.equal(aged.stage, 3);
    assert.equal(aged.floored, false, "age drove this, not the floor");
  });

  test("a floor changes what may be logged, not just what is shown", () => {
    // The point of raising it: stage 1 refuses a call, stage 2 allows one.
    const floored = escalationStage(overdue(3), null, TODAY, C, null, 2)!;
    assert.equal(isAttemptAllowed(floored.stage, "call").allowed, true);
    assert.equal(isAttemptAllowed(1, "call").allowed, false);
  });

  test("no floor leaves the derived stage exactly as it was", () => {
    for (const days of [3, 10, 16, 30, 45, 90]) {
      assert.equal(
        escalationStage(overdue(days), null, TODAY, C, null, null)!.stage,
        escalationStage(overdue(days), null, TODAY, C)!.stage,
        `${days} days must be unaffected`,
      );
    }
  });
});
