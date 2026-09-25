/* ---------------------------------------------------------------------------
 * The eight Wati templates: what each one SAYS, and therefore what must be
 * true before it may be sent to a customer.
 *
 * PURE AND CLIENT-SAFE — no I/O. `wati-facts-service.ts` gathers the facts
 * from the database; this file decides, from those facts alone, either the
 * exact variable values or the list of reasons the message must not go. The
 * same function answers the preview, the manual copy, the API send and any
 * scheduled job, so no route can send something another would have refused.
 *
 * THE RULE THAT GOVERNS ALL OF IT: every variable is either a TRUE value or
 * the message is refused. Nothing is ever defaulted, blanked, rounded into a
 * different figure or filled with "N/A". A refused message costs one manual
 * follow-up; a wrong one costs the customer's trust in every message after it.
 *
 * WHAT EACH TEMPLATE ASSERTS, and so what it checks:
 *   payment_*   "these bills are overdue, this is the total"  → at least one
 *               overdue bill whose payment position somebody has stated, not
 *               disputed; the list and the total computed from the SAME rows;
 *               nobody has told us they already paid (a reported or held
 *               receipt), because "please pay" to a customer whose transfer
 *               accounts are checking is exactly the wrong message.
 *   order_*     "your usual cycle is N days, your last order was X"  → a
 *               MEASURED cycle (never the default 30), a real last order with
 *               products and a value, no order since, nothing open in the
 *               Taken Order sheet; and the tense has to be right — "is due
 *               around" only before the expected date, "was expected" only
 *               after it.
 *
 * TIMING IS NOT HERE. Which template goes on which day is Mahek's timeline,
 * and it belongs to the scheduler, not to the question "is this message true".
 * ------------------------------------------------------------------------- */

import { addDays, daysBetween, type BusinessDate } from "./business-date";

/* ------------------------------------------------------------------ facts */

export type BillFact = {
  billNo: string;
  billDate: BusinessDate;
  /** The due date collections uses — `effectiveDueDate`, credit terms applied. */
  dueDate: BusinessDate;
  /** What is still owed, in paise. Only bills with a balance are passed in. */
  balancePaise: number;
  disputed: boolean;
};

export type OrderFact = {
  date: BusinessDate;
  valuePaise: number;
  /** Product names on that order, in the order they were written. */
  products: string[];
};

export type CustomerFacts = {
  today: BusinessDate;
  customer: {
    name: string;
    kind: "customer" | "lead";
    thirdParty: boolean;
    deactivated: boolean;
    doNotContact: boolean;
  };
  /** Unpaid bills whose payment position is STATED. An unstated bill is never here. */
  openBills: BillFact[];
  /** A payment the customer reported, or accounts are holding, not yet decided. */
  paymentClaimPending: boolean;
  /** The newest order that counts as a sale. */
  lastOrder: OrderFact | null;
  /** An order captured and not yet approved or declined — they HAVE ordered. */
  orderPendingApproval: boolean;
  /** An open line on the Taken Order sheet (`active_in_order_system`). */
  openInOrderSystem: boolean;
  cycle: { days: number; measured: boolean };
};

/* ---------------------------------------------------------------- limits */

/** Bills written out in a message. The total always covers all of them. */
export const MAX_BILLS_LISTED = 5;
/** A bill list longer than this loses bills from the end, into "+ N more". */
const MAX_BILLS_CHARS = 600;
/** Product names written out. */
export const MAX_PRODUCTS_LISTED = 3;
/** Meta refuses a parameter above roughly a thousand characters. */
const MAX_PARAM_CHARS = 1000;

/* ------------------------------------------------------------ formatting */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-30" -> "30 Jun 2026". Null, never "-", for anything unreadable. */
export function messageDate(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(day).padStart(2, "0")} ${MONTHS[month - 1]} ${m[1]}`;
}

function groupIndian(whole: number): string {
  const s = String(whole);
  return s.length <= 3 ? s : s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + s.slice(-3);
}

/**
 * Amounts in one message share one precision. If any of them carries paise,
 * every one is written to two places — otherwise ₹16,424 + ₹8,200 could sit
 * above a total of ₹24,625 that is correct to the paisa and reads as an error.
 * Never rounded: the list and the total must add up on the customer's screen.
 */
export function amountFormatter(allPaise: number[]): (paise: number) => string {
  const decimals = allPaise.some((p) => p % 100 !== 0);
  return (paise) => {
    const whole = Math.floor(Math.abs(paise) / 100);
    const frac = Math.abs(paise) % 100;
    return groupIndian(whole) + (decimals ? `.${String(frac).padStart(2, "0")}` : "");
  };
}

/** No line breaks, tabs or long space runs — Meta refuses them inside a variable. */
function clean(v: string): string {
  return v.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/* -------------------------------------------------------------- results */

export type RenderResult =
  | { ok: true; params: Array<{ name: string; value: string }> }
  | { ok: false; reasons: string[] };

type Spec = {
  kind: "payment" | "order";
  label: string;
  /** The Wati variable names this template uses — must match Wati exactly. */
  params: readonly string[];
  build: (f: CustomerFacts) => Record<string, string> | string[];
};

/* ------------------------------------------------------ shared checks */

function commonRefusals(f: CustomerFacts): string[] {
  const r: string[] = [];
  if (!f.customer.name.trim()) r.push("The customer has no name on record.");
  if (f.customer.doNotContact) r.push("The customer is marked do not contact.");
  if (f.customer.deactivated) r.push("The account is deactivated.");
  return r;
}

type BillView = { list: string; count: number; totalPaise: number; listed: BillFact[] };

/** Oldest first, a capped list, and a total over EVERY bill in the set. */
export function billView(bills: BillFact[]): BillView {
  const sorted = [...bills].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.billDate.localeCompare(b.billDate) || a.billNo.localeCompare(b.billNo),
  );
  const fmt = amountFormatter(sorted.map((b) => b.balancePaise));
  const total = sorted.reduce((s, b) => s + b.balancePaise, 0);
  const entries = sorted.map((b) => `${messageDate(b.billDate)} – ${b.billNo} – ₹${fmt(b.balancePaise)}`);

  let shown = Math.min(entries.length, MAX_BILLS_LISTED);
  const render = (n: number) => {
    const more = entries.length - n;
    return entries.slice(0, n).join(" | ") + (more > 0 ? ` | + ${more} more bill${more === 1 ? "" : "s"}` : "");
  };
  while (shown > 1 && render(shown).length > MAX_BILLS_CHARS) shown--;
  return { list: render(shown), count: sorted.length, totalPaise: total, listed: sorted.slice(0, shown) };
}

type PaymentView = {
  overdue: BillFact[];
  open: BillFact[];
  refusals: string[];
};

function paymentView(f: CustomerFacts): PaymentView {
  const refusals = commonRefusals(f);
  const usable = f.openBills.filter((b) => b.balancePaise > 0 && !b.disputed);
  const overdue = usable.filter((b) => b.dueDate < f.today);
  for (const b of usable) {
    if (!messageDate(b.billDate)) refusals.push(`Bill ${b.billNo} has an unreadable bill date.`);
    if (!b.billNo.trim()) refusals.push("A bill has no bill number.");
  }
  if (f.paymentClaimPending) {
    refusals.push("The customer has reported a payment that accounts have not confirmed yet — asking them to pay now would be wrong.");
  }
  if (!overdue.length) {
    refusals.push(
      f.openBills.some((b) => b.disputed && b.dueDate < f.today)
        ? "Every overdue bill is disputed — a dispute is settled by a person, not chased by a message."
        : "No bill is overdue.",
    );
  }
  return { overdue, open: usable, refusals };
}

type OrderView = {
  refusals: string[];
  lastOrder: OrderFact;
  expected: BusinessDate;
  sinceDays: number;
};

function orderView(f: CustomerFacts): OrderView | string[] {
  const refusals = commonRefusals(f);
  if (f.customer.kind !== "customer") refusals.push("A lead has never ordered — there is no buying cycle to speak of.");
  if (f.customer.thirdParty) refusals.push("A third-party shop is billed by its distributor — order follow-ups go through them.");
  if (!f.cycle.measured) refusals.push("The buying cycle has not been measured yet (it is still the default), so it cannot be quoted to the customer.");
  if (f.cycle.days <= 0) refusals.push("The buying cycle is not a positive number of days.");
  if (f.orderPendingApproval) refusals.push("The customer has an order waiting for approval — they have already ordered.");
  if (f.openInOrderSystem) refusals.push("The customer has an open order on the Taken Order sheet — they have already ordered.");
  const o = f.lastOrder;
  if (!o) refusals.push("The customer has no approved order on record.");
  else {
    if (!messageDate(o.date)) refusals.push("The last order has an unreadable date.");
    if (o.valuePaise <= 0) refusals.push("The last order has no value recorded.");
    if (!o.products.some((p) => p.trim())) refusals.push("The last order names no products.");
    if (o.date > f.today) refusals.push("The last order is dated in the future.");
  }
  if (refusals.length || !o) return refusals;
  return {
    refusals,
    lastOrder: o,
    expected: addDays(o.date, f.cycle.days),
    sinceDays: daysBetween(o.date, f.today),
  };
}

function productsLine(products: string[]): string {
  const names = [...new Set(products.map((p) => clean(p)).filter(Boolean))];
  const more = names.length - MAX_PRODUCTS_LISTED;
  return names.slice(0, MAX_PRODUCTS_LISTED).join(", ") + (more > 0 ? ` + ${more} more` : "");
}

/* ------------------------------------------------------------ templates */

const paymentOverdue =
  (withDays: boolean) =>
  (f: CustomerFacts): Record<string, string> | string[] => {
    const v = paymentView(f);
    if (v.refusals.length) return v.refusals;
    const bills = billView(v.overdue);
    const fmt = amountFormatter(v.overdue.map((b) => b.balancePaise).concat(bills.totalPaise));
    const out: Record<string, string> = {
      customer_name: f.customer.name,
      as_of_date: messageDate(f.today)!,
      bills_list: bills.list,
      total_overdue: fmt(bills.totalPaise),
    };
    if (withDays) out.oldest_overdue_days = String(daysBetween(bills.listed[0].dueDate, f.today));
    return out;
  };

const SPECS: Record<string, Spec> = {
  payment_followup_1: {
    kind: "payment",
    label: "Payment follow-up",
    params: ["customer_name", "as_of_date", "bills_list", "total_overdue"],
    build: paymentOverdue(false),
  },
  payment_statement: {
    kind: "payment",
    label: "Outstanding statement",
    params: ["customer_name", "as_of_date", "bills_list", "total_due"],
    build: (f) => {
      const v = paymentView(f);
      if (v.refusals.length) return v.refusals;
      // A statement lists every open bill — due and not yet due — and its total
      // is those same bills. It is only sent when at least one is overdue,
      // because its own text asks for "payment of the overdue bills".
      const bills = billView(v.open);
      const fmt = amountFormatter(v.open.map((b) => b.balancePaise));
      return {
        customer_name: f.customer.name,
        as_of_date: messageDate(f.today)!,
        bills_list: bills.list,
        total_due: fmt(bills.totalPaise),
      };
    },
  },
  payment_followup_urgent: {
    kind: "payment",
    label: "Urgent payment follow-up",
    params: ["customer_name", "bills_list", "total_overdue", "oldest_overdue_days"],
    build: paymentOverdue(true),
  },
  payment_credit_hold: {
    kind: "payment",
    label: "Overdue payment / credit hold",
    params: ["customer_name", "bills_list", "total_overdue", "oldest_overdue_days"],
    build: paymentOverdue(true),
  },
  order_reminder_due: {
    kind: "order",
    label: "Order reminder (due)",
    params: ["customer_name", "expected_order_date", "last_order_date", "last_products"],
    build: (f) => {
      const v = orderView(f);
      if (Array.isArray(v)) return v;
      // "Your next order IS due around <date>" is only true on or before it.
      if (v.expected < f.today) {
        return ["The expected order date has already passed — this reminder says it is still coming. Use a follow-up template instead."];
      }
      return {
        customer_name: f.customer.name,
        expected_order_date: messageDate(v.expected)!,
        last_order_date: messageDate(v.lastOrder.date)!,
        last_products: productsLine(v.lastOrder.products),
      };
    },
  },
  order_followup_due_passed: {
    kind: "order",
    label: "Order follow-up (due date passed)",
    params: ["customer_name", "cycle_days", "expected_order_date", "last_order_date", "days_since_last_order", "last_products"],
    build: (f) => overdueOrder(f, false),
  },
  order_followup_cycle_exceeded: {
    kind: "order",
    label: "Order follow-up (cycle exceeded)",
    params: ["customer_name", "last_order_date", "cycle_days", "expected_order_date", "days_since_last_order", "last_products"],
    build: (f) => overdueOrder(f, false),
  },
  customer_followup_gap: {
    kind: "order",
    label: "Customer follow-up (long gap)",
    params: ["customer_name", "days_since_last_order", "cycle_days", "last_order_date", "last_products", "last_order_value"],
    build: (f) => overdueOrder(f, true),
  },
};

function overdueOrder(f: CustomerFacts, withValue: boolean): Record<string, string> | string[] {
  const v = orderView(f);
  if (Array.isArray(v)) return v;
  // "Your next order WAS expected… we have not received it" is only true after.
  if (v.expected >= f.today) {
    return ["The expected order date has not passed yet — this message says the order is late."];
  }
  const out: Record<string, string> = {
    customer_name: f.customer.name,
    cycle_days: String(f.cycle.days),
    expected_order_date: messageDate(v.expected)!,
    last_order_date: messageDate(v.lastOrder.date)!,
    days_since_last_order: String(v.sinceDays),
    last_products: productsLine(v.lastOrder.products),
  };
  if (withValue) out.last_order_value = amountFormatter([v.lastOrder.valuePaise])(v.lastOrder.valuePaise);
  return out;
}

/* --------------------------------------------------------------- lookup */

/** `payment_followup_1_v2` -> `payment_followup_1`. A resubmitted version is the same message. */
export function specKey(watiName: string | null | undefined): string | null {
  if (!watiName) return null;
  const base = watiName.replace(/_v\d+$/, "");
  return Object.prototype.hasOwnProperty.call(SPECS, base) ? base : null;
}

export function specFor(key: string | null | undefined): Spec | null {
  return key && Object.prototype.hasOwnProperty.call(SPECS, key) ? SPECS[key] : null;
}

export const SPEC_KEYS = Object.keys(SPECS);

/**
 * The whole decision for one customer and one template: the exact variables,
 * or every reason it must not go. `watiParams` is what the approved template in
 * Wati actually asks for — if somebody edited it there and it now names a
 * variable this spec does not produce, that is a refusal, not a blank.
 */
export function renderSpec(
  key: string,
  facts: CustomerFacts,
  watiParams?: readonly string[],
): RenderResult {
  const spec = specFor(key);
  if (!spec) return { ok: false, reasons: [`No rules exist for the template "${key}".`] };

  const built = spec.build(facts);
  if (Array.isArray(built)) return { ok: false, reasons: [...new Set(built)] };

  const wanted = watiParams?.length ? watiParams : spec.params;
  const unknown = wanted.filter((p) => !spec.params.includes(p));
  if (unknown.length) {
    return {
      ok: false,
      reasons: [`The template in Wati asks for ${unknown.map((p) => `{{${p}}}`).join(", ")}, which these rules do not fill. It was changed in Wati — fix it there or update the rules.`],
    };
  }

  const params: Array<{ name: string; value: string }> = [];
  const reasons: string[] = [];
  for (const name of wanted) {
    const value = clean(built[name] ?? "");
    if (!value) reasons.push(`{{${name}}} would be empty.`);
    else if (value.length > MAX_PARAM_CHARS) reasons.push(`{{${name}}} is too long for WhatsApp.`);
    else params.push({ name, value });
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, params };
}

/** The template body with its variables filled — exactly what the customer reads. */
export function fillBody(body: string, params: Array<{ name: string; value: string }>): string {
  const map = new Map(params.map((p) => [p.name, p.value]));
  return body.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, n: string) => map.get(n) ?? m);
}

/**
 * The same message for the MANUAL route, where it is pasted into WhatsApp by a
 * person and so arrives with NO buttons. The approved wording says "tap an
 * option below"; pasted as it stands, that points the customer at buttons
 * that do not exist. Each such sentence becomes an ask to reply instead, and a
 * body that still mentions tapping afterwards is refused rather than sent —
 * a new phrasing added in Wati must fail loudly here, not reach a customer.
 */
export function manualText(filled: string): { ok: true; text: string } | { ok: false; reason: string } {
  const text = filled
    .replace(
      /Please tap an option below — if something has changed, tap \*Share a reason\* and choose from the list\./g,
      "Please reply and let us know if anything has changed.",
    )
    .replace(/Please tap the option that fits best below\./g, "Please reply and let us know.")
    .replace(/Please tap an option below/g, "Please reply to this message");
  if (/\btap\b/i.test(text)) {
    return { ok: false, reason: "This message refers to buttons, which a pasted message does not have. It can only go through the WhatsApp API." };
  }
  return { ok: true, text };
}

/* ------------------------------------------------------ the rule clocks */

/**
 * Where a customer stands on a template's own clock, for the automation rules:
 * a payment template counts DAYS OVERDUE (the oldest undisputed stated bill,
 * past its due date); an order template counts DAYS PAST THE EXPECTED ORDER
 * DATE (negative before it). Null when the clock does not apply at all —
 * nothing overdue, or no measured cycle and last order to count from. The
 * same definitions the variables above print, so a rule "15 days overdue"
 * and a message saying "overdue by 15 days" can never disagree.
 */
export function ruleClock(
  kind: "payment" | "order",
  f: CustomerFacts,
): { day: number; overduePaise: number } | null {
  if (kind === "payment") {
    const overdue = f.openBills.filter((b) => b.balancePaise > 0 && !b.disputed && b.dueDate < f.today);
    if (!overdue.length) return null;
    const oldest = overdue.reduce((a, b) => (b.dueDate < a.dueDate ? b : a));
    return {
      day: daysBetween(oldest.dueDate, f.today),
      overduePaise: overdue.reduce((s, b) => s + b.balancePaise, 0),
    };
  }
  if (!f.lastOrder || !f.cycle.measured || f.cycle.days <= 0) return null;
  return { day: daysBetween(addDays(f.lastOrder.date, f.cycle.days), f.today), overduePaise: 0 };
}
