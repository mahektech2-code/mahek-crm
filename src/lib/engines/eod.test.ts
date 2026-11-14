import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateEod,
  eodPreflight,
  formatMoney,
  type EodExtras,
  type EodInput,
} from "./eod";

const TODAY = "2026-08-03"; // a Monday

const BASE_EXTRAS: EodExtras = { noOrderReasons: [], promises: [] };

const BASE_INPUT: EodInput = {
  userName: "Priya Sharma",
  date: TODAY,
  callsAttempted: 42,
  callsConnected: 31,
  callsInbound: 5,
  callsMissed: 11,
  callTarget: 0,
  queueWorked: 42,
  queueAssigned: 45,
  highPriorityTotal: 0,
  highPriorityCalled: 0,
  ordersCaptured: 6,
  ordersCount: 6,
  ordersValue: 18_450_000,
  ordersBoxes: 0,
  ordersCans: 0,
  noOrderCount: 0,
  followUpsMade: 12,
  promisesCount: 4,
  promisesValue: 6_200_000,
  paymentsConfirmed: 0,
  paymentCallsAssigned: 12,
  paymentWaSent: 0,
  paymentWaAssigned: 0,
  followUpAssigned: 12,
  followUpSent: 12,
  followUpPending: 0,
  remindersClosed: 8,
  remindersCreated: 5,
  remindersCarriedForward: 3,
  complaintsLogged: 1,
  whatsappSent: 9,
  ordersWithoutCall: 0,
  targetAchieved: 84_000_000,
  targetAmount: 120_000_000,
};

describe("E6 EOD aggregator", () => {
  test("money uses Indian digit grouping", () => {
    assert.equal(formatMoney(18_450_000), "₹1,84,500");
    assert.equal(formatMoney(120_000_000), "₹12,00,000");
    assert.equal(formatMoney(100_000), "₹1,000");
    assert.equal(formatMoney(0), "₹0");
  });

  test("the WhatsApp text matches the new template's grouping and emoji", () => {
    const r = aggregateEod(BASE_INPUT, BASE_EXTRAS);
    const lines = r.whatsappText.split("\n");
    assert.equal(lines[0], "*📊 EOD — Priya Sharma*");
    assert.equal(lines[1], "📅 Mon, 3 Aug, 2026");
    assert.equal(lines[2], "─".repeat(24));
    assert.equal(lines[3], "📞 Order Calls: *42 / 0*   ✅ Orders: *6*");
    assert.equal(lines[4], "   📦 0 Box  🥫 0 Can");
    assert.equal(lines[5], "📵 No Answer: 11");
    assert.equal(lines[6], "🚫 No Order: 0");
    assert.match(r.whatsappText, /💰 Payment Calls: \*12 \/ 12\*/);
    assert.match(r.whatsappText, /💬 Payment WA Sent: \*0 \/ 0\*/);
    assert.match(r.whatsappText, /📋 Assigned: \*45\*/);
    assert.match(r.whatsappText, /☎️ {2}Called: {3}\*42\* \(93%\)/);
    assert.match(r.whatsappText, /🤝 Pay Promised: \*4\*/);
    assert.match(r.whatsappText, /🎯 Month: \*70%\* \(₹8,40,000 \/ ₹12,00,000\)/);
    assert.match(r.whatsappText, /💸 Payment Follow-up: 12 assigned/);
    assert.match(r.whatsappText, /✅ Sent: 12 {2}·  ⏳ Pending: 0/);
  });

  test("the call target renders literally, including when it is 0/unset", () => {
    const unset = aggregateEod(BASE_INPUT, BASE_EXTRAS);
    assert.match(unset.whatsappText, /Order Calls: \*42 \/ 0\*/);

    const withTarget = aggregateEod({ ...BASE_INPUT, callTarget: 50 }, BASE_EXTRAS);
    assert.match(withTarget.whatsappText, /Order Calls: \*42 \/ 50\*/);
  });

  test("box and can totals appear on their own indented line", () => {
    const r = aggregateEod({ ...BASE_INPUT, ordersBoxes: 6, ordersCans: 18 }, BASE_EXTRAS);
    assert.match(r.whatsappText, /   📦 6 Box  🥫 18 Can/);
  });

  test("no-order reasons list every reason tallied, in the order given", () => {
    const r = aggregateEod(
      { ...BASE_INPUT, noOrderCount: 5 },
      { ...BASE_EXTRAS, noOrderReasons: [{ label: "Will order later", count: 4 }, { label: "Price issue", count: 1 }] },
    );
    assert.match(r.whatsappText, /🚫 No Order: 5 \(Will order later×4, Price issue×1\)/);
    assert.equal(r.lines.find((l) => l.label === "No order")?.value, "5 (Will order later×4, Price issue×1)");
  });

  test("a no-order count with no reason breakdown shows the count alone", () => {
    const r = aggregateEod({ ...BASE_INPUT, noOrderCount: 3 }, BASE_EXTRAS);
    assert.match(r.whatsappText, /🚫 No Order: 3$/m);
  });

  test("the promise list names each customer and their promised date", () => {
    const r = aggregateEod(
      { ...BASE_INPUT, promisesCount: 1 },
      { ...BASE_EXTRAS, promises: [{ customerName: "Amruteshwar Plywood And Hardware", date: "2026-06-23" }] },
    );
    assert.match(r.whatsappText, /🤝 Pay Promised: \*1\*/);
    assert.match(r.whatsappText, /   • Amruteshwar Plywood And Hardware → 23 Jun 26/);
  });

  test("all high priority customers called reads as a single confirming line", () => {
    const r = aggregateEod(
      { ...BASE_INPUT, highPriorityTotal: 3, highPriorityCalled: 3 },
      BASE_EXTRAS,
    );
    assert.match(r.whatsappText, /✅ All high priority customers called!/);
  });

  test("high priority customers still pending are counted, not just flagged", () => {
    const r = aggregateEod(
      { ...BASE_INPUT, highPriorityTotal: 5, highPriorityCalled: 2 },
      BASE_EXTRAS,
    );
    assert.match(r.whatsappText, /⚠️ 3 of 5 high priority customers still pending/);
  });

  test("no high priority customers today omits the line entirely", () => {
    const r = aggregateEod(
      { ...BASE_INPUT, highPriorityTotal: 0, highPriorityCalled: 0 },
      BASE_EXTRAS,
    );
    assert.ok(!r.whatsappText.includes("high priority"));
  });

  test("the payment follow-up rollup is always sent + pending = assigned", () => {
    const r = aggregateEod(
      { ...BASE_INPUT, followUpAssigned: 7, followUpSent: 3, followUpPending: 4 },
      BASE_EXTRAS,
    );
    assert.match(r.whatsappText, /💸 Payment Follow-up: 7 assigned/);
    assert.match(r.whatsappText, /✅ Sent: 3 {2}·  ⏳ Pending: 4/);
  });

  test("a day's work is not reported as nothing because accounts have not got to it", () => {
    // Three orders taken, one approved so far. The telecaller pastes this
    // into the team group as their record of the day.
    const r = aggregateEod(
      { ...BASE_INPUT, ordersCaptured: 3, ordersCount: 1, ordersValue: 40_000_00 },
      BASE_EXTRAS,
    );
    const orders = r.lines.find((l) => l.label === "Orders");
    assert.equal(orders?.value, "3 taken · 1 approved · ₹40,000");
  });

  test("a day where everything taken was approved reads as one number", () => {
    // The split is worth showing only when it means something.
    const r = aggregateEod({ ...BASE_INPUT, ordersCaptured: 6, ordersCount: 6 }, BASE_EXTRAS);
    assert.equal(r.lines.find((l) => l.label === "Orders")?.value, "6 · ₹1,84,500");
  });

  test("the queue figure is a count of work done, not a second progress bar", () => {
    // It used to read "x of y" with a y computed differently from the Call
    // Log's, so the two screens disagreed about the same day. The new "x of
    // y" line reads from queue_snapshots instead — see eod-service.ts.
    const r = aggregateEod({ ...BASE_INPUT, queueWorked: 4 }, BASE_EXTRAS);
    assert.equal(
      r.lines.find((l) => l.label === "Customers called from the queue")?.value,
      "4",
    );
  });

  test("the WhatsApp text contains nothing that renders badly", () => {
    const { whatsappText } = aggregateEod(BASE_INPUT, BASE_EXTRAS);
    assert.ok(!whatsappText.includes("|"), "no table pipes");
    assert.ok(!whatsappText.includes("\t"), "no tabs");
    assert.ok(!/^[-*+] /m.test(whatsappText), "no markdown-list bullets");
  });

  test("a zero-activity day still produces a report", () => {
    const zero = aggregateEod(
      {
        ...BASE_INPUT,
        callsAttempted: 0,
        callsConnected: 0,
        callsInbound: 0,
        callsMissed: 0,
        ordersWithoutCall: 0,
        ordersCaptured: 0,
        ordersCount: 0,
        ordersValue: 0,
        queueWorked: 0,
        queueAssigned: 0,
        targetAchieved: 0,
      },
      BASE_EXTRAS,
    );
    assert.match(zero.whatsappText, /Order Calls: \*0 \/ 0\*/);
    assert.match(zero.whatsappText, /\(0%\)/);
    // No queue rows settled today: 0 of 0 reads as 0%, not NaN%.
    assert.match(zero.whatsappText, /Called: {3}\*0\* \(0%\)/);
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
