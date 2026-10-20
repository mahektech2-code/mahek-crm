/* ---------------------------------------------------------------------------
 * EMPTY DRUMS AND SCRAP, as rules. PURE: no I/O, so the factory phone's
 * screen, the ERP screens and the tests all read the same answers.
 *
 * A drum is registered when it becomes EMPTY, off its existing GRN/lot label,
 * and carries that GRN from then on. Whose it is decides where it goes:
 * Mahek's drums are scrap stock, sold by quantity oldest first; a supplier's
 * drums wait to be returned to that supplier, oldest first, and are never
 * sold. An unknown owner is never guessed — the drum waits for review.
 *
 * A scrap sale is a receivable. What is owed is the sale less what an
 * accountant matched to it from scrap receipts — read, never
 * stored, so a voided match gives the balance back on its own.
 * ------------------------------------------------------------------------- */

export type DrumOwnership = "mahek" | "returnable";
export type DrumStatus = "available" | "returnable" | "review" | "sold" | "returned" | "adjusted" | "cancelled";

export const OWNERSHIP_LABEL: Record<DrumOwnership, string> = {
  mahek: "Mahek owned",
  returnable: "Vendor returnable",
};

/** The PRD's lifecycle names, as a person reads them. */
export const DRUM_STATUS_LABEL: Record<DrumStatus, string> = {
  available: "Empty – available",
  returnable: "Empty – returnable to vendor",
  review: "Needs review",
  sold: "Sold",
  returned: "Returned to vendor",
  adjusted: "Adjusted",
  cancelled: "Cancelled",
};

/** The category every empty metal drum is sold under; the rest are a reference list. */
export const DRUM_CATEGORY = "Empty Metal Drum";

export const ownershipByLabel = (label: string | null | undefined): DrumOwnership | null =>
  label === OWNERSHIP_LABEL.mahek || label === "mahek" ? "mahek" : label === OWNERSHIP_LABEL.returnable || label === "returnable" ? "returnable" : null;

/**
 * Whose a drum is: what its GRN line says, else what its supplier usually
 * says. Neither is UNKNOWN — the one answer this function never invents.
 */
export function ownershipOf(grnLine: string | null | undefined, supplier: string | null | undefined): DrumOwnership | null {
  return ownershipByLabel(grnLine) ?? ownershipByLabel(supplier);
}

/** Where a freshly emptied drum lands. */
export function statusOnEmpty(ownership: DrumOwnership | null): DrumStatus {
  return ownership === "mahek" ? "available" : ownership === "returnable" ? "returnable" : "review";
}

/** Actual empty weight − supplier-declared tare. Null where the GRN declared none: no figure is invented. */
export function tareVariance(actualKg: number | null | undefined, declaredKg: number | null | undefined): { kg: number; pct: number | null } | null {
  if (actualKg == null || declaredKg == null) return null;
  const kg = Math.round((actualKg - declaredKg) * 1000) / 1000;
  const pct = declaredKg > 0 ? Math.round((kg / declaredKg) * 1000) / 10 : null;
  return { kg, pct };
}

export type VarianceLimits = { alertKg: number; alertPercent: number };

/** Past either limit (in either direction) is worth somebody's look. */
export function varianceIsHigh(v: { kg: number; pct: number | null } | null, t: VarianceLimits): boolean {
  if (!v) return false;
  return Math.abs(v.kg) > t.alertKg || (v.pct != null && Math.abs(v.pct) > t.alertPercent);
}

export type WeightLimits = { minKg: number; maxKg: number };

/** Null where the weight may be saved; else the sentence that stops it. */
export function weightRefusal(kg: number | null | undefined, l: WeightLimits): string | null {
  if (kg == null || !Number.isFinite(kg)) return "Enter the empty drum's weight in kg.";
  if (kg <= 0) return "The weight must be more than 0 kg.";
  if (kg < l.minKg) return `${kg} kg is below ${l.minKg} kg, the lightest an empty drum is expected to weigh. Weigh it again, or ask the Production Head to approve it.`;
  if (kg > l.maxKg) return `${kg} kg is above ${l.maxKg} kg, the heaviest an empty drum is expected to weigh. Check it is completely empty, or ask the Production Head to approve it.`;
  return null;
}

/**
 * Which drum of its lot this is: the lowest number not yet registered. Null
 * where every drum the GRN brought in is already registered — scanning a
 * fifth drum off a four-drum lot is a duplicate, not a fifth drum. A GRN
 * that recorded no drum count cannot be checked, so `total` null answers the
 * next free number and the caller sends it for review.
 */
export function nextDrumSeq(total: number | null | undefined, taken: number[]): number | null {
  const used = new Set(taken);
  const cap = total == null ? Number.POSITIVE_INFINITY : total;
  for (let n = 1; n <= cap; n++) if (!used.has(n)) return n;
  return null;
}

export type PoolDrum = { id: string; drumNo: number; recordedAt: string | Date };

/**
 * OLDEST FIRST: the drums a sale or a return takes, by when they were
 * emptied, then by number. A system allocation for traceability — it does
 * not claim anybody checked those physical drums at the gate.
 */
export function fifoPick<T extends PoolDrum>(pool: T[], qty: number, what = "drum"): { ok: true; picked: T[] } | { ok: false; error: string } {
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: "Enter how many drums, a whole number above 0." };
  if (qty > pool.length) return { ok: false, error: `Only ${pool.length} ${what}${pool.length === 1 ? "" : "s"} available — you entered ${qty}.` };
  const sorted = [...pool].sort((a, b) => +new Date(a.recordedAt) - +new Date(b.recordedAt) || a.drumNo - b.drumNo);
  return { ok: true, picked: sorted.slice(0, qty) };
}

/* ------------------------------------------------------------ receivables */

export type PaymentState = "Unpaid" | "Partially Paid" | "Paid";

export function outstanding(salePaise: number, allocatedPaise: number): number {
  return Math.max(0, salePaise - allocatedPaise);
}

export function paymentState(salePaise: number, allocatedPaise: number): PaymentState {
  if (allocatedPaise <= 0) return salePaise === 0 ? "Paid" : "Unpaid";
  return allocatedPaise >= salePaise ? "Paid" : "Partially Paid";
}

/** Days between two ISO dates (b − a). */
export function daysFrom(a: string, b: string): number {
  return Math.round((Date.parse(b.slice(0, 10) + "T00:00:00Z") - Date.parse(a.slice(0, 10) + "T00:00:00Z")) / 86_400_000);
}

export const AGE_BUCKETS = ["Current", "1–7", "8–15", "16–30", "31–60", "60+"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

/** Days past the due date (the sale date where none was agreed), bucketed as the PRD asks. */
export function receivableBucket(dueDate: string | null, saleDate: string, today: string): AgeBucket {
  const late = daysFrom(dueDate ?? saleDate, today);
  if (late <= 0) return "Current";
  if (late <= 7) return "1–7";
  if (late <= 15) return "8–15";
  if (late <= 30) return "16–30";
  if (late <= 60) return "31–60";
  return "60+";
}

export const RETURN_BUCKETS = ["0–30 days", "31–60 days", "61–90 days", "90+ days"] as const;
export type ReturnBucket = (typeof RETURN_BUCKETS)[number];

/** How long a supplier's empty drum has waited to go back, from the day it was emptied. */
export function returnBucket(emptiedOn: string, today: string): ReturnBucket {
  const d = daysFrom(emptiedOn, today);
  return d <= 30 ? "0–30 days" : d <= 60 ? "31–60 days" : d <= 90 ? "61–90 days" : "90+ days";
}

/**
 * Null where `amount` may be matched; else why not. Never more than is left
 * of the receipt, never more than is owed on the sale.
 */
export function allocationRefusal(amountPaise: number, receiptLeftPaise: number, saleOutstandingPaise: number): string | null {
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) return "Enter an amount above ₹0.";
  if (amountPaise > receiptLeftPaise) return `Only ₹${(receiptLeftPaise / 100).toLocaleString("en-IN")} of this receipt is not yet matched.`;
  if (amountPaise > saleOutstandingPaise) return `Only ₹${(saleOutstandingPaise / 100).toLocaleString("en-IN")} is outstanding on this sale.`;
  return null;
}

/**
 * Spreads one receipt over a buyer's open sales, OLDEST DUE FIRST, never past
 * what each owes or what the receipt has left. The accountant sees it and
 * may change it; this is only the suggestion.
 */
export function suggestAllocation(
  leftPaise: number,
  sales: { id: string; due: string; outstandingPaise: number }[],
): { saleId: string; amountPaise: number }[] {
  let left = Math.max(0, leftPaise);
  const out: { saleId: string; amountPaise: number }[] = [];
  for (const s of [...sales].sort((a, b) => a.due.localeCompare(b.due))) {
    if (left <= 0) break;
    const take = Math.min(left, s.outstandingPaise);
    if (take > 0) out.push({ saleId: s.id, amountPaise: take });
    left -= take;
  }
  return out;
}

/** Quantity × rate, in paise, rounded to the paisa. */
export function saleAmount(qty: number, ratePaise: number): number {
  return Math.round(qty * ratePaise);
}

/** "SCR-12", "DRM-40", "RET-3", "RCPT-8": how each number is read out. */
export const scrapSaleLabel = (n: number) => `SCR-${n}`;
export const drumLabel = (n: number) => `DRM-${n}`;
export const drumReturnLabel = (n: number) => `RET-${n}`;
export const receiptLabel = (n: number) => `RCPT-${n}`;

/** The one sentence a returnable drum offered for sale is refused with. */
export const RETURNABLE_NOT_FOR_SALE = "This drum is vendor-returnable. Please use Returnable Drum Outward.";
