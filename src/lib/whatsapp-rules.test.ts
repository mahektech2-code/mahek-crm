/** The founder's automation rules: validation, the sentences, the window. Pure. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  checkTimes,
  describeRule,
  describeWindow,
  insideWindow,
  istNow,
  validateRule,
  validateWindow,
  type Rule,
} from "./whatsapp-rules";
import { ruleClock, type CustomerFacts } from "./wati-templates";

const rule = (over: Partial<Rule> = {}): Rule => ({
  kind: "payment", status: "off", fromDay: 1, toDay: 15, repeatEveryDays: 4, maxSends: null, minAmountPaise: null, priority: 40, ...over,
});
const WINDOW = { windowStartHour: 10, windowEndHour: 13, weekdays: [1, 2, 3, 4, 5, 6], dailyCap: 300 };
/** An instant at a given IST wall-clock time. 2026-09-28 is a Monday. */
const ist = (d: string, hm: string) => new Date(`${d}T${hm}:00+05:30`);

describe("the sending window — 10 am to 1 pm", () => {
  test("inside from 10:00 up to 12:59, Monday to Saturday", () => {
    assert.equal(insideWindow(WINDOW, ist("2026-09-28", "10:00")), true);
    assert.equal(insideWindow(WINDOW, ist("2026-09-28", "12:59")), true);
    assert.equal(insideWindow(WINDOW, ist("2026-10-03", "11:30")), true, "Saturday");
  });
  test("never at 1 pm or after, never before 10, never on Sunday", () => {
    assert.equal(insideWindow(WINDOW, ist("2026-09-28", "13:00")), false);
    assert.equal(insideWindow(WINDOW, ist("2026-09-28", "18:00")), false);
    assert.equal(insideWindow(WINDOW, ist("2026-09-28", "09:59")), false);
    assert.equal(insideWindow(WINDOW, ist("2026-10-04", "11:00")), false, "Sunday");
  });
  test("measured in India whatever the server's zone", () => {
    const n = istNow(new Date("2026-09-28T04:30:00Z"));
    assert.deepEqual([n.hour, n.minute, n.weekday, n.date], [10, 0, 1, "2026-09-28"]);
  });
  test("the checks it runs, and the words it is read back as", () => {
    assert.deepEqual(checkTimes(WINDOW), ["10:52", "11:52", "12:52"]);
    assert.equal(describeWindow(WINDOW), "Mon–Sat, between 10:00 am and 1:00 pm IST");
  });
  test("a window that ends before it starts, or with no days, is refused", () => {
    assert.ok(validateWindow({ ...WINDOW, windowStartHour: 13, windowEndHour: 10 }).length);
    assert.ok(validateWindow({ ...WINDOW, weekdays: [] }).length);
    assert.deepEqual(validateWindow(WINDOW), []);
  });
});

describe("a rule read back as a sentence", () => {
  test("payment rules", () => {
    assert.equal(describeRule(rule()), "Sent between 1 day overdue and 15 days overdue, every 4 days.");
    assert.equal(
      describeRule(rule({ fromDay: 30, toDay: null, repeatEveryDays: 7, maxSends: 3, minAmountPaise: 500_000 })),
      "Sent from 30 days overdue onwards, every 7 days, at most 3 times, only if at least ₹5,000 is overdue.",
    );
  });
  test("order rules, before and after the expected date", () => {
    assert.equal(
      describeRule(rule({ kind: "order", fromDay: -2, toDay: 0, repeatEveryDays: 30, maxSends: 1 })),
      "Sent between 2 days before the expected order date and on the expected order date, once.",
    );
  });
});

describe("what a rule may not be", () => {
  test("a payment rule before it is overdue, a range that ends first, a zero repeat", () => {
    assert.ok(validateRule(rule({ fromDay: 0 })).some((e) => /1 day overdue/.test(e)));
    assert.ok(validateRule(rule({ toDay: 0, fromDay: 5 })).some((e) => /end day/.test(e)));
    assert.ok(validateRule(rule({ repeatEveryDays: 0 })).length);
    assert.ok(validateRule(rule({ kind: "order", minAmountPaise: 100, fromDay: -1 })).some((e) => /payment rules/.test(e)));
    assert.deepEqual(validateRule(rule()), []);
  });
});

describe("the clock each rule counts on", () => {
  const base: CustomerFacts = {
    today: "2026-09-03",
    customer: { name: "X", kind: "customer", thirdParty: false, deactivated: false, doNotContact: false },
    openBills: [
      { billNo: "A", billDate: "2026-06-30", dueDate: "2026-07-30", balancePaise: 100, disputed: false },
      { billNo: "B", billDate: "2026-06-01", dueDate: "2026-07-01", balancePaise: 900, disputed: true },
    ],
    paymentClaimPending: false,
    lastOrder: { date: "2026-06-30", valuePaise: 1, products: ["P"] },
    orderPendingApproval: false,
    openInOrderSystem: false,
    cycle: { days: 28, measured: true },
  };
  test("payment: days past the oldest UNDISPUTED bill's due date, and what is overdue", () => {
    assert.deepEqual(ruleClock("payment", base), { day: 35, overduePaise: 100 });
  });
  test("order: days past the expected date; nothing without a measured cycle", () => {
    assert.equal(ruleClock("order", base)?.day, 37, "28 Jul -> 3 Sep");
    assert.equal(ruleClock("order", { ...base, cycle: { days: 30, measured: false } }), null);
  });
});
