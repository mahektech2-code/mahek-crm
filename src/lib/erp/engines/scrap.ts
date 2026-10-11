/* ---------------------------------------------------------------------------
 * SCRAP & EMPTY DRUMS — the rules, pure.
 *
 * A drum is registered the moment it is emptied, against the GRN lot it came
 * in, and from then on it lives in exactly one of two stocks: Mahek's (sold as
 * scrap, by quantity, oldest first) or the vendor's (returned to the supplier,
 * by quantity, oldest first). A drum whose lot nobody has said the owner of
 * waits for a person — it is never guessed into either.
 *
 * Everything here takes its inputs as arguments and performs no I/O, so the
 * scan page, the screens and the tests read one set of rules.
 * ------------------------------------------------------------------------- */

export type DrumOwnership = "mahek" | "vendor";
export type DrumStatus = "available" | "returnable" | "review" | "sold" | "returned" | "cancelled";
export type ScrapCategory = "drum" | "plastic" | "cardboard" | "other";
export type ScrapUnit = "Drums" | "Kg" | "Bags" | "Pcs";

export const DRUM_STATUS_LABEL: Record<DrumStatus, string> = {
  available: "Available",
  returnable: "To return",
  review: "Owner to decide",
  sold: "Sold",
  returned: "Returned",
  cancelled: "Cancelled",
};

export const OWNERSHIP_LABEL: Record<DrumOwnership, string> = { mahek: "Mahek owned", vendor: "Vendor returnable" };

export const CATEGORY_LABEL: Record<ScrapCategory, string> = {
  drum: "Empty metal drum",
  plastic: "Plastic scrap",
  cardboard: "Cardboard / packing box",
  other: "Other scrap",
};

/** The units a category is sold in. A drum is counted, everything else weighed or counted in bags or pieces. */
export const CATEGORY_UNITS: Record<ScrapCategory, ScrapUnit[]> = {
  drum: ["Drums"],
  plastic: ["Kg", "Bags", "Pcs"],
  cardboard: ["Kg", "Bags", "Pcs"],
  other: ["Kg", "Bags", "Pcs"],
};

export const categoryByLabel = (label: string): ScrapCategory | null =>
  (Object.entries(CATEGORY_LABEL).find(([, l]) => l === label)?.[0] as ScrapCategory | undefined) ?? null;

export const VENDOR_DRUM_REFUSAL = "This drum is vendor-returnable. Please use Returnable Drum Outward.";

/* ------------------------------------------------------------ the scan */

/**
 * What a scanned or typed code names. A drum label carries the lot number;
 * `LOT/3` or `LOT#3` names the third drum of it. A lot number is party code,
 * item code and PR number run together, so neither `/` nor `#` can be part
 * of one. Spaces a scanner adds are dropped.
 */
export function parseDrumCode(raw: string): { lot: string; seq: number | null } | null {
  const code = raw.trim().replace(/\s+/g, "");
  if (!code) return null;
  const m = code.match(/^(.+?)[/#](\d{1,4})$/);
  if (m) {
    const seq = Number(m[2]);
    return seq > 0 ? { lot: m[1], seq } : null;
  }
  return { lot: code, seq: null };
}

/** Where a newly emptied drum goes: the lot's owner decides, and no owner means a person must. */
export function routeDrum(ownership: DrumOwnership | null): DrumStatus {
  if (ownership === "mahek") return "available";
  if (ownership === "vendor") return "returnable";
  return "review";
}

/**
 * The drum of a lot a scan stands for. A code naming its drum is that drum —
 * refused if it is beyond the lot's count or already registered; a code naming
 * only the lot takes the lowest number not yet registered.
 */
export function pickDrumSeq(
  drums: number | null,
  taken: number[],
  asked: number | null,
): { seq: number } | { refusal: string; existing?: number } {
  if (!drums || drums <= 0) return { refusal: "This lot's GRN records no drums, so its drums cannot be registered here. Ask the Production Head." };
  const used = new Set(taken);
  if (asked != null) {
    if (asked > drums) return { refusal: `This lot came in ${drums} drum${drums === 1 ? "" : "s"}; there is no drum ${asked}.` };
    if (used.has(asked)) return { refusal: `Drum ${asked} of this lot is already recorded as empty.`, existing: asked };
    return { seq: asked };
  }
  for (let s = 1; s <= drums; s++) if (!used.has(s)) return { seq: s };
  return { refusal: `All ${drums} drum${drums === 1 ? "" : "s"} of this lot are already recorded as empty.` };
}

/** A weight is a positive number inside the configured limits, or it needs an approved exception. */
export function weightCheck(kg: number | null, minKg: number, maxKg: number): { ok: true } | { ok: false; missing: boolean; reason: string } {
  if (kg == null || !Number.isFinite(kg) || kg <= 0) return { ok: false, missing: true, reason: "Enter the empty drum's weight in kg." };
  if (kg < minKg) return { ok: false, missing: false, reason: `${kg} kg is below the ${minKg} kg an empty drum is expected to weigh.` };
  if (kg > maxKg) return { ok: false, missing: false, reason: `${kg} kg is above the ${maxKg} kg an empty drum is expected to weigh.` };
  return { ok: true };
}

/** Actual empty weight − supplier-declared tare. Null where the GRN declared none. */
export function tareVariance(actualKg: number, declaredKg: number | null): { kg: number; pct: number | null } | null {
  if (declaredKg == null || !Number.isFinite(declaredKg)) return null;
  const kg = Math.round((actualKg - declaredKg) * 1000) / 1000;
  const pct = declaredKg > 0 ? Math.round((kg / declaredKg) * 1000) / 10 : null;
  return { kg, pct };
}

export const highVariance = (v: { kg: number } | null, alertKg: number): boolean => v != null && alertKg > 0 && Math.abs(v.kg) >= alertKg;

/* --------------------------------------------------------- moving drums */

/**
 * The moves a person (rather than a sale or a return) may make. Sold and
 * returned drums have left the building; a cancelled one is history.
 */
export function drumMoveRefusal(from: DrumStatus, to: "cancelled" | "decide" | "correct"): string | null {
  if (from === "sold") return "This drum has been sold.";
  if (from === "returned") return "This drum has been returned to its vendor.";
  if (from === "cancelled") return "This drum record is cancelled.";
  if (to === "decide" && from !== "review") return "This drum's ownership is already decided.";
  return null;
}

/**
 * The oldest `qty` records, by when they were emptied (then by number, so two
 * drums emptied in one minute still have an order). Refuses rather than
 * part-fills: a sale or a return of more than there is is a mistake to fix,
 * not a smaller transaction to record.
 */
export function fifoPick<T extends { emptiedAt: string | Date; drumNo: number }>(rows: T[], qty: number): { picked: T[] } | { refusal: string } {
  if (!Number.isInteger(qty) || qty <= 0) return { refusal: "Enter a whole number of drums." };
  if (qty > rows.length) return { refusal: `Only ${rows.length} drum${rows.length === 1 ? " is" : "s are"} available.` };
  const sorted = [...rows].sort((a, b) => {
    const t = new Date(a.emptiedAt).getTime() - new Date(b.emptiedAt).getTime();
    return t !== 0 ? t : a.drumNo - b.drumNo;
  });
  return { picked: sorted.slice(0, qty) };
}

/* ----------------------------------------------------------- the sale */

export function saleAmount(quantity: number, ratePaise: number): number {
  return Math.round(quantity * ratePaise);
}

export type SalePayState = "Unpaid" | "Partially paid" | "Paid" | "Cancelled";

export function salePayState(amountPaise: number, receivedPaise: number, cancelled: boolean): SalePayState {
  if (cancelled) return "Cancelled";
  if (receivedPaise <= 0) return amountPaise === 0 ? "Paid" : "Unpaid";
  return receivedPaise >= amountPaise ? "Paid" : "Partially paid";
}

/** Outstanding = sale amount − payments allocated, never below nothing. */
export const outstanding = (amountPaise: number, receivedPaise: number): number => Math.max(0, amountPaise - receivedPaise);

/**
 * Whether what a sale says about its invoice is honest. An invoiced sale
 * names its invoice number; a sale without one may carry a genuine challan or
 * reference, and never a made-up invoice number.
 */
export function invoiceRefusal(kind: "invoice" | "none", ref: string | null): string | null {
  if (kind === "invoice" && !ref) return "An invoiced sale needs the external invoice number.";
  return null;
}

/* ------------------------------------------------------ receipts & ageing */

/**
 * How much of a receipt may go to a sale: no more than the receipt has left
 * and no more than the sale still owes.
 */
export function allocationRefusal(amountPaise: number, receiptLeftPaise: number, saleOwedPaise: number): string | null {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) return "Enter an amount above zero.";
  if (amountPaise > receiptLeftPaise) return "That is more than is left unallocated on this receipt.";
  if (amountPaise > saleOwedPaise) return "That is more than the sale still owes.";
  return null;
}

/** A receipt spread over a buyer's open sales, oldest first, until either runs out. */
export function spreadOldestFirst(receiptPaise: number, sales: { id: string; owedPaise: number }[]): { saleId: string; amountPaise: number }[] {
  let left = receiptPaise;
  const out: { saleId: string; amountPaise: number }[] = [];
  for (const s of sales) {
    if (left <= 0) break;
    const take = Math.min(left, s.owedPaise);
    if (take > 0) {
      out.push({ saleId: s.id, amountPaise: take });
      left -= take;
    }
  }
  return out;
}

export const AGEING_BUCKETS = ["Current", "1–7", "8–15", "16–30", "31–60", "60+"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** Days past due (or past the sale, where it has no due date), into the buckets the ledger reports. */
export function ageingBucket(daysPast: number): AgeingBucket {
  if (daysPast <= 0) return "Current";
  if (daysPast <= 7) return "1–7";
  if (daysPast <= 15) return "8–15";
  if (daysPast <= 30) return "16–30";
  if (daysPast <= 60) return "31–60";
  return "60+";
}

/** Whole days from one ISO date to another. */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7)) - 1, Number(fromIso.slice(8, 10)));
  const b = Date.UTC(Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)) - 1, Number(toIso.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/* ---------------------------------------------- the stock of other scrap */

/** Collected less sold, per category and unit — a sale may not take more than is there. */
export function otherScrapBalance(
  collected: { category: string; unit: string; quantity: number }[],
  sold: { category: string; unit: string; quantity: number }[],
): Map<string, number> {
  const m = new Map<string, number>();
  const key = (c: string, u: string) => `${c}|${u}`;
  for (const r of collected) m.set(key(r.category, r.unit), (m.get(key(r.category, r.unit)) ?? 0) + r.quantity);
  for (const r of sold) m.set(key(r.category, r.unit), (m.get(key(r.category, r.unit)) ?? 0) - r.quantity);
  for (const [k, v] of m) m.set(k, Math.round(v * 1000) / 1000);
  return m;
}
