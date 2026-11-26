/**
 * WHAT THE OFFICE WILL REFUSE AT SYNC, said on the phone before he promises it.
 *
 * `credit.ts` is the handset's own reading — over the limit routes to an
 * approval and saves. The office has three refusals of its own that the phone
 * never asked about, so a salesman pressed "Send for approval", watched it
 * save, and found it on Not accepted hours later with the shop already told:
 *
 *  - `mbos.credit.blockOnLimitExceeded` — on, `handleOrder` refuses any order
 *    that takes the BILLER's outstanding past their limit (an edit only where
 *    it raises the order's value). It counts outstanding and this order, not
 *    the other open orders, and no tolerance — so this mirrors exactly that.
 *  - `mbos.credit.overdueDaysBlockOrders` — a bill this many days past its due
 *    date stops new orders. 0 is off.
 *  - `mbos.orders.minimumQuantityCans` — every line at least this many cans.
 *    0 is no minimum.
 *
 * Pure and Expo-free, so `order-gates.test.ts` runs it under node.
 */

export type OfficeRefusal = { code: 'credit_exceeded' | 'overdue_blocked' | 'below_minimum'; reason: string };

function rupees(paise: number): string {
  const r = Math.round(paise) / 100;
  const whole = Math.trunc(Math.abs(r));
  const s = String(whole);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? rest + ',' + last3 : last3;
  const frac = Math.round((Math.abs(r) - whole) * 100);
  return (r < 0 ? '−' : '') + '₹' + grouped + (frac ? '.' + String(frac).padStart(2, '0') : '');
}

/**
 * The credit limit as the OFFICE applies it, which is not the phone's rule.
 * Null where the office will take it: the switch is off, no limit is on file,
 * the order has no value (it reaches the office as ₹0 and is never measured),
 * or — for an edit — the value did not go up.
 */
export function officeCreditRefusal(input: {
  blockOnLimitExceeded: boolean;
  billerName: string;
  creditLimitPaise: number | null;
  outstandingPaise: number;
  orderValuePaise: number | null;
  /** For an edit: the order's value before. The office refuses an edit only where it rises. */
  previousValuePaise?: number | null;
}): OfficeRefusal | null {
  if (!input.blockOnLimitExceeded) return null;
  if (input.creditLimitPaise == null) return null;
  const value = input.orderValuePaise;
  if (value == null || value <= 0) return null;
  if (input.previousValuePaise != null && value <= input.previousValuePaise) return null;
  if (input.outstandingPaise + value <= input.creditLimitPaise) return null;
  return {
    code: 'credit_exceeded',
    reason:
      `The office will not accept this. ${input.billerName} owes ${rupees(input.outstandingPaise)}, and ` +
      `this order of ${rupees(value)} takes them past their ${rupees(input.creditLimitPaise)} limit. ` +
      'Collect against the old bills, make the order smaller, or ask accounts to raise the limit.',
  };
}

export type OpenBill = {
  billNo?: string | null;
  dueDate: string | null;
  balancePaise: number | null;
  paymentPosition?: string | null;
  disputed?: number | boolean | null;
};

/** Whole days from one `YYYY-MM-DD` to another; negative when `to` is earlier. */
export function daysBetweenDates(from: string, to: string): number {
  const a = Date.parse(from.slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(to.slice(0, 10) + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000);
}

/**
 * The oldest open bill's days past due, counted against TODAY rather than the
 * `overdueDays` the office sent at the last pull. A bill that is unstated (no
 * one has said whether it is owed) or disputed is not a debt to block on —
 * the same two the office leaves out (`overdueBlockingBill` on the server).
 */
export function oldestOverdue(bills: readonly OpenBill[], today: string): { days: number; billNo: string | null } | null {
  let worst: { days: number; billNo: string | null } | null = null;
  for (const b of bills) {
    if (!b.dueDate || (b.balancePaise ?? 0) <= 0) continue;
    if (b.paymentPosition === 'unstated') continue;
    if (b.disputed === true || b.disputed === 1) continue;
    const days = daysBetweenDates(b.dueDate, today);
    if (days <= 0) continue;
    if (!worst || days > worst.days) worst = { days, billNo: b.billNo ?? null };
  }
  return worst;
}

export function overdueRefusal(input: {
  blockDays: number;
  billerName: string;
  bills: readonly OpenBill[];
  today: string;
}): OfficeRefusal | null {
  if (!(input.blockDays > 0)) return null;
  const worst = oldestOverdue(input.bills, input.today);
  if (!worst || worst.days < input.blockDays) return null;
  return {
    code: 'overdue_blocked',
    reason:
      `${input.billerName} has a bill${worst.billNo ? ' (' + worst.billNo + ')' : ''} ${worst.days} days past its due date. ` +
      `New orders stop at ${input.blockDays} days. Collect it first, or ask accounts.`,
  };
}

export function minimumRefusal(input: {
  minimumCans: number;
  lines: readonly { productName: string; cans: number }[];
}): OfficeRefusal | null {
  if (!(input.minimumCans > 0)) return null;
  const short = input.lines.filter((l) => l.cans > 0 && l.cans < input.minimumCans);
  if (!short.length) return null;
  const names = short.slice(0, 2).map((l) => l.productName).join(', ') + (short.length > 2 ? ` and ${short.length - 2} more` : '');
  return {
    code: 'below_minimum',
    reason: `Every line needs at least ${input.minimumCans} cans. Not enough on: ${names}.`,
  };
}
