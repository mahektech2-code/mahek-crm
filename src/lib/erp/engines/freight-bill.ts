/* ---------------------------------------------------------------------------
 * TRANSPORT EXPENSES — the transporter's bill, split by litres (the
 * Transportation Expense PRD). Pure and client-safe: the add-bill dialog
 * previews with these functions and the server writes what they return, so
 * the split on the screen is the split that is saved.
 *
 * One bill is one vehicle that left on one day. Only PAID freight is a company
 * expense — To Pay (the customer pays the transporter) and TBB are shown and
 * never counted. The bill is shared over the ORDER LINES on the vehicle by
 * dispatched litres only, with `allocateByLitres` (largest remainder), so the
 * shares add up to the bill to the paisa.
 * ------------------------------------------------------------------------- */

import { allocateByLitres, type Allocation } from "./transport-cost";
import { freightKey } from "./logistics";

export const PAYMENT_MODES = ["bank", "upi", "cash"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const PAYMENT_MODE_LABEL: Record<PaymentMode, string> = { bank: "Bank", upi: "UPI", cash: "Cash" };

export type FreightBillStatus = "pending" | "paid" | "deleted";

/** "TB-1041". */
export const freightBillNo = (n: number) => `TB-${n}`;

/** "TB-1041 · LR 88213". */
export const freightBillName = (n: number, lrNo: string) => `${freightBillNo(n)} · LR ${lrNo}`;

/** Why a dispatched order line is, or is not, part of a transport bill. */
export type LineEligibility = { ok: true } | { ok: false; why: string; kind: "to_pay" | "tbb" | "unknown" | "taken" | "no_litres" };

export function lineEligibility(l: { freightTerm: string | null; litres: number | null; takenBy: string | null }): LineEligibility {
  if (l.takenBy) return { ok: false, kind: "taken", why: `Already on ${l.takenBy}` };
  const k = freightKey(l.freightTerm);
  if (k === "to_pay") return { ok: false, kind: "to_pay", why: "To Pay · customer pays" };
  if (k === "tbb") return { ok: false, kind: "tbb", why: "TBB · not a company expense" };
  if (k !== "paid") return { ok: false, kind: "unknown", why: "Freight not set as Paid" };
  if (l.litres == null || !(l.litres > 0)) return { ok: false, kind: "no_litres", why: "No litres on this line" };
  return { ok: true };
}

/** The split itself: the bill over the ticked lines, by litres. */
export function splitBill(amountPaise: number, lines: { orderId: string; litres: number | null }[]): Allocation {
  return allocateByLitres(
    amountPaise,
    lines.map((l) => ({ id: l.orderId, litres: l.litres })),
  );
}

/** Rupees as typed ("1,000", "₹ 1000.50") to paise; null where it is not a positive amount. */
export function paiseFromRupees(v: string): number | null {
  const t = v.replace(/[,₹\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const p = Math.round(Number(t) * 100);
  return p > 0 ? p : null;
}

export type BillInput = {
  lrNo: string;
  billDate: string;
  transporter: string;
  vehicleNo: string;
  dispatchOn: string;
  amountPaise: number | null;
  orderIds: string[];
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Field problems with a bill before it is saved, keyed by field. Empty when it may be saved. */
export function billProblems(b: BillInput, today: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!b.lrNo.trim()) out.lrNo = "Write the bill or LR number.";
  if (!DAY.test(b.billDate)) out.billDate = "Pick the bill date.";
  else if (b.billDate > today) out.billDate = "The bill date cannot be in the future.";
  if (!b.transporter.trim()) out.transporter = "Pick the transporter.";
  if (!b.vehicleNo.trim()) out.vehicleNo = "Pick the vehicle.";
  if (!DAY.test(b.dispatchOn)) out.vehicleNo = out.vehicleNo ?? "Pick the vehicle and the day it left.";
  if (b.amountPaise == null || !Number.isInteger(b.amountPaise) || b.amountPaise <= 0) out.amount = "Enter the total amount on the bill.";
  if (!b.orderIds.length) out.orderIds = "Tick at least one Paid-freight dispatch on the vehicle.";
  return out;
}

/* ------------------------------------------------- when the split went stale */

export type StoredShare = { orderId: string; litres: number };
export type LineNow = { orderId: string; litres: number | null; freightTerm: string | null; gone: boolean };

export type ShareChange = { orderId: string; was: number; now: number | null; why: "litres" | "gone" | "not_paid" };

/**
 * The shares whose order line no longer matches what it was split on: its
 * litres were corrected, it was cancelled or undone, or it stopped being Paid
 * freight. Any one of these means the bill must be split again before it is
 * paid — paying on a stale split would put the wrong cost on the order.
 */
export function staleShares(stored: StoredShare[], now: Map<string, LineNow>): ShareChange[] {
  const out: ShareChange[] = [];
  for (const s of stored) {
    const n = now.get(s.orderId);
    if (!n || n.gone) out.push({ orderId: s.orderId, was: s.litres, now: null, why: "gone" });
    else if (freightKey(n.freightTerm) !== "paid") out.push({ orderId: s.orderId, was: s.litres, now: n.litres, why: "not_paid" });
    else if (n.litres == null || Math.round(n.litres * 1000) !== Math.round(s.litres * 1000)) out.push({ orderId: s.orderId, was: s.litres, now: n.litres, why: "litres" });
  }
  return out;
}

/* ------------------------------------------------- what may be done, and why not */

export function editRefusal(status: FreightBillStatus): string | null {
  if (status === "paid") return "This bill is paid. Undo the payment first to change it.";
  if (status === "deleted") return "This bill was deleted.";
  return null;
}

export function markPaidRefusal(status: FreightBillStatus, stale: number): string | null {
  if (status !== "pending") return status === "paid" ? "This bill is already paid." : "This bill was deleted.";
  if (stale) return "A dispatch on this bill changed since it was split. Split it again before paying.";
  return null;
}

export function undoPaymentRefusal(status: FreightBillStatus, manager: boolean): string | null {
  if (!manager) return "Only a manager can undo a payment.";
  if (status !== "paid") return "Only a paid bill can be moved back to pending.";
  return null;
}

/** Paise per litre, unrounded; null with no litres. */
export const costPerLitrePaise = (amountPaise: number, litres: number): number | null => (litres > 0 ? amountPaise / litres : null);
