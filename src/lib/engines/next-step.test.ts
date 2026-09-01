import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../config/registry";
import { addDays } from "../business-date";
import { nextStep } from "./next-step";
import type { QueueCandidate } from "./queue";

/* ============================================ E10 — what happens next
 *
 * Pure, so every case here is a plain function call. What these pin is not the
 * wording — that is allowed to improve — but the DATE and the KIND, because a
 * date read out to a customer on a phone call is the thing that has to be
 * right, and a prediction shown as a promise is the failure that matters.
 */

const C = defaultConfig();
const TODAY = "2026-08-03"; // a Monday
const NOW = Date.parse(`${TODAY}T11:00:00+05:30`);

function candidate(over: Partial<QueueCandidate> = {}): QueueCandidate {
  return {
    customerId: "c1",
    name: "Test Customer",
    ownerId: "u1",
    lastOrderDate: null,
    cycleDays: 30,
    cycleIsDefault: false,
    // A perfectly regular customer, matching the E2 fixture, so the confidence
    // swing does not move the dates these tests are about.
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

const ask = (c: QueueCandidate, paymentNextCallOn: string | null = null) =>
  nextStep({ candidate: c, paymentNextCallOn }, TODAY, C, NOW);

// `queue.includePaymentDue` defaults off, so a payment call must still be
// dated correctly for anywhere that reads the reason with it explicitly on.
const askWithPaymentDue = (c: QueueCandidate, paymentNextCallOn: string | null = null) =>
  nextStep(
    { candidate: c, paymentNextCallOn },
    TODAY,
    { ...C, "queue.includePaymentDue": true },
    NOW,
  );

describe("E10 next step", () => {
  test("a callback the customer asked for is BOOKED, on its own date", () => {
    const due = addDays(TODAY, 4);
    const step = ask(
      candidate({
        calledToday: true,
        // Ordered today, so nothing of their own competes for three weeks.
        lastOrderDate: TODAY,
        cycleDays: 30,
        reminders: [{ id: "r1", dueDate: due, note: "Ring back Friday" }],
      }),
    );

    assert.equal(step.kind, "booked");
    assert.equal(step.date, due);
    assert.equal(step.daysAway, 4);
  });

  test("a reminder falling on the same day as a stock check is BOOKED", () => {
    // Both are real and both are due. The one we promised the customer is what
    // the telecaller is told, because it is the one with a broken promise
    // behind it if it is missed.
    const due = addDays(TODAY, 1);
    const step = ask(
      candidate({
        calledToday: true,
        lastOrderDate: addDays(TODAY, -25), // past the day-21 stock check
        cycleDays: 30,
        reminders: [{ id: "r1", dueDate: due, note: "Ring back" }],
      }),
    );

    assert.equal(step.kind, "booked");
    assert.equal(step.date, due);
    assert.equal(step.reasonKind, "reminderDueToday");
  });

  test("an order taken today is quiet until the order is due, not before", () => {
    // The whole point of the quiet window: nobody is chased the morning after
    // they ordered, and nobody is held past their own due date either.
    const step = ask(
      candidate({
        calledToday: true,
        lastOrderDate: TODAY,
        cycleDays: 30,
        cycleIsDefault: false,
      }),
    );

    assert.equal(step.kind, "scheduled");
    // The stock check at 70% of a 30-day cycle — day 21.
    assert.equal(step.date, addDays(TODAY, 21));
    assert.equal(step.reasonKind, "routineCall");
  });

  test("a short-cycle customer gets no stock check, so the next call is the due date", () => {
    const step = ask(
      candidate({
        calledToday: true,
        lastOrderDate: TODAY,
        cycleDays: 7,
        cycleIsDefault: false,
      }),
    );

    assert.equal(step.date, addDays(TODAY, 7));
    assert.equal(step.reasonKind, "orderDue");
  });

  test("told no today, the next call waits out the cooldown", () => {
    const cooldown = C["queue.outcomeCooldownDays"].no_order;
    assert.ok(cooldown && cooldown > 0, "the fixture needs a no_order cooldown");

    const step = ask(
      candidate({
        calledToday: true,
        lastAnsweredOutcome: "no_order",
        lastAnsweredDate: TODAY,
        lastOrderDate: addDays(TODAY, -40),
        cycleDays: 30,
      }),
    );

    assert.equal(step.date, addDays(TODAY, cooldown));
    // And the screen can say why they are not on today's list.
    assert.ok(step.heldToday, "the held-back sentence is carried through");
  });

  test("the ladder spent is DECIDE, with no date at all", () => {
    // A date here would be a lie: nothing rings them again on its own.
    const step = ask(
      candidate({
        noAnswerCount: C["queue.noAnswerMaxAttempts"],
        lastNoAnswerAt: `${TODAY}T09:00:00+05:30`,
      }),
    );

    assert.equal(step.kind, "decide");
    assert.equal(step.date, null);
    assert.equal(step.daysAway, null);
  });

  test("do not contact is NONE, and says so rather than going quiet", () => {
    const step = ask(
      candidate({
        doNotContact: true,
        lastOrderDate: addDays(TODAY, -60),
        cycleDays: 30,
      }),
    );

    assert.equal(step.kind, "none");
    assert.equal(step.date, null);
    assert.match(step.detail, /do not contact/i);
  });

  test("an overdue payment is dated from the collections cadence, never tomorrow", () => {
    // `paymentCallDue` is a verdict about TODAY. Carried forward naively it
    // fires on every future day, so every customer with a debt would be told
    // "chase them tomorrow" for the rest of the year.
    const opens = addDays(TODAY, 3);
    const step = askWithPaymentDue(
      candidate({
        calledToday: true,
        paymentCallDue: { totalOverdue: 5_000_00, daysOverdue: 20 },
      }),
      opens,
    );

    assert.equal(step.date, opens);
    assert.equal(step.reasonKind, "paymentOverdue");
  });

  test("a customer already on today's list is answered as today, not deferred", () => {
    // Nothing was logged — the panel can be opened from a customer record —
    // so today is a real answer and must not be skipped over.
    const step = ask(
      candidate({
        calledToday: false,
        lastOrderDate: addDays(TODAY, -60),
        cycleDays: 30,
      }),
    );

    assert.equal(step.date, TODAY);
    assert.equal(step.daysAway, 0);
    assert.match(step.headline, /today/);
  });

  test("nothing inside the horizon answers NONE rather than an invented date", () => {
    const step = nextStep(
      { candidate: candidate({ calledToday: true }), paymentNextCallOn: null },
      TODAY,
      { ...C, "queue.prospectIntervalDays": 9999 },
      NOW,
      30,
    );

    assert.equal(step.kind, "none");
    assert.equal(step.date, null);
    assert.match(step.detail, /next 30 days/);
  });

  test("the date is a real business date, and the label names the weekday", () => {
    const step = ask(
      candidate({
        calledToday: true,
        lastOrderDate: TODAY,
        cycleDays: 30,
      }),
    );

    // 2026-08-24 is a Monday. A callback that lands on a Sunday is something a
    // telecaller has to be able to see without counting.
    assert.equal(step.date, "2026-08-24");
    assert.match(step.headline, /Mon 24 Aug/);
  });

  /*
   * The confirmation is a fixed form of words, and it names the screen.
   *
   * A telecaller reads this sixty times a day, so what makes it work is that
   * the first line is always the same shape — where they come back, and when.
   * A reason that quietly stopped saying "Call Log", or a headline that went
   * back to describing "your list", would be a screen nobody recognises at a
   * glance any more, and the reason is the only part worth reading twice.
   */
  test("every dated step confirms the Call Log by name, and says why underneath", () => {
    const cases: Array<[string, ReturnType<typeof candidate>]> = [
      ["due to reorder", candidate({ lastOrderDate: addDays(TODAY, -30), cycleDays: 30 })],
      ["a full cycle over", candidate({ lastOrderDate: addDays(TODAY, -90), cycleDays: 30 })],
      ["never ordered", candidate({ lastOrderDate: null })],
    ];

    for (const [what, c] of cases) {
      const step = ask(c);
      if (!step.date) continue;

      assert.match(
        step.headline,
        /^Comes back to your Call Log /,
        `${what}: the headline has to state the Call Log, not describe a list`,
      );
      // The reason is the second line, never folded into the first — a date
      // that reads as its own cause is the thing this shape exists to avoid.
      assert.ok(step.detail.includes(" — "), `${what}: no reason beside the action`);
      assert.doesNotMatch(step.headline, /because|due to reorder/i);
    }
  });

  test("a promised callback is still a Call Log date — the badge carries the promise", () => {
    const step = ask(
      candidate({
        reminders: [
          { id: "rem_1", dueDate: addDays(TODAY, 3), note: "asked for Thursday" },
        ],
      }),
    );

    assert.equal(step.kind, "booked");
    assert.match(step.headline, /^Comes back to your Call Log /);
    assert.match(step.detail, /Call them back/);
  });
});
