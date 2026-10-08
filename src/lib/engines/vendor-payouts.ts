/* ---------------------------------------------------------------------------
 * VENDOR PAYOUTS — the rules, PURE.
 *
 * What a supplier is owed and the day accounts will pay it. Payments go out on
 * the PAYMENT DAYS (`payments.vendorPayoutDays`, Tuesday to Friday by default)
 * and every date here is an IST calendar date written `YYYY-MM-DD` — the
 * business date is handed in, never read from a clock, so the same function
 * answers on the server, in the calendar the payouts are dragged around on,
 * and in a test.
 *
 * Two dates per payout, and they are different questions:
 *   - DUE is when the money is owed: the purchase date plus the supplier's
 *     credit days.
 *   - PAY ON is the payment day it is planned for: the first payment day on or
 *     after the due date — or today, where the due date has already gone —
 *     until a person moves it.
 * ------------------------------------------------------------------------- */

import { purchaseFigures, type PurchaseInput } from "@/lib/erp/engines/purchase";

/** ISO weekday order: Monday is 1, Sunday 7. */
export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** The invoice kinds offered first. Anything else can be typed. */
export const INVOICE_KINDS = [
  "Proforma invoice",
  "Tax invoice",
  "Debit note",
  "Credit note",
  "Delivery challan",
  "E-way bill",
] as const;

export type PayoutStatus = "open" | "on_hold" | "paid" | "cancelled";

/** The weekdays named in configuration, as ISO numbers. An unknown name is ignored. */
export function paymentWeekdays(names: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const n of names) {
    const i = WEEKDAY_NAMES.findIndex((w) => w.toLowerCase() === n.trim().toLowerCase());
    if (i >= 0) out.add(i + 1);
  }
  return out;
}

function parse(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** Calendar days from `a` to `b` — positive when `b` is later. */
export function daysFrom(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}

/** ISO weekday of a calendar date: Monday 1 … Sunday 7. */
export function weekdayOf(iso: string): number {
  const d = parse(iso).getUTCDay();
  return d === 0 ? 7 : d;
}

export function isPaymentDay(iso: string, days: Set<number>): boolean {
  return days.has(weekdayOf(iso));
}

/** The first payment day on or after `iso`. With no payment days at all, `iso` itself. */
export function paymentDayOnOrAfter(iso: string, days: Set<number>): string {
  if (days.size === 0) return iso.slice(0, 10);
  let d = iso.slice(0, 10);
  for (let i = 0; i < 7; i++) {
    if (isPaymentDay(d, days)) return d;
    d = addDays(d, 1);
  }
  return iso.slice(0, 10);
}

/** When the money is owed: the purchase date plus the credit days. */
export function dueDateFor(purchaseDate: string, creditDays: number | null | undefined, defaultCreditDays: number): string {
  const n = creditDays != null && creditDays >= 0 ? creditDays : defaultCreditDays;
  return addDays(purchaseDate, n);
}

/**
 * The payment day a payout is planned for, before anybody has chosen one: the
 * first payment day on or after the due date — or on or after today, where the
 * due date has already gone, because a payment planned for last Thursday is a
 * payment nobody is going to make.
 */
export function plannedPayOn(dueDate: string, today: string, days: Set<number>): string {
  return paymentDayOnOrAfter(dueDate < today ? today : dueDate, days);
}

/**
 * Whether a payout may be moved to `target`, and why not. A payment day, and
 * not in the past: dragging a payout onto Saturday would put it on a day no
 * money goes out, and onto yesterday would plan something already missed.
 */
export function moveRefusal(target: string, today: string, days: Set<number>, status: PayoutStatus): string | null {
  if (status === "paid") return "This payout is already paid.";
  if (status === "cancelled") return "This payout was cancelled.";
  if (target < today) return "A payout cannot be planned for a day that has gone.";
  if (!isPaymentDay(target, days)) {
    const list = [...days].sort().map((d) => WEEKDAY_NAMES[d - 1]);
    return `Payments go out on ${listWords(list)} — not on a ${WEEKDAY_NAMES[weekdayOf(target) - 1]}.`;
  }
  return null;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export type PayoutTone = "paid" | "cancelled" | "held" | "overdue" | "today" | "late" | "upcoming";

/**
 * One word for where a payout stands today. `late` is planned for AFTER the
 * day it falls due — allowed, sometimes on purpose, and worth seeing; `overdue`
 * is planned for a day that has already gone and is still not paid.
 */
export function payoutTone(p: { status: PayoutStatus; payOn: string; dueDate: string }, today: string): PayoutTone {
  if (p.status === "paid") return "paid";
  if (p.status === "cancelled") return "cancelled";
  if (p.status === "on_hold") return "held";
  if (p.payOn < today) return "overdue";
  if (p.payOn === today) return "today";
  if (p.payOn > p.dueDate) return "late";
  return "upcoming";
}

export const TONE_LABEL: Record<PayoutTone, string> = {
  paid: "Paid",
  cancelled: "Cancelled",
  held: "On hold",
  overdue: "Overdue",
  today: "Pay today",
  late: "After due date",
  upcoming: "Planned",
};

/* ------------------------------------------------------------- purchases */

export type RegisterLot = PurchaseInput & {
  id: string;
  prNumber: number;
  purchaseDate: string;
  supplierId: string;
  supplierName: string;
  supplierCreditDays: number | null;
  poId: string | null;
  billNumber: string | null;
  status: string;
};

export type PurchaseGroup = {
  key: string;
  prNumber: number;
  supplierId: string;
  supplierName: string;
  supplierCreditDays: number | null;
  purchaseDate: string;
  poId: string | null;
  /** Every distinct bill number on the lots, in order. */
  reference: string | null;
  amountPaise: number;
  lots: number;
};

export function purchaseKey(supplierId: string, prNumber: number): string {
  return `${supplierId}|${prNumber}`;
}

/**
 * The register's lots as payouts: one per supplier per PR number, worth the
 * register's own final figure (rate × quantity, its GST, less any feed
 * adjustment) summed over the lots. A lot with no rate is not yet a debt
 * anybody can put a figure on and is left out; a group with no rated lot is no
 * payout at all.
 */
export function groupPurchaseLots(lots: RegisterLot[]): PurchaseGroup[] {
  const groups = new Map<string, PurchaseGroup & { refs: string[] }>();
  for (const l of lots) {
    if (l.ratePaise == null) continue;
    const value = purchaseFigures(l).finalPaise ?? 0;
    const key = purchaseKey(l.supplierId, l.prNumber);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        prNumber: l.prNumber,
        supplierId: l.supplierId,
        supplierName: l.supplierName,
        supplierCreditDays: l.supplierCreditDays,
        purchaseDate: l.purchaseDate,
        poId: l.poId,
        reference: null,
        amountPaise: 0,
        lots: 0,
        refs: [],
      };
      groups.set(key, g);
    }
    g.amountPaise += Math.max(0, value);
    g.lots += 1;
    if (l.purchaseDate < g.purchaseDate) g.purchaseDate = l.purchaseDate;
    if (!g.poId && l.poId) g.poId = l.poId;
    const ref = l.billNumber?.trim();
    if (ref && !g.refs.includes(ref)) g.refs.push(ref);
  }
  return [...groups.values()].map(({ refs, ...g }) => ({ ...g, reference: refs.length ? refs.join(", ") : null }));
}

/* -------------------------------------------------------------- calendar */

/** `count` consecutive dates from `from`. */
export function dateRange(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(from, i));
}

/** The Monday of the week `iso` falls in. */
export function weekStart(iso: string): string {
  return addDays(iso, 1 - weekdayOf(iso));
}
