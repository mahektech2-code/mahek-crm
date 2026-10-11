/* ---------------------------------------------------------------------------
 * MATERIAL RETURNS, the rules — PURE, no I/O.
 *
 * Two transaction types that share one principle: a FINANCIAL document
 * adjusts the ledger, a PHYSICAL one adjusts stock, and neither does the
 * other's job.
 *
 *   Vendor   GRN lot → Purchase return → Approval → Debit note (no stock)
 *            → Goods return outward → Confirmed (stock minus)
 *
 *   Customer Dispatched order line → Customer return → Return inward
 *            (quarantine, no saleable stock) → Credit note (no stock)
 *            → QC disposition: reuse → FG · rework → SFG · chemical scrap ·
 *            waste disposal
 *
 * Quantities: a vendor return is in the GRN lot's PURCHASE unit (Kg, Litre or
 * Pcs) and its stock movement in the ledger's unit (litres or pieces). A
 * customer return is in the unit its lot was allocated in: cans from an FG
 * lot, boxes from a packing batch.
 * ------------------------------------------------------------------------- */

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/* ---------------------------------------------------------------- reasons */

export const VENDOR_RETURN_REASONS = [
  { code: "quality_defect", label: "Quality defect" },
  { code: "damaged", label: "Damaged material" },
  { code: "wrong_material", label: "Wrong material" },
  { code: "wrong_spec", label: "Wrong specification" },
  { code: "other", label: "Other" },
] as const;

export const CUSTOMER_RETURN_REASONS = [
  { code: "quality_defect", label: "Quality defect" },
  { code: "damaged", label: "Damaged / leaking" },
  { code: "wrong_product", label: "Wrong product" },
  { code: "wrong_spec", label: "Wrong specification" },
  { code: "excess", label: "Excess / not needed" },
  { code: "other", label: "Other" },
] as const;

export type VendorReason = (typeof VENDOR_RETURN_REASONS)[number]["code"];
export type CustomerReason = (typeof CUSTOMER_RETURN_REASONS)[number]["code"];

export function reasonLabel(code: string, side: "vendor" | "customer"): string {
  const list = side === "vendor" ? VENDOR_RETURN_REASONS : CUSTOMER_RETURN_REASONS;
  return (list as readonly { code: string; label: string }[]).find((r) => r.code === code)?.label ?? code;
}

export function reasonByLabel(label: string, side: "vendor" | "customer"): string | null {
  const list = side === "vendor" ? VENDOR_RETURN_REASONS : CUSTOMER_RETURN_REASONS;
  return (list as readonly { code: string; label: string }[]).find((r) => r.label === label.trim())?.code ?? null;
}

/**
 * The complaint category a customer return's credit note is filed under, as
 * the business label `createComplaint` takes — so the credit note sits on the
 * customer's complaints with everything else that was asked of them.
 */
export function complaintCategoryFor(reason: string): string {
  switch (reason) {
    case "quality_defect":
    case "wrong_spec":
      return "Product Quality";
    case "damaged":
      return "Leakage / Packaging";
    case "wrong_product":
      return "Wrong Product";
    default:
      return "Other";
  }
}

/* ------------------------------------------------------------- dispositions */

export const DISPOSITIONS = [
  { code: "reuse", label: "Reusable as is", sub: "Back into the existing FG stock, same item and lot." },
  { code: "rework", label: "Rework", sub: "Through the existing SFG process, then filling and packing as usual." },
  { code: "scrap", label: "Chemical scrap", sub: "Into the scrap module as Chemical Scrap, to be sold at a scrap rate." },
  { code: "waste", label: "Waste disposal", sub: "Cannot be reused or sold: disposed of and recorded." },
] as const;

export type Disposition = (typeof DISPOSITIONS)[number]["code"];

export const dispositionLabel = (code: string): string => DISPOSITIONS.find((d) => d.code === code)?.label ?? code;
export const dispositionByLabel = (label: string): Disposition | null => DISPOSITIONS.find((d) => d.label === label.trim())?.code ?? null;

/** The scrap category the scrap module keeps returned chemical under. */
export const CHEMICAL_SCRAP = "Chemical Scrap";

/* ------------------------------------------------------------------ money */

export type ReturnValue = {
  amountPaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  totalPaise: number;
};

/**
 * What a return is worth: quantity × rate, less the line's discount, with GST
 * on what is left. No rate, no figure — a debit or credit note is never
 * written on a guess.
 */
export function returnValue(p: { qty: number; ratePaise: number | null; gstBp: number; discountBp?: number | null }): ReturnValue | null {
  if (p.ratePaise == null || !(p.qty > 0)) return null;
  const amountPaise = Math.round(p.qty * p.ratePaise);
  const discountPaise = Math.round((amountPaise * (p.discountBp ?? 0)) / 10000);
  const taxablePaise = amountPaise - discountPaise;
  const taxPaise = Math.round((taxablePaise * (p.gstBp || 0)) / 10000);
  return { amountPaise, discountPaise, taxablePaise, taxPaise, totalPaise: taxablePaise + taxPaise };
}

/* ------------------------------------------------------------- quantities */

/**
 * A vendor return's quantity in the stock ledger's unit. The register holds a
 * kg lot in litres by its density, so a kg return without one cannot be
 * turned into stock and says so (null).
 */
export function toStockQty(qty: number, unit: string, density: number | null): number | null {
  if (unit === "Kg") return density && density > 0 ? r3(qty / density) : null;
  return r3(qty);
}

/** What is left of a lot to return: the lot less what live returns already claim. */
export function returnableQty(lotQty: number, alreadyReturned: number): number {
  return Math.max(0, r3(lotQty - alreadyReturned));
}

/** Why a vendor return of this quantity cannot be raised, or null. */
export function vendorReturnRefusal(p: { qty: number; returnable: number; onShelf: number | null }): string | null {
  if (!(p.qty > 0)) return "Enter the quantity to return.";
  if (p.qty > p.returnable + 1e-9) return `Only ${p.returnable} of this lot is left to return — the rest is already on another return.`;
  if (p.onShelf != null && p.qty > p.onShelf + 1e-9) return `Only ${p.onShelf} of this lot is in stock now — the rest has been used.`;
  return null;
}

/** Litres in a customer return: cans × can size, or boxes × cans a box × can size. */
export function returnLitres(p: { qty: number; lotFrom: "fg" | "pack"; cansPerBox: number; millilitres: number }): number {
  const cans = p.lotFrom === "pack" ? p.qty * Math.max(1, p.cansPerBox) : p.qty;
  return r3((cans * p.millilitres) / 1000);
}

/** Cans in a customer return, whichever unit it was allocated in. */
export function returnCans(p: { qty: number; lotFrom: "fg" | "pack"; cansPerBox: number }): number {
  return p.lotFrom === "pack" ? p.qty * Math.max(1, p.cansPerBox) : p.qty;
}

/** Why a customer return of this quantity cannot be raised, or null. */
export function customerReturnRefusal(p: { qty: number; dispatched: number; alreadyReturned: number; whole: boolean }): string | null {
  if (!(p.qty > 0)) return "Enter the quantity being returned.";
  if (p.whole && !Number.isInteger(p.qty)) return "Cans and boxes come back whole: enter a whole number.";
  const left = r3(p.dispatched - p.alreadyReturned);
  if (p.qty > left + 1e-9) return left <= 0 ? "Everything sent on this line is already on a return." : `Only ${left} were sent on this line and are not already on a return.`;
  return null;
}

/* --------------------------------------------------------------- approval */

/**
 * How many approvals a return needs. Above the configured limit it needs the
 * owner as well (an ERP administrator); a limit of 0 switches the second step
 * off.
 */
export function approvalSteps(totalPaise: number | null, limitPaise: number): 1 | 2 {
  return limitPaise > 0 && totalPaise != null && totalPaise > limitPaise ? 2 : 1;
}

/**
 * Why this person cannot give the approval the return is waiting for, or
 * null. The first approval needs the power and is never the requester's
 * (an ERP administrator excepted); the owner's needs an administrator.
 */
export function approvalRefusal(p: {
  step: 1 | 2;
  actorId: string;
  requesterId: string | null;
  firstApproverId: string | null;
  administrator: boolean;
  hasPower: boolean;
}): string | null {
  if (p.step === 1) {
    if (!p.hasPower && !p.administrator) return "Approving a return needs the returns power.";
    if (p.requesterId === p.actorId && !p.administrator) return "Somebody other than whoever raised the return approves it.";
    return null;
  }
  if (!p.administrator) return "Above the owner-approval limit, the owner (an ERP administrator) approves it too.";
  return null;
}

/* ------------------------------------------------------------------ stages */

export type VendorStage = "awaiting_approval" | "awaiting_owner" | "to_dispatch" | "outward_drafted" | "dispatched" | "rejected" | "cancelled";

export const VENDOR_STAGE_LABEL: Record<VendorStage, string> = {
  awaiting_approval: "Awaiting approval",
  awaiting_owner: "Awaiting owner approval",
  to_dispatch: "Debit note issued · to dispatch",
  outward_drafted: "Outward prepared · not confirmed",
  dispatched: "Returned to vendor",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export function vendorReturnStage(r: { status: string; needsOwner: boolean; ownerApproved: boolean }, outward: { status: string } | null): VendorStage {
  if (r.status === "cancelled") return "cancelled";
  if (r.status === "rejected") return "rejected";
  if (r.status === "pending") return "awaiting_approval";
  if (r.needsOwner && !r.ownerApproved) return "awaiting_owner";
  if (outward?.status === "confirmed") return "dispatched";
  if (outward?.status === "draft") return "outward_drafted";
  return "to_dispatch";
}

export type CustomerStage = "awaiting_receipt" | "in_quarantine" | "partly_disposed" | "closed" | "rejected" | "cancelled";

export const CUSTOMER_STAGE_LABEL: Record<CustomerStage, string> = {
  awaiting_receipt: "Awaiting receipt",
  in_quarantine: "In quarantine · awaiting QC",
  partly_disposed: "Partly decided by QC",
  closed: "Closed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export function customerReturnStage(r: { status: string; received: number | null; disposed: number }): CustomerStage {
  if (r.status === "cancelled") return "cancelled";
  if (r.status === "rejected") return "rejected";
  if (r.received == null) return "awaiting_receipt";
  if (r.disposed <= 0) return "in_quarantine";
  if (r.disposed + 1e-9 < r.received) return "partly_disposed";
  return "closed";
}

/** What the credit note has got to, in words, from the complaint that carries it. */
export function creditNoteWord(cnStatus: string | null | undefined, raised: boolean): string {
  if (!raised) return "Not raised";
  switch (cnStatus) {
    case "issued":
      return "Issued";
    case "rejected":
      return "Refused";
    default:
      return "With accounts";
  }
}

/* ------------------------------------------------------------- disposition */

/** What is still in quarantine: received, less what QC has decided and not reversed. */
export function quarantineLeft(received: number | null, decided: { qty: number; status: string }[]): number {
  if (received == null) return 0;
  return r3(received - decided.filter((d) => d.status !== "reversed").reduce((a, d) => a + d.qty, 0));
}

/** Why QC cannot record this decision, or null. */
export function dispositionRefusal(p: {
  kind: Disposition;
  qty: number;
  left: number;
  whole: boolean;
  godownId: string | null;
  scrapKg: number | null;
  wasteReason: string | null;
}): string | null {
  if (!(p.qty > 0)) return "Enter how much this decision covers.";
  if (p.whole && !Number.isInteger(p.qty)) return "Cans and boxes are decided whole: enter a whole number.";
  if (p.qty > p.left + 1e-9) return p.left <= 0 ? "Nothing is left in quarantine on this return." : `Only ${p.left} is still in quarantine.`;
  if ((p.kind === "reuse" || p.kind === "scrap" || p.kind === "rework") && !p.godownId) return "Choose the godown it goes to.";
  if (p.kind === "scrap" && !(p.scrapKg != null && p.scrapKg > 0)) return "Weigh the chemical scrap and enter its kg.";
  if (p.kind === "waste" && !(p.wasteReason && p.wasteReason.trim().length >= 10)) return "Say why it cannot be reused or sold as scrap (10 characters or more).";
  return null;
}

export type ReworkFigures = { lossLitres: number; lossPercent: number };

/** A rework's process loss. Output above input is refused: rework does not make liquid. */
export function reworkFigures(inputLitres: number, outputLitres: number): ReworkFigures | { refusal: string } {
  if (!(inputLitres > 0)) return { refusal: "The rework has no input." };
  if (!(outputLitres >= 0)) return { refusal: "Enter the litres recovered (0 if nothing was)." };
  if (outputLitres > inputLitres + 1e-9) return { refusal: `Recovered ${outputLitres} L cannot exceed the ${inputLitres} L that went in.` };
  const lossLitres = r3(inputLitres - outputLitres);
  return { lossLitres, lossPercent: Math.round((lossLitres / inputLitres) * 1000) / 10 };
}

/** The SFG lot code a rework's recovered liquid is posted under: its own, so QC decides it like any batch. */
export const reworkLotCode = (reworkNo: number) => `RW${reworkNo}`;

/* ------------------------------------------------------------------ labels */

export const purchaseReturnLabel = (n: number) => `PRN-${n}`;
export const debitNoteLabel = (n: number) => `DN-${n}`;
export const returnOutwardLabel = (n: number) => `RTO-${n}`;
export const customerReturnLabel = (n: number) => `CRN-${n}`;
export const reworkLabel = (n: number) => `RWK-${n}`;
export const wasteLabel = (n: number) => `WST-${n}`;
