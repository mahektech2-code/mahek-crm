/**
 * The eight WhatsApp templates: every value they print, and every case in
 * which they must refuse rather than print something untrue. Pure — no DB.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  amountFormatter,
  billView,
  fillBody,
  manualText,
  messageDate,
  renderSpec,
  specFor,
  specKey,
  SPEC_KEYS,
  type BillFact,
  type CustomerFacts,
} from "./wati-templates";

const TODAY = "2026-09-03";

function bill(no: string, billDate: string, dueDate: string, rupees: number, extra: Partial<BillFact> = {}): BillFact {
  return { billNo: no, billDate, dueDate, balancePaise: Math.round(rupees * 100), disputed: false, ...extra };
}

function facts(over: Partial<CustomerFacts> = {}): CustomerFacts {
  return {
    today: TODAY,
    customer: { name: "Kwality Auto Paints", kind: "customer", thirdParty: false, deactivated: false, doNotContact: false },
    openBills: [
      bill("MMI/26-27/0802", "2026-06-30", "2026-07-30", 16424),
      bill("MMI/26-27/0911", "2026-07-12", "2026-08-11", 8200),
      bill("MMI/26-27/1003", "2026-08-25", "2026-09-24", 5000), // not due yet
    ],
    paymentClaimPending: false,
    lastOrder: { date: "2026-06-30", valuePaise: 4_850_000, products: ["Nano Thinner 20L", "PU Clear 4L"] },
    orderPendingApproval: false,
    openInOrderSystem: false,
    cycle: { days: 28, measured: true },
    ...over,
  };
}

const values = (key: string, f: CustomerFacts) => {
  const r = renderSpec(key, f);
  assert.equal(r.ok, true, r.ok ? "" : r.reasons.join(" | "));
  return Object.fromEntries((r as { params: Array<{ name: string; value: string }> }).params.map((p) => [p.name, p.value]));
};
const refused = (key: string, f: CustomerFacts, pattern: RegExp) => {
  const r = renderSpec(key, f);
  assert.equal(r.ok, false, `${key} should have been refused`);
  assert.ok((r as { reasons: string[] }).reasons.some((x) => pattern.test(x)), (r as { reasons: string[] }).reasons.join(" | "));
};

/* ------------------------------------------------------------ formatting */

describe("formatting", () => {
  test("dates read like the statement the accounts team sends", () => {
    assert.equal(messageDate("2026-06-30"), "30 Jun 2026");
    assert.equal(messageDate("2026-09-03"), "03 Sep 2026");
    assert.equal(messageDate("30/06/2026"), null);
    assert.equal(messageDate(null), null);
  });

  test("amounts use Indian grouping, and paise only when any amount has them", () => {
    assert.equal(amountFormatter([1_642_400])(1_642_400), "16,424");
    assert.equal(amountFormatter([12_345_678_900])(12_345_678_900), "12,34,56,789");
    const withPaise = amountFormatter([1_642_450, 820_000]);
    assert.equal(withPaise(1_642_450), "16,424.50");
    assert.equal(withPaise(820_000), "8,200.00", "one precision for the whole message");
  });

  test("a bill list is one line, oldest first, capped, and the total covers every bill", () => {
    const bills = [6, 1, 4, 2, 5, 3].map((n) => bill(`B${n}`, `2026-0${n}-01`, `2026-0${n}-15`, 1000 * n));
    const v = billView(bills);
    assert.ok(!v.list.includes("\n"));
    assert.ok(v.list.startsWith("01 Jan 2026 – B1 – ₹1,000"), v.list);
    assert.ok(v.list.endsWith("| + 1 more bill"), v.list);
    assert.equal(v.totalPaise, 21_000_00, "the sixth bill is not listed but is counted");
  });
});

/* ------------------------------------------------------------- payments */

describe("payment templates", () => {
  test("follow-up lists only OVERDUE bills, and its total is those bills", () => {
    const v = values("payment_followup_1", facts());
    assert.equal(v.customer_name, "Kwality Auto Paints");
    assert.equal(v.as_of_date, "03 Sep 2026");
    assert.equal(v.bills_list, "30 Jun 2026 – MMI/26-27/0802 – ₹16,424 | 12 Jul 2026 – MMI/26-27/0911 – ₹8,200");
    assert.equal(v.total_overdue, "24,624", "the not-yet-due bill is neither listed nor added");
  });

  test("the statement lists every open bill, due or not, and totals the same rows", () => {
    const v = values("payment_statement", facts());
    assert.match(v.bills_list, /MMI\/26-27\/1003/);
    assert.equal(v.total_due, "29,624");
  });

  test("oldest days overdue is counted from the oldest bill's DUE date", () => {
    const v = values("payment_followup_urgent", facts());
    assert.equal(v.oldest_overdue_days, "35", "30 Jul -> 3 Sep");
    assert.equal(values("payment_credit_hold", facts()).oldest_overdue_days, "35");
  });

  test("nothing overdue: every payment template refuses, the statement included", () => {
    const f = facts({ openBills: [bill("X1", "2026-08-25", "2026-09-24", 5000)] });
    for (const k of ["payment_followup_1", "payment_statement", "payment_followup_urgent", "payment_credit_hold"]) {
      refused(k, f, /No bill is overdue/);
    }
  });

  test("a disputed bill is never chased, and if it is the only one, nothing goes", () => {
    const f = facts({ openBills: [bill("D1", "2026-06-01", "2026-07-01", 9999, { disputed: true }), bill("OK", "2026-07-01", "2026-08-01", 100)] });
    assert.doesNotMatch(values("payment_followup_1", f).bills_list, /D1/);
    assert.equal(values("payment_followup_1", f).total_overdue, "100");
    refused("payment_followup_1", facts({ openBills: [bill("D1", "2026-06-01", "2026-07-01", 9999, { disputed: true })] }), /disputed/);
  });

  test("a customer who reported a payment is not asked to pay", () => {
    refused("payment_followup_1", facts({ paymentClaimPending: true }), /reported a payment/);
  });

  test("do not contact, deactivated and a missing name all refuse", () => {
    refused("payment_followup_1", facts({ customer: { ...facts().customer, doNotContact: true } }), /do not contact/);
    refused("payment_followup_1", facts({ customer: { ...facts().customer, deactivated: true } }), /deactivated/);
    refused("payment_followup_1", facts({ customer: { ...facts().customer, name: " " } }), /no name/);
  });
});

/* --------------------------------------------------------------- orders */

describe("order templates", () => {
  // Last order 30 Jun + 28 days = expected 28 Jul; today 3 Sep = 65 days since.
  test("follow-ups after the expected date carry the cycle, the dates and the products", () => {
    const v = values("order_followup_due_passed", facts());
    assert.deepEqual(v, {
      customer_name: "Kwality Auto Paints",
      cycle_days: "28",
      expected_order_date: "28 Jul 2026",
      last_order_date: "30 Jun 2026",
      days_since_last_order: "65",
      last_products: "Nano Thinner 20L, PU Clear 4L",
    });
    assert.equal(values("customer_followup_gap", facts()).last_order_value, "48,500");
  });

  test("the reminder says the order IS due — so only before the expected date", () => {
    const early = facts({ lastOrder: { ...facts().lastOrder!, date: "2026-08-20" } }); // expected 17 Sep
    assert.equal(values("order_reminder_due", early).expected_order_date, "17 Sep 2026");
    refused("order_reminder_due", facts(), /already passed/);
  });

  test("the follow-ups say the order is LATE — so never before the expected date", () => {
    const early = facts({ lastOrder: { ...facts().lastOrder!, date: "2026-08-20" } });
    for (const k of ["order_followup_due_passed", "order_followup_cycle_exceeded", "customer_followup_gap"]) {
      refused(k, early, /has not passed yet/);
    }
  });

  test("a default (unmeasured) cycle is never quoted to a customer", () => {
    for (const k of ["order_reminder_due", "order_followup_due_passed", "order_followup_cycle_exceeded", "customer_followup_gap"]) {
      refused(k, facts({ cycle: { days: 30, measured: false } }), /not been measured/);
    }
  });

  test("somebody who has already ordered is not chased for an order", () => {
    refused("order_followup_due_passed", facts({ orderPendingApproval: true }), /waiting for approval/);
    refused("order_followup_due_passed", facts({ openInOrderSystem: true }), /Taken Order sheet/);
  });

  test("leads, third-party shops and orders with nothing on them are refused", () => {
    refused("order_followup_due_passed", facts({ customer: { ...facts().customer, kind: "lead" } }), /lead/);
    refused("order_followup_due_passed", facts({ customer: { ...facts().customer, thirdParty: true } }), /third-party/);
    refused("order_followup_due_passed", facts({ lastOrder: null }), /no approved order/);
    refused("order_followup_due_passed", facts({ lastOrder: { ...facts().lastOrder!, products: [] } }), /names no products/);
    refused("customer_followup_gap", facts({ lastOrder: { ...facts().lastOrder!, valuePaise: 0 } }), /no value/);
  });

  test("products are de-duplicated and capped at three", () => {
    const f = facts({ lastOrder: { ...facts().lastOrder!, products: ["A", "B", "A", "C", "D", "E"] } });
    assert.equal(values("order_followup_due_passed", f).last_products, "A, B, C + 2 more");
  });
});

/* ------------------------------------------------------------ the guards */

describe("guards", () => {
  test("a template edited in Wati to ask for a variable nobody fills is refused, not blanked", () => {
    const r = renderSpec("payment_followup_1", facts(), ["customer_name", "order_id"]);
    assert.equal(r.ok, false);
    assert.match((r as { reasons: string[] }).reasons[0], /order_id/);
  });

  test("a resubmitted version is the same message; an unknown template has no rules", () => {
    assert.equal(specKey("payment_followup_1_v2"), "payment_followup_1");
    assert.equal(specKey("payment_followup_1_v17"), "payment_followup_1");
    assert.equal(specKey("some_other_template"), null);
    assert.equal(renderSpec("nope", facts()).ok, false);
  });

  test("no variable ever carries a line break", () => {
    const r = renderSpec("payment_statement", facts());
    assert.ok(r.ok);
    for (const p of (r as { params: Array<{ value: string }> }).params) assert.ok(!/[\n\t]/.test(p.value));
  });
});

/* ---------------------------- the bodies the migration puts in the CRM */

describe("the eight template bodies", () => {
  const sql = readFileSync(new URL("../../drizzle/0165_whatsapp_templates_follow_their_rules.sql", import.meta.url), "utf8");
  const rows = [...sql.matchAll(/'tpl_wati_(\w+)'.*?\$b\$([\s\S]*?)\$b\$/g)].map((m) => ({ key: m[1], body: m[2] }));

  test("there is one for every rule set", () => {
    assert.deepEqual(rows.map((r) => r.key).sort(), [...SPEC_KEYS].sort());
  });

  test("each body uses exactly the variables its rules fill", () => {
    for (const { key, body } of rows) {
      const used = [...new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();
      assert.deepEqual(used, [...specFor(key)!.params].sort(), key);
    }
  });

  test("filled, no placeholder survives; pasted by hand, no body mentions buttons", () => {
    for (const { key, body } of rows) {
      const f = key.startsWith("order_reminder") ? facts({ lastOrder: { ...facts().lastOrder!, date: "2026-08-20" } }) : facts();
      const r = renderSpec(key, f);
      assert.ok(r.ok, `${key}: ${r.ok ? "" : r.reasons.join(" | ")}`);
      const filled = fillBody(body, (r as { params: Array<{ name: string; value: string }> }).params);
      assert.ok(!filled.includes("{{"), key);
      const manual = manualText(filled);
      assert.ok(manual.ok, `${key}: ${manual.ok ? "" : manual.reason}`);
      assert.doesNotMatch((manual as { text: string }).text, /\btap\b/i, key);
    }
  });
});
