import { test, describe } from "node:test";
import { shortDateWithYear } from "@/lib/format";
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
import { buyingCycle, cycleConfidence, confidenceBand } from "./buying-cycle";
import { buildQueue, type QueueCandidate } from "./queue";
import {
  agingBucket,
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
import { parseJobArgs } from "../job-args";
import { parseReceivables, parseTallyDate, parseAmountPaise } from "../receivables-parse";
import {
  financialYearOf,
  financialYearRange,
  financialYearsBetween,
} from "../financial-year";

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
    // Boundaries are exclusive, so these open bands on days 1, 16, 30 and 60 —
    // and 16 and 30 are where stages 2 and 3 begin. A fourth band beyond the
    // ladder is fine; it is the shared boundary that matters.
    const aligned = { ...C, "bills.agingBuckets": [0, 15, 29, 59] };
    assert.deepEqual(checkConsistency(aligned), []);
  });

  test("the shipped bands are 0–15, 16–29 and 30+", () => {
    const label = (days: number) => agingBucket(days, C);
    assert.equal(label(0), "Not due");
    assert.equal(label(15), "1–15 days");
    assert.equal(label(16), "16–29 days");
    assert.equal(label(29), "16–29 days");
    // The open-ended band used to be named after the boundary below it — "29+"
    // — which claimed a day the band beneath it already owned.
    assert.equal(label(30), "30+ days");
    assert.equal(label(400), "30+ days");
  });

  test("catches escalation thresholds that do not increase", () => {
    const bad = { ...C, "escalation.stage3Days": 10 };
    assert.ok(
      checkConsistency(bad).some((p) => p.includes("stage 1 < stage 2")),
    );
  });

  test("catches aging buckets that disagree with escalation thresholds", () => {
    const bad = { ...C, "bills.agingBuckets": [0, 17, 34, 51] };
    assert.ok(
      checkConsistency(bad).some((p) => p.includes("escalation stage begins")),
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

  test("a real two-day cycle survives as two days", () => {
    // The floor was 7, described as a clamp against absurd figures. It was not:
    // same-day orders are already excluded as one purchase split across bills,
    // so every interval reaching the clamp is a real gap between real orders,
    // and a customer buying every two days was recorded as buying every seven.
    // The cycle is what decides when they are called, so that was an order
    // chased five days late, every cycle, forever.
    const dates = ["2026-08-01", "2026-08-03", "2026-08-05", "2026-08-07"];
    const cycle = buyingCycle(dates, C);
    assert.equal(cycle.days, 2);
    assert.equal(cycle.isDefault, false);
  });

  test("the floor is 1, which is the only thing it is for", () => {
    // A cycle of zero would mean "due immediately" for the rest of time. Same-
    // day orders are dropped before the clamp, so reaching zero is not possible
    // from real data — the floor is what guarantees it either way, and one day
    // is as short as a real cycle can be.
    assert.equal(C["buyingCycle.minDays"], 1);
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
    // A perfectly regular customer, so the confidence swing leaves the
    // existing tests exactly where they were. The tests that care set it.
    cycleConfidence: 50,
    typicalOrderPaise: 0,
    lastContactDate: TODAY,
    createdDate: "2025-01-01",
    reminders: [],
    lastConfirmedWhatsappDate: null,
    activeInOrderSystem: false,
  thirdParty: false,
    calledToday: false,
    doNotContact: false,
    skippedTodayReason: null,
    lastAnsweredOutcome: null,
    lastAnsweredDate: null,
    noAnswerCount: 0,
    lastNoAnswerAt: null,
    openOrderStatus: null,
    paymentCallDue: null,
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
        { id: "r1", dueDate: addDays(TODAY, -2), note: "Call back", holdOtherReasonsUntilDue: false },
        { id: "r2", dueDate: TODAY, note: "Send the rate list", holdOtherReasonsUntilDue: false },
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
        { id: "r1", dueDate: addDays(TODAY, -2), note: "Call back", holdOtherReasonsUntilDue: false },
        { id: "r2", dueDate: addDays(TODAY, -5), note: "Chase the rate list", holdOtherReasonsUntilDue: false },
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

  test("a reminder outranks the WhatsApp cooldown", () => {
    // A message we chose to send must not cancel a callback the customer
    // asked for. The cooldown exists to stop us contacting somebody twice for
    // no reason; a promised call is a reason.
    const c = candidate({
      lastContactDate: addDays(TODAY, -40),
      lastConfirmedWhatsappDate: addDays(TODAY, -1),
      reminders: [{ id: "r1", dueDate: TODAY, note: "Call back after 3", holdOtherReasonsUntilDue: false }],
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 1);
    assert.equal(r.suppressed.length, 0);
    assert.ok(r.entries[0].reasons.some((x) => x.kind === "reminderDueToday"));
  });

  test("a reminder does NOT outrank having already been called today", () => {
    // The opposite half of the rule above, and the reason it is not simply
    // "reminders always win": they have been spoken to, so the promise is kept.
    const c = candidate({
      lastContactDate: addDays(TODAY, -40),
      calledToday: true,
      reminders: [{ id: "r1", dueDate: TODAY, note: "Call back after 3", holdOtherReasonsUntilDue: false }],
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0);
    assert.match(r.suppressed[0].reason, /already called today/i);
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

  test("a stock check inside the quiet window is SUPPRESSED, not omitted", () => {
    // Cycle 16, ordered 12 days ago: 70% of 16 is 11, so the stock check has
    // come due — and the window still has three days to run. Contacted
    // yesterday, so no check-in is due to carry them onto the list.
    //
    // Sixteen days and not eight: on an eight-day cycle the window is now
    // capped at eight, so a customer twelve days out is not inside it at all.
    // They are overdue, and they are called.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -12),
      cycleDays: 16,
      lastContactDate: addDays(TODAY, -1),
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0);
    assert.equal(r.suppressed.length, 1);
    assert.match(r.suppressed[0].reason, /no order chased for 3 more days/);
  });

  /* --------------------- the window never outlasts the customer's own cycle */

  test("a short-cycle customer is chased ON their due date, like everybody else", () => {
    // Eight-day cycle, ordered eight days ago. The flat fifteen-day window used
    // to hold them another week — a whole cycle missed before anybody rang, on
    // the customers who order most often. It is capped at their cycle now.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -8),
      cycleDays: 8,
      lastContactDate: addDays(TODAY, -8),
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.suppressed.length, 0, "not held back");
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].reasons[0].kind, "orderDue");
  });

  test("and every day after it, rather than from day 15", () => {
    const kinds = (sinceOrder: number) =>
      buildQueue(
        [
          candidate({
            lastOrderDate: addDays(TODAY, -sinceOrder),
            cycleDays: 7,
            lastContactDate: addDays(TODAY, -sinceOrder),
          }),
        ],
        TODAY,
        C,
      );

    assert.equal(kinds(6).entries.length, 0, "day 6: still quiet, order not due");
    assert.equal(kinds(7).entries.length, 1, "day 7: due");
    assert.equal(kinds(9).entries.length, 1, "day 9: overdue, not waiting for day 15");
    assert.equal(kinds(12).entries.length, 1, "day 12: still on the list");
  });

  test("the stock check is the ONLY thing a short cycle loses", () => {
    // The point of the whole change. Before the due date: nothing, because a
    // customer buying every eight days knows what is on their shelf. On it and
    // after it: chased exactly like a thirty-day customer.
    const at = (sinceOrder: number) =>
      buildQueue(
        [
          candidate({
            lastOrderDate: addDays(TODAY, -sinceOrder),
            cycleDays: 8,
            lastContactDate: addDays(TODAY, -sinceOrder),
          }),
        ],
        TODAY,
        C,
      );

    // 70% of 8 is 6 — where a stock check would land if short cycles got one.
    assert.equal(at(6).entries.length, 0, "no stock check before the due date");
    assert.equal(at(7).entries.length, 0, "nor the day before");
    assert.equal(at(8).entries[0].reasons[0].kind, "orderDue");
  });

  test("a longer cycle keeps the full window, unchanged", () => {
    // The cap takes the LESSER of the two, so nothing moves for anybody whose
    // cycle is longer than the window — which is every customer the window was
    // written for.
    const at = (cycleDays: number, sinceOrder: number) =>
      buildQueue(
        [candidate({ lastOrderDate: addDays(TODAY, -sinceOrder), cycleDays })],
        TODAY,
        C,
      ).entries.length;

    assert.equal(at(30, 20), 0, "30-day cycle: no stock check before day 21");
    assert.equal(at(30, 21), 1, "30-day cycle: stock check on day 21");
    assert.equal(at(20, 14), 0, "20-day cycle: still held by the 15-day window");
    assert.equal(at(20, 15), 1, "20-day cycle: released on day 15");
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
    // Cycle 16, ordered 12 days ago: the stock check fires, the quiet window
    // silences it, and the telecaller is told why rather than left wondering.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -12),
      cycleDays: 16,
      lastContactDate: addDays(TODAY, -12),
    });
    const { entries, suppressed } = buildQueue([c], TODAY, C);
    assert.equal(entries.length, 0);
    assert.equal(suppressed.length, 1);
    assert.match(suppressed[0].reason, /order/i);
  });

  test("a fast-cycling customer comes back the moment they stop ordering", () => {
    // The same 8-day buyer, 20 days since their last order: long past both the
    // window and their own due date, so the order reasons apply.
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

  test("an ORDER counts as contact for the check-in, even against an older call", () => {
    // Ordered through the sheet on Saturday, last logged call three weeks ago.
    // Somebody spoke to them to take that order, so the check-in dates from it
    // — reading the stale call first would ring a customer who ordered two
    // days ago to ask how they are getting on.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -2),
      cycleIsDefault: true,
      lastContactDate: addDays(TODAY, -21),
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0);
  });

  test("a stale order does not hold back a check-in the calls have earned", () => {
    // The other direction: contacted 9 days ago, ordered 40 days ago. The
    // later of the two is the call, and the check-in is due from it.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleIsDefault: true,
      lastContactDate: addDays(TODAY, -9),
    });
    const { entries } = buildQueue([c], TODAY, C);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].reasons[0].kind.startsWith("checkIn"));
  });

  test("a guessed cycle never reaches the held-back sentence at all", () => {
    // Pins why that sentence is allowed to name `cycleDays`. Ordered 3 days
    // ago with an unmeasured cycle: no order reason is generated, so the quiet
    // window strips nothing, so the customer is never suppressed BY it — they
    // simply have no reason to be called today. The guessed default cannot
    // reach a telecaller's eyes through this path.
    // A 16-day cycle 12 days on: past the stock-check day (11), inside the
    // window (15) — the one shape that produces the sentence.
    //
    // Not an 8-day cycle any more: the window is capped at the customer's own
    // cycle, so an 8-day buyer 12 days out is overdue and called rather than
    // held. A guessed cycle is exempt from that cap for the same reason it is
    // exempt from everything else here — a default is not a due date.
    const guessed = candidate({
      lastOrderDate: addDays(TODAY, -12),
      cycleDays: 16,
      cycleIsDefault: true,
      lastContactDate: addDays(TODAY, -1),
    });
    const r = buildQueue([guessed], TODAY, C);
    assert.equal(r.entries.length, 0);
    assert.equal(r.suppressed.length, 0);

    // The same customer with a MEASURED cycle IS held back, and the sentence
    // states the cycle because there it is a fact.
    const measured = candidate({ ...guessed, cycleIsDefault: false });
    assert.match(
      buildQueue([measured], TODAY, C).suppressed[0].reason,
      /every 16 days/,
    );
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
      reminders: [{ id: "r1", dueDate: TODAY, note: "Send the rate list", holdOtherReasonsUntilDue: false }],
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 1);
    assert.equal(r.suppressed.length, 0);
  });

  /* ------------------------------------------------------- the call day */

  test("the routine call lands at 70% of the customer's own cycle", () => {
    // 70% of 22 is 15.4, rounded to 15. The old rule worked backwards from
    // the due date with a capped lead and produced day 18 — later, and later
    // still the longer the cycle, which is the wrong way round.
    const on14 = candidate({
      lastOrderDate: addDays(TODAY, -14),
      cycleDays: 22,
    });
    const on15 = candidate({
      lastOrderDate: addDays(TODAY, -15),
      cycleDays: 22,
    });
    assert.equal(
      buildQueue([on14], TODAY, C).entries.length,
      0,
      "day 14: too early",
    );
    const called = buildQueue([on15], TODAY, C);
    assert.equal(called.entries.length, 1, "day 15: the stock check");
    assert.equal(called.entries[0].reasons[0].kind, "routineCall");
  });

  test("the routine call scales with the cycle, with no cap", () => {
    const called = (cycleDays: number, sinceOrder: number) =>
      buildQueue(
        [candidate({ lastOrderDate: addDays(TODAY, -sinceOrder), cycleDays })],
        TODAY,
        C,
      ).entries.length === 1;

    // 70% of 30 = 21.
    assert.equal(called(30, 20), false);
    assert.equal(called(30, 21), true);

    // 70% of 60 = 42, and NOT day 50. The old cap made the notice shorter the
    // longer the cycle — exactly where the estimate is loosest and the notice
    // should be longest.
    assert.equal(called(60, 41), false);
    assert.equal(called(60, 42), true);

    // 70% of 20 = 14, but nothing is chased inside the quiet window — which is
    // still the full fifteen days here, because this cycle is longer than it.
    assert.equal(called(20, 14), false);
    assert.equal(called(20, 15), true);
  });

  test("a two-day buyer is called on their two-day cycle", () => {
    // No floor under short cycles, in the queue or underneath it. The rule is
    // the one everybody else gets — quiet until the order is due, chased from
    // the day it is — and on a two-day cycle that means day 2.
    const at = (sinceOrder: number) =>
      buildQueue(
        [
          candidate({
            lastOrderDate: addDays(TODAY, -sinceOrder),
            cycleDays: 2,
            lastContactDate: addDays(TODAY, -sinceOrder),
          }),
        ],
        TODAY,
        C,
      );

    assert.equal(at(1).entries.length, 0, "day 1: they ordered yesterday");
    assert.equal(at(1).suppressed.length, 0, "and nothing is held back either");
    assert.equal(at(2).entries[0].reasons[0].kind, "orderDue", "day 2: due");
    assert.equal(at(3).entries.length, 1, "day 3: overdue, still on the list");
  });

  /* ------------------------------------------ what the call is worth */

  describe("ordering within a reason", () => {
    const due = (over: Partial<QueueCandidate>) =>
      candidate({
        lastOrderDate: addDays(TODAY, -30),
        cycleDays: 30,
        cycleIsDefault: false,
        lastContactDate: addDays(TODAY, -30),
        ...over,
      });

    test("a sales call is ordered by the order, not by money owed", () => {
      // Both are due to order today, so both carry the same reason and the
      // same weight. It used to be settled by who owed the most, which is a
      // collections answer given to a sales question — a telecaller working
      // top-down spent the morning in the wrong half of the book.
      const big = due({
        customerId: "big",
        typicalOrderPaise: 50_000_00,
        outstanding: 0,
      });
      const owing = due({
        customerId: "owing",
        typicalOrderPaise: 4_000_00,
        outstanding: 90_000_00,
      });

      const { entries } = buildQueue([owing, big], TODAY, C);
      assert.deepEqual(
        entries.map((e) => e.customerId),
        ["big", "owing"],
      );
    });

    test("a collections call is still ordered by the debt", () => {
      // The reason decides which question is asked. Chasing money is worth
      // the money.
      const small = candidate({
        customerId: "small-debt",
        outstanding: 10_000_00,
        typicalOrderPaise: 90_000_00,
        paymentCallDue: { daysOverdue: 20, totalOverdue: 10_000_00 },
      });
      const large = candidate({
        customerId: "large-debt",
        outstanding: 80_000_00,
        typicalOrderPaise: 1_000_00,
        paymentCallDue: { daysOverdue: 20, totalOverdue: 80_000_00 },
      });

      const { entries } = buildQueue([small, large], TODAY, C);
      assert.deepEqual(
        entries.map((e) => e.customerId),
        ["large-debt", "small-debt"],
      );
    });

    test("a shaky cycle discounts what the call is worth", () => {
      // One orders every 29, 30, 31 days; the other after 15, 45, 22, 60. The
      // average is the same and only one of them is really due today. A lakh
      // at a coin toss is worth less than sixty thousand like clockwork.
      const erratic = due({
        customerId: "erratic",
        typicalOrderPaise: 100_000_00,
        cycleConfidence: 40,
      });
      const reliable = due({
        customerId: "reliable",
        typicalOrderPaise: 60_000_00,
        cycleConfidence: 95,
      });

      const { entries } = buildQueue([erratic, reliable], TODAY, C);
      assert.deepEqual(
        entries.map((e) => e.customerId),
        ["reliable", "erratic"],
      );
      assert.equal(entries[0].callValue, 57_000_00);
      assert.equal(entries[1].callValue, 40_000_00);
    });

    test("no confidence figure yet means no discount", () => {
      // Every cycle computed before the confidence column existed carries
      // null, and they rebuild on the next nightly. Halving them meanwhile
      // would be a uniform penalty dressed up as a judgement — it would say
      // "we are unsure about this customer" when the truth is "we have not
      // looked yet".
      const c = due({
        typicalOrderPaise: 30_000_00,
        cycleConfidence: null,
      });
      const { entries } = buildQueue([c], TODAY, C);
      assert.equal(entries[0].callValue, 30_000_00);
    });

    test("a promise is a fact, so it is not discounted", () => {
      // Confidence describes a PREDICTION about when they will order. A
      // callback the customer asked for is not a prediction.
      const c = candidate({
        typicalOrderPaise: 20_000_00,
        cycleConfidence: 10,
        reminders: [{ id: "r1", dueDate: TODAY, note: "Call back", holdOtherReasonsUntilDue: false }],
      });
      const { entries } = buildQueue([c], TODAY, C);
      assert.equal(entries[0].callValue, 20_000_00);
    });

    test("the reason still outranks the value", () => {
      // A tiny promise beats a huge stock check. Value orders WITHIN a
      // reason; it never crosses one.
      const promise = candidate({
        customerId: "promise",
        typicalOrderPaise: 1_00,
        reminders: [{ id: "r1", dueDate: TODAY, note: "Call back", holdOtherReasonsUntilDue: false }],
      });
      const huge = candidate({
        customerId: "huge",
        lastOrderDate: addDays(TODAY, -21),
        cycleDays: 30,
        cycleIsDefault: false,
        typicalOrderPaise: 500_000_00,
      });
      const { entries } = buildQueue([huge, promise], TODAY, C);
      assert.equal(entries[0].customerId, "promise");
    });
  });

  /* ------------------------------ confidence moves the stock-check day */

  describe("the stock check moves with how predictable the cycle is", () => {
    const at = (sinceOrder: number, cycleConfidence: number) =>
      buildQueue(
        [
          candidate({
            lastOrderDate: addDays(TODAY, -sinceOrder),
            lastContactDate: addDays(TODAY, -sinceOrder),
            cycleDays: 30,
            cycleIsDefault: false,
            cycleConfidence,
          }),
        ],
        TODAY,
        C,
      ).entries.length === 1;

    test("a regular customer is called later, closer to the real date", () => {
      // 70% + the full swing = 80% of 30 days = day 24, six days before the
      // order is due rather than nine. The date is worth trusting, so the
      // call is worth placing near it.
      assert.equal(at(23, 100), false);
      assert.equal(at(24, 100), true);
    });

    test("an erratic customer is called earlier, because the date is a guess", () => {
      // 70% - the full swing = 60% of 30 = day 18. The honest answer to a
      // guess is a wider net: the real order could come either side of it.
      assert.equal(at(17, 0), false);
      assert.equal(at(18, 0), true);
    });

    test("a middling customer is exactly where the flat percentage put them", () => {
      // 50 is neutral, so nothing moved for anybody average.
      assert.equal(at(20, 50), false);
      assert.equal(at(21, 50), true);
    });

    test("turning the swing off restores one day for everybody", () => {
      const flat = { ...C, "queue.routineConfidenceSwing": 0 };
      const day = (cycleConfidence: number) =>
        buildQueue(
          [
            candidate({
              lastOrderDate: addDays(TODAY, -21),
              lastContactDate: addDays(TODAY, -21),
              cycleDays: 30,
              cycleIsDefault: false,
              cycleConfidence,
            }),
          ],
          TODAY,
          flat,
        ).entries.length;
      assert.equal(day(0), 1);
      assert.equal(day(100), 1);
    });

    test("a short cycle still gets no stock check, however predictable", () => {
      // The swing moves the day; it never creates a call that the cycle
      // length says should not exist.
      const r = buildQueue(
        [
          candidate({
            lastOrderDate: addDays(TODAY, -6),
            lastContactDate: addDays(TODAY, -6),
            cycleDays: 8,
            cycleIsDefault: false,
            cycleConfidence: 100,
          }),
        ],
        TODAY,
        C,
      );
      assert.equal(r.entries.length, 0);
    });
  });

  test("a customer who buys every fortnight gets no routine call", () => {
    // The stock check asks what is left on the shelf, and somebody buying every
    // fortnight knows. Their first reason is the due date, not a call before it
    // — and the due date is not delayed, which is the rest of the rule.
    const short = (sinceOrder: number) =>
      buildQueue(
        [candidate({ lastOrderDate: addDays(TODAY, -sinceOrder), cycleDays: 15 })],
        TODAY,
        C,
      );

    assert.equal(short(11).entries.length, 0, "no early stock check");
    const due = short(15);
    assert.equal(due.entries.length, 1, "the order itself is due");
    assert.equal(due.entries[0].reasons[0].kind, "orderDue");
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
      lastAnsweredOutcome: "no_order",
      lastAnsweredDate: addDays(TODAY, -1),
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 0);
    // Five days, less the one already elapsed.
    assert.match(r.suppressed[0].reason, /asking again in 4 days/);
  });

  test("a customer long past their cycle is called, not held back", () => {
    // Once the Inactive Watch went, this customer had nowhere else to be
    // worked from — so the queue is where they are worked. They arrive as the
    // most overdue reason there is, which is the point: the alternative was a
    // list nobody opened.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -200),
      cycleDays: 22,
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries.length, 1);
    assert.equal(r.suppressed.length, 0);
  });

  test("the no-order cooldown expires", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      lastAnsweredOutcome: "no_order",
      lastAnsweredDate: addDays(TODAY, -C["queue.outcomeCooldownDays"].no_order),
    });
    assert.equal(buildQueue([c], TODAY, C).entries.length, 1);
  });

  test("a reminder overrides the no-order cooldown too", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      lastAnsweredOutcome: "no_order",
      lastAnsweredDate: addDays(TODAY, -1),
      reminders: [{ id: "r1", dueDate: TODAY, note: "They said call today", holdOtherReasonsUntilDue: false }],
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
      reminders: [{ id: "r", dueDate: addDays(TODAY, -1), note: "n", holdOtherReasonsUntilDue: false }],
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
    assert.equal(at(29), 2);
    assert.equal(at(30), 3, "stage 3 begins exactly at its threshold");
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

  test("a few days past the due date is not late — the grace period covers it", () => {
    const grace = C["escalation.slowPayerGraceDays"];
    // The last forgiven day, however many times it happens.
    const justInside = {
      dueDate: "2026-07-01",
      paidOn: addDays("2026-07-01", grace),
    };
    assert.equal(isSlowPayer([justInside], TODAY, C).latePayments, 0);
    assert.equal(
      isSlowPayer([justInside, justInside, justInside, justInside], TODAY, C)
        .slowPayer,
      false,
      "a customer who is always a few days late is not a slow payer",
    );

    // The first day that counts.
    const justOutside = {
      dueDate: "2026-07-01",
      paidOn: addDays("2026-07-01", grace + 1),
    };
    assert.equal(isSlowPayer([justOutside], TODAY, C).latePayments, 1);
  });

  test("grace forgives the due date, never the count", () => {
    // A fortnight late, three times over, is still a slow payer.
    const properlyLate = { dueDate: "2026-07-01", paidOn: "2026-07-15" };
    assert.equal(
      isSlowPayer([properlyLate, properlyLate, properlyLate], TODAY, C).slowPayer,
      true,
    );
  });

  test("with no grace configured, a single day late counts again", () => {
    const none = { ...C, "escalation.slowPayerGraceDays": 0 };
    const oneDay = { dueDate: "2026-07-01", paidOn: "2026-07-02" };
    assert.equal(isSlowPayer([oneDay], TODAY, none).latePayments, 1);
    assert.equal(isSlowPayer([oneDay], TODAY, C).latePayments, 0);
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
    reportedPayment: null,
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

  test("a reported payment stops the chasing without clearing the debt", () => {
    const plan = planPaymentFollowUps(
      [
        subject({
          anchorDueDate: addDays(TODAY, -40),
          reportedPayment: { amount: 250_000, on: TODAY, held: false, holdReason: null, postDatedTo: null },
        }),
      ],
      TODAY,
      C,
    );
    assert.equal(plan.calls.length, 0);
    assert.equal(plan.messages.length, 0);
    assert.match(plan.heldBack[0].reason, /₹2,500 reported paid today/);
    assert.match(plan.heldBack[0].reason, /waiting for accounts/);
  });

  test("the quiet a reported payment buys expires, and the customer comes back", () => {
    const overdue = { anchorDueDate: addDays(TODAY, -40) };
    const inside = planPaymentFollowUps(
      [
        subject({
          ...overdue,
          reportedPayment: {
            amount: 250_000,
            on: addDays(TODAY, -C["payments.reportedQuietDays"]),
            held: false,
            holdReason: null,
            postDatedTo: null,
          },
        }),
      ],
      TODAY,
      C,
    );
    assert.equal(inside.calls.length, 0, "still quiet on the last day of the window");

    const expired = planPaymentFollowUps(
      [
        subject({
          ...overdue,
          reportedPayment: {
            amount: 250_000,
            on: addDays(TODAY, -C["payments.reportedQuietDays"] - 1),
            held: false,
            holdReason: null,
            postDatedTo: null,
          },
        }),
      ],
      TODAY,
      C,
    );
    assert.equal(expired.calls.length, 1, "a day later they are chased again");
  });

  test("a post-dated cheque buys quiet until it can be banked, not three days", () => {
    // The reported window is a few days and a cheque can be dated a month out.
    // Measured from when it was written down, the quiet lapses long before the
    // cheque can even be reached, and the customer is chased for money sitting
    // in our own drawer — a call where they are entirely right.
    const plan = planPaymentFollowUps(
      [
        subject({
          anchorDueDate: addDays(TODAY, -40),
          reportedPayment: {
            amount: 250_000,
            // Written down three weeks ago: long past the reported window.
            on: addDays(TODAY, -21),
            held: false,
            holdReason: null,
            postDatedTo: addDays(TODAY, 10),
          },
        }),
      ],
      TODAY,
      C,
    );

    assert.equal(plan.calls.length, 0, "a customer with a post-dated cheque was chased");
    assert.equal(plan.messages.length, 0, "and sent a reminder message");
    assert.match(plan.heldBack[0].reason, /cheque dated/i);
  });

  test("once the cheque date passes, the ordinary window runs from THERE", () => {
    // The cheque can be banked now, so the few days the money needs to clear
    // start from its date — not from the day somebody wrote it down, which may
    // be a month earlier and would put the customer straight back on the list.
    const justBankable = planPaymentFollowUps(
      [
        subject({
          anchorDueDate: addDays(TODAY, -40),
          reportedPayment: {
            amount: 250_000,
            on: addDays(TODAY, -30),
            held: false,
            holdReason: null,
            postDatedTo: TODAY,
          },
        }),
      ],
      TODAY,
      C,
    );
    assert.equal(justBankable.calls.length, 0, "chased on the very day it became bankable");

    const longPast = planPaymentFollowUps(
      [
        subject({
          anchorDueDate: addDays(TODAY, -40),
          reportedPayment: {
            amount: 250_000,
            on: addDays(TODAY, -30),
            held: false,
            holdReason: null,
            postDatedTo: addDays(TODAY, -C["payments.reportedQuietDays"] - 1),
          },
        }),
      ],
      TODAY,
      C,
    );
    assert.equal(
      longPast.calls.length,
      1,
      "a cheque that should have cleared days ago left the customer off the list for ever",
    );
  });

  test("a hold outlasts a cheque date, because a person put it there", () => {
    const plan = planPaymentFollowUps(
      [
        subject({
          anchorDueDate: addDays(TODAY, -40),
          reportedPayment: {
            amount: 250_000,
            on: addDays(TODAY, -60),
            held: true,
            holdReason: "Cheque sent for clearing",
            postDatedTo: addDays(TODAY, -30),
          },
        }),
      ],
      TODAY,
      C,
    );
    assert.equal(plan.calls.length, 0);
    assert.match(plan.heldBack[0].reason, /on hold/i);
  });

  test("reported money outranks a promise, because it is the better news", () => {
    const plan = planPaymentFollowUps(
      [
        subject({
          anchorDueDate: addDays(TODAY, -40),
          promisedDate: TODAY,
          reportedPayment: { amount: 100_000, on: TODAY, held: false, holdReason: null, postDatedTo: null },
        }),
      ],
      TODAY,
      C,
    );
    assert.match(plan.heldBack[0].reason, /reported paid/);
  });

  test("do-not-contact still wins over money somebody says they sent", () => {
    const plan = planPaymentFollowUps(
      [
        subject({
          anchorDueDate: addDays(TODAY, -40),
          doNotContact: true,
          reportedPayment: { amount: 100_000, on: TODAY, held: false, holdReason: null, postDatedTo: null },
        }),
      ],
      TODAY,
      C,
    );
    assert.match(plan.heldBack[0].reason, /do not contact/i);
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

/* ========================================================= the job runner */

describe("job runner arguments", () => {
  test("a switch that was typed is a switch that arrives", () => {
    // The bug: `--bills` was accepted by argv, discarded before runJob, and
    // the run then reported "bills skipped" — so the flag looked like an
    // answer about the data rather than an option that never arrived.
    const r = parseJobArgs(["project-sheet", "--owner=vikram@mahek.in", "--bills"]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.options, { owner: "vikram@mahek.in", bills: true });
  });

  test("a job on its own carries no options", () => {
    const r = parseJobArgs(["nightly"]);
    assert.deepEqual(r.ok && r.options, {});
  });

  test("--dry-run arrives as dryRun", () => {
    // The hyphen is the whole point of the test: the flag is typed one way and
    // read another, and a switch that parses but sets nothing would let a
    // destructive job run for real while its output said "dry run".
    const r = parseJobArgs(["revert-sheet-paid", "--dry-run"]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.options, { dryRun: true });
  });

  test("--dryRun is refused rather than guessed at", () => {
    // One spelling, and it is the one in the usage text. Accepting both would
    // make the usage text a suggestion.
    const r = parseJobArgs(["revert-sheet-paid", "--dryRun"]);
    assert.equal(r.ok, false);
  });

  test("--dry-run given a value is refused", () => {
    const r = parseJobArgs(["revert-sheet-paid", "--dry-run=yes"]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : (r.problem ?? ""), /switch/);
  });

  test("a misspelt option is refused, never ignored", () => {
    // Ignoring it is how somebody concludes the import cannot write bills.
    const r = parseJobArgs(["project-sheet", "--bils"]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : (r.problem ?? ""), /--bils/);
  });

  test("--owner with nothing after it is refused", () => {
    // Empty would read as "assign to nobody", which puts an imported book in
    // no telecaller's scope and every screen stays empty.
    const r = parseJobArgs(["project-sheet", "--owner"]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : (r.problem ?? ""), /needs a value/);
  });

  test("a switch given a value is refused rather than guessed at", () => {
    // --bills=false must not read as true, which is what a bare presence
    // check would do.
    const r = parseJobArgs(["project-sheet", "--bills=false"]);
    assert.equal(r.ok, false);
  });

  test("no job at all asks for the usage", () => {
    assert.deepEqual(parseJobArgs([]), { ok: false, problem: null });
  });
});

/* ======================================================= the financial year */

describe("financial years", () => {
  test("April opens a new year and March still belongs to the old one", () => {
    assert.equal(financialYearOf("2026-04-01"), "26-27");
    assert.equal(financialYearOf("2027-03-31"), "26-27");
    assert.equal(financialYearOf("2027-04-01"), "27-28");
  });

  test("the range ends exclusively, so 31 March is inside it", () => {
    // An inclusive end is how the last trading day of the year goes missing.
    const r = financialYearRange("26-27");
    assert.deepEqual(r, { start: "2026-04-01", end: "2027-04-01" });
    assert.ok("2027-03-31" >= r.start && "2027-03-31" < r.end);
  });

  test("the years offered run from the oldest record to today, newest first", () => {
    assert.deepEqual(financialYearsBetween("2024-06-01", "2026-08-09"), [
      "26-27",
      "25-26",
      "24-25",
    ]);
  });

  test("with no records at all, this year is still offered", () => {
    // 1 April, nothing billed yet, and the filter must not be empty.
    assert.deepEqual(financialYearsBetween(null, "2026-04-01"), ["26-27"]);
  });
});

/* ====================================================== Tally receivables */

const RECEIVABLES = [
  '" "," ","A TO Z ENTERPRISES"," "," "',
  '"Date","Ref. No.","Pending Amount","Due on","OverDue by days"',
  '"22 Jan 26","MMI/25-26/3209","5210","23 Jan 26","198"',
  '" "," Total","5210"," "," "',
  '" "," "," "," "," "',
  '" "," ","AADINATH PAINTS"," "," "',
  '"Date","Ref. No.","Pending Amount","Due on","OverDue by days"',
  '" ","On Account","-1222"," "," "',
  '"30 Jul 26","MMI/26-27/1047","19051","29 Aug 26"," "',
  '" "," Total","17829"," "," "',
].join("\n");

describe("Tally's receivables report", () => {
  test("a customer heading names the rows beneath it", () => {
    const { rows } = parseReceivables(RECEIVABLES);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].customer, "A TO Z ENTERPRISES");
    assert.equal(rows[1].customer, "AADINATH PAINTS");
  });

  test("the reference is the bill number, and money is paise", () => {
    const { rows } = parseReceivables(RECEIVABLES);
    assert.equal(rows[0].reference, "MMI/25-26/3209");
    assert.equal(rows[0].pendingPaise, 5210_00);
    assert.equal(rows[0].dueDate, "2026-01-23");
    assert.equal(rows[0].billDate, "2026-01-22");
  });

  test("money against no bill is a credit, never an amount owed", () => {
    // "On Account" is money in hand that names no bill. Applying it would
    // mark a real debt settled on a guess.
    const { rows, credits } = parseReceivables(RECEIVABLES);
    assert.ok(!rows.some((r) => r.reference === "On Account"));
    assert.equal(credits.length, 1);
    assert.equal(credits[0].pendingPaise, -1222_00);
  });

  test("a negative against a reference is a credit too", () => {
    const { rows, credits } = parseReceivables(
      '" "," ","X"," "," "\n"04 Nov 25","009480441","-150"," "," "',
    );
    assert.equal(rows.length, 0);
    assert.equal(credits.length, 1);
  });

  test("two-digit years, and a total that is not a bill", () => {
    assert.equal(parseTallyDate("22 Jan 26"), "2026-01-22");
    assert.equal(parseTallyDate("5 Apr 2025"), "2025-04-05");
    assert.equal(parseTallyDate(""), null);
    assert.equal(parseAmountPaise("5,210.50"), 521050);
    assert.equal(parseAmountPaise("nonsense"), null);
  });

  test("an unreadable amount is reported, not treated as zero", () => {
    // Zero would read as "settled", which is the opposite of unknown.
    const { rows, problems } = parseReceivables(
      '" "," ","X"," "," "\n"22 Jan 26","MMI/25-26/1","abc","23 Jan 26"," "',
    );
    assert.equal(rows.length, 0);
    assert.equal(problems.length, 1);
  });
});

/* ---------------------------------------------------------------------------
 * The rules added for the client's Call Log specification.
 * ------------------------------------------------------------------------- */

describe("cycle confidence", () => {
  test("a regular customer scores high, an erratic one low", () => {
    // The same average, and only one of them is worth planning around.
    const steady = cycleConfidence([29, 30, 31, 30, 29]);
    const erratic = cycleConfidence([15, 45, 22, 60, 30]);
    assert.ok(steady !== null && steady >= 90, `steady scored ${steady}`);
    assert.ok(erratic !== null && erratic < 60, `erratic scored ${erratic}`);
    assert.equal(confidenceBand(steady), "high");
    assert.ok(["low", "very-low"].includes(confidenceBand(erratic)!));
  });

  test("it is RELATIVE, so the same wobble reads differently on two cycles", () => {
    // Three days of drift on a 30-day cycle is tight; on a 5-day cycle it is
    // chaos. An absolute spread would call them equally good.
    const long = cycleConfidence([27, 30, 33])!;
    const short = cycleConfidence([2, 5, 8])!;
    assert.ok(long > short, `long ${long} should beat short ${short}`);
  });

  test("a guessed cycle has no confidence to report", () => {
    const c = buyingCycle(["2026-01-01"], C);
    assert.equal(c.isDefault, true);
    assert.equal(c.confidence, null, "a guess must not be dressed as a measure");
    assert.equal(confidenceBand(null), null);
  });

  test("a measured cycle carries one", () => {
    const c = buyingCycle(
      ["2026-01-01", "2026-01-31", "2026-03-02", "2026-04-01"],
      C,
    );
    assert.equal(c.isDefault, false);
    assert.ok(c.confidence !== null && c.confidence > 80);
  });
});

describe("the no-answer ladder", () => {
  const at = (iso: string) => Date.parse(iso);

  test("the first retry is an hour later, not the next day", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      noAnswerCount: 1,
      lastNoAnswerAt: `${TODAY}T04:30:00Z`, // 10:00 IST
    });

    // 10:30 IST — half an hour later, too soon.
    const early = buildQueue([c], TODAY, C, at(`${TODAY}T05:00:00Z`));
    assert.equal(early.entries.length, 0);
    assert.match(early.suppressed[0].reason, /waiting before the next/);

    // 11:30 IST — an hour has passed.
    const due = buildQueue([c], TODAY, C, at(`${TODAY}T06:00:00Z`));
    assert.equal(due.entries.length, 1);
    assert.ok(due.entries[0].reasons.some((r) => r.kind === "noAnswerRetry"));
  });

  test("later rungs are counted in days", () => {
    const two = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      noAnswerCount: 2,
      lastNoAnswerAt: `${addDays(TODAY, -1)}T04:30:00Z`,
    });
    assert.equal(
      buildQueue([two], TODAY, C, at(`${TODAY}T06:00:00Z`)).entries.length,
      1,
      "attempt 3 is owed the next day",
    );

    const three = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      noAnswerCount: 3,
      lastNoAnswerAt: `${addDays(TODAY, -1)}T04:30:00Z`,
    });
    assert.equal(
      buildQueue([three], TODAY, C, at(`${TODAY}T06:00:00Z`)).entries.length,
      0,
      "attempt 4 waits three days, not one",
    );
  });

  test("the ladder ends, and a person decides", () => {
    const spent = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      noAnswerCount: 5,
      lastNoAnswerAt: `${addDays(TODAY, -9)}T04:30:00Z`,
    });
    const r = buildQueue([spent], TODAY, C, at(`${TODAY}T06:00:00Z`));
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].reasons[0].kind, "unreachable");
  });

  test("nobody answering does not move the purchase cycle", () => {
    // The predicted date comes from order history and nothing else. A run of
    // unanswered calls says something about the phone, not about the cycle.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -30),
      cycleDays: 22,
      noAnswerCount: 2,
      lastNoAnswerAt: `${addDays(TODAY, -1)}T04:30:00Z`,
    });
    const r = buildQueue([c], TODAY, C, at(`${TODAY}T06:00:00Z`));
    const order = r.entries[0].reasons.find((x) => x.kind !== "noAnswerRetry")!;
    assert.match(order.label, /overdue by 8 days/);
  });
});

describe("an order already placed", () => {
  test("suppresses the order call and shows its status instead", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      openOrderStatus: "waiting for accounts to approve",
      activeInOrderSystem: false,
    });
    const r = buildQueue([c], TODAY, C);
    const kinds = r.entries[0].reasons.map((x) => x.kind);
    assert.ok(kinds.includes("orderStatus"), "the status is shown");
    // It ranks below everything else: it is not a call asking for an order.
    assert.notEqual(r.entries[0].reasons[0].kind, "orderStatus");
  });
});

describe("payment calls on the call log", () => {
  test("money due outranks every order reason", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      paymentCallDue: { totalOverdue: 4_500_00, daysOverdue: 21 },
    });
    const r = buildQueue([c], TODAY, C);
    assert.equal(r.entries[0].reasons[0].kind, "paymentOverdue");
    assert.match(r.entries[0].reasons[0].label, /₹4,500/);
    // And it is ONE row for the customer, not two.
    assert.equal(r.entries.length, 1);
  });
});

describe("what the customer said buys the right quiet", () => {
  test("not interested buys a month, no order buys a week", () => {
    const make = (outcome: string, daysAgo: number) =>
      buildQueue(
        [
          candidate({
            lastOrderDate: addDays(TODAY, -40),
            cycleDays: 22,
            lastAnsweredOutcome: outcome,
            lastAnsweredDate: addDays(TODAY, -daysAgo),
          }),
        ],
        TODAY,
        C,
      ).entries.length;

    assert.equal(make("no_order", 4), 0, "still inside the wait");
    assert.equal(make("no_order", 5), 1, "the wait is up");
    assert.equal(make("not_interested", 20), 0, "still inside the month");
    assert.equal(make("not_interested", 30), 1, "the month is up");
  });

  test("an outcome nobody configured buys nothing", () => {
    // Silence in the configuration means no quiet, never an accidental month.
    const c = candidate({
      lastOrderDate: addDays(TODAY, -40),
      cycleDays: 22,
      lastAnsweredOutcome: "transport_follow_up",
      lastAnsweredDate: TODAY,
    });
    assert.equal(buildQueue([c], TODAY, C).entries.length, 1);
  });
});

/* ---------------------------------------------------------------------------
 * A date on a Call Log row is read mid-call, and "14 Apr" means this April.
 * ------------------------------------------------------------------------- */

describe("a date says which year, once it is not this one", () => {
  test("this year is bare; an older one carries its year", () => {
    assert.equal(shortDateWithYear("2026-04-14", "2026-08-20"), "14 Apr");
    assert.equal(shortDateWithYear("2025-04-14", "2026-08-20"), "14 Apr 2025");
    // The boundary is the year, not a count of days: the 31st of December is
    // last year on the 1st of January, however few hours separate them.
    assert.equal(shortDateWithYear("2025-12-31", "2026-01-01"), "31 Dec 2025");
    assert.equal(shortDateWithYear(null, "2026-08-20"), "-");
  });

  test("the overdue reason names a date a person can read", () => {
    // It interpolated the stored value, so a telecaller was read "expected
    // 2025-06-26" off the screen mid-call.
    const c = candidate({ lastOrderDate: addDays(TODAY, -100), cycleDays: 22 });
    const [reason] = buildQueue([c], TODAY, C).entries[0].reasons;
    assert.match(reason.label, /expected \d{1,2} [A-Z][a-z]{2}/);
    assert.doesNotMatch(reason.label, /\d{4}-\d{2}-\d{2}/, "an ISO date reached the screen");
  });
});

/* ---------------------------------------------------------------------------
 * The ranking, and the two ways it was wrong: a stored value that did not
 * mention half the reasons, and a lapsed customer outranking a live one.
 * ------------------------------------------------------------------------- */

describe("what gets called first", () => {
  test("a stored ranking missing a reason does not un-rank it", () => {
    /*
     * Production's `queue.tierWeights` held eight keys against the engine's
     * fourteen — no `paymentOverdue` at all. The weight came back undefined,
     * which does not throw: it made the score undefined and the comparator
     * NaN, so the calls about money were ordered arbitrarily and no screen
     * showed anything wrong.
     */
    const partial = {
      ...C,
      "queue.tierWeights": {
        orderDue: 70,
        orderOverdueFullCycle: 80,
      } as unknown as (typeof C)["queue.tierWeights"],
    };

    const owes = candidate({
      customerId: "owes",
      outstanding: 32_071_00,
      paymentCallDue: { totalOverdue: 32_071_00, daysOverdue: 314 },
    });
    const due = candidate({
      customerId: "due",
      lastOrderDate: addDays(TODAY, -23),
      cycleDays: 22,
    });

    const { entries } = buildQueue([due, owes], TODAY, partial);
    assert.ok(
      entries.every((e) => Number.isFinite(e.score)),
      "a reason the stored ranking never mentioned produced a score that is not a number",
    );
    assert.equal(entries[0].customerId, "owes", "money did not come first");
  });

  test("somebody who stopped is worked after somebody merely due", () => {
    const due = candidate({
      customerId: "due",
      lastOrderDate: addDays(TODAY, -30),
      cycleDays: 22,
    });
    // Well past `inactive.cycleMultiplier` cycles — the same threshold that
    // earns the Inactive badge, so the badge and the rank agree.
    const gone = candidate({
      customerId: "gone",
      lastOrderDate: addDays(TODAY, -220),
      cycleDays: 22,
    });

    const { entries } = buildQueue([gone, due], TODAY, C);
    assert.equal(entries[0].customerId, "due");
    assert.equal(entries[1].customerId, "gone");
    assert.equal(entries[1].reasons[0].kind, "orderLongOverdue");
    assert.match(entries[1].reasons[0].label, /Gone quiet/);
  });

  test("the lapse line is the one the Inactive badge uses, not a cycle later", () => {
    // Measured from the last ORDER, exactly as `evaluateInactivity` measures
    // it. Read from the expected date instead and the two would sit a whole
    // cycle apart — a customer badged Inactive while ranked as a live chase.
    const cycleDays = 22;
    const atTheLine = candidate({
      customerId: "at",
      lastOrderDate: addDays(TODAY, -44), // 2 x 22, the default multiple
      cycleDays,
    });
    assert.equal(
      buildQueue([atTheLine], TODAY, C).entries[0].reasons[0].kind,
      "orderLongOverdue",
    );

    // Raise the multiple and a band opens: late enough to have missed a full
    // cycle, not yet late enough to count as stopped. That is what the older
    // kind is for, and it still outranks a lapse.
    const patient = { ...C, "inactive.cycleMultiplier": 3 };
    const [reason] = buildQueue([atTheLine], TODAY, patient).entries[0].reasons;
    assert.equal(reason.kind, "orderOverdueFullCycle");
    assert.ok(
      reason.weight > C["queue.tierWeights"].orderLongOverdue,
      "a customer one cycle late ranked no higher than one who stopped",
    );
  });

  test("a held reminder silences the order-due reason until its own date", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -32),
      cycleDays: 30,
      reminders: [
        {
          id: "rem_1",
          dueDate: addDays(TODAY, 3),
          note: "Call after stock confirmation",
          holdOtherReasonsUntilDue: true,
        },
      ],
    });

    const { entries, suppressed } = buildQueue([c], TODAY, C);
    assert.equal(entries.length, 0, "the order-due reason should be held");
    assert.equal(suppressed.length, 1);
    assert.match(suppressed[0].reason, /Holding other calls until/);
    assert.match(suppressed[0].reason, /Call after stock confirmation/);
  });

  test("on the reminder's own due date, the hold stops applying and it surfaces as booked", () => {
    const dueDate = addDays(TODAY, 3);
    const c = candidate({
      lastOrderDate: addDays(TODAY, -32),
      cycleDays: 30,
      reminders: [
        { id: "rem_1", dueDate, note: "Call after stock confirmation", holdOtherReasonsUntilDue: true },
      ],
    });

    const { entries } = buildQueue([c], dueDate, C);
    assert.equal(entries.length, 1, "the promise itself is the answer now");
    assert.equal(entries[0].reasons[0].kind, "reminderDueToday");
  });

  test("a held reminder does not silence an overdue payment", () => {
    const c = candidate({
      lastOrderDate: null,
      paymentCallDue: { totalOverdue: 5_000_00, daysOverdue: 10 },
      reminders: [
        {
          id: "rem_1",
          dueDate: addDays(TODAY, 3),
          note: "Call about the stock",
          holdOtherReasonsUntilDue: true,
        },
      ],
    });

    const { entries } = buildQueue([c], TODAY, C);
    assert.equal(entries.length, 1, "money owed is never held by a scheduling decision");
    assert.equal(entries[0].reasons[0].kind, "paymentOverdue");
  });

  test("a held reminder does not silence a customer who has gone quiet for good", () => {
    const c = candidate({
      lastOrderDate: addDays(TODAY, -220),
      cycleDays: 22,
      reminders: [
        {
          id: "rem_1",
          dueDate: addDays(TODAY, 3),
          note: "Call to check in",
          holdOtherReasonsUntilDue: true,
        },
      ],
    });

    const { entries } = buildQueue([c], TODAY, C);
    assert.equal(
      entries.length,
      1,
      "a churn signal this strong should not be silenced by an unrelated promise",
    );
    assert.equal(entries[0].reasons[0].kind, "orderLongOverdue");
  });
});

/* ---------------------------------------------------------------------------
 * A shop we deliver to buys from its distributor, not from us. Asking it for a
 * first order is asking for something it cannot give.
 * ------------------------------------------------------------------------- */

describe("a shop we only deliver to", () => {
  test("is never prospected", () => {
    const shop = candidate({
      customerId: "shop",
      lastOrderDate: null,
      lastContactDate: null,
      createdDate: addDays(TODAY, -60),
      thirdParty: true,
    });
    const r = buildQueue([shop], TODAY, C);
    assert.equal(r.entries.length, 0, "a delivered-to shop was put up for a first order");
  });

  test("an unmarked one still is — the mark is the only difference", () => {
    const same = candidate({
      customerId: "same",
      lastOrderDate: null,
      lastContactDate: null,
      createdDate: addDays(TODAY, -60),
      thirdParty: false,
    });
    const r = buildQueue([same], TODAY, C);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].reasons[0].kind, "prospect");
  });

  test("but a promise made to one is still kept", () => {
    // Only prospecting is suppressed. A callback somebody committed to is not
    // speculative work, and breaking it because of a classification would be
    // the worst kind of broken promise — one the customer never caused.
    const shop = candidate({
      customerId: "shop",
      lastOrderDate: null,
      thirdParty: true,
      reminders: [{ id: "r1", dueDate: TODAY, note: "Ring back about the damaged tin", holdOtherReasonsUntilDue: false }],
    });
    assert.equal(buildQueue([shop], TODAY, C).entries.length, 1);
  });

  test("and one that orders directly is chased on its own cycle", () => {
    // The mark corrects itself: nobody has to remember to lift it when a shop
    // starts buying from us, because the reason it is called changes from
    // "never ordered" to "their order is due".
    const buys = candidate({
      customerId: "buys",
      lastOrderDate: addDays(TODAY, -30),
      cycleDays: 22,
      cycleIsDefault: false,
      thirdParty: true,
    });
    const r = buildQueue([buys], TODAY, C);
    assert.equal(r.entries.length, 1, "a marked shop that buys directly was never called");
    assert.match(r.entries[0].reasons[0].kind, /order/i);
  });
});
