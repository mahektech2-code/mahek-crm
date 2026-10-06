/* ---------------------------------------------------------------------------
 * THE PURCHASE FLOW, as rules (PURE, client-safe):
 *
 *   Requirement → Purchase method → Vendor / Quotation → Approval → PO → Receipt
 *
 * The item master's PURCHASE RULE decides the method — direct purchase,
 * quotation, or the buyer decides — and it is copied onto the requirement
 * when it is raised. A quotation is required only where that rule says so.
 * NO PURCHASE IS COMPLETED WITHOUT A PO: goods inward and a register row both
 * name an approved PO's line.
 *
 * One file says where a requirement has got to, what a quotation lands at,
 * what a PO is worth and what a receipt does to it — so the list, the drawer,
 * the dashboard tile and the form summary read one answer.
 * ------------------------------------------------------------------------- */

export type PurchaseMethod = "direct" | "quotation" | "buyer";

export const PURCHASE_METHODS: { v: PurchaseMethod; label: string; sub: string }[] = [
  { v: "direct", label: "Direct purchase", sub: "Pick the vendor, raise the PO. Regular boxes, cans, stationery and the routine chemicals." },
  { v: "quotation", label: "Quotation", sub: "Collect quotations, compare them, select one, then raise the PO. Price-sensitive chemicals." },
  { v: "buyer", label: "Buyer decision", sub: "The buyer decides, requirement by requirement, whether it is a direct purchase or a quotation." },
];

export function methodLabel(m: string | null | undefined): string {
  return PURCHASE_METHODS.find((x) => x.v === m)?.label ?? "—";
}

export function methodByLabel(label: string | null | undefined): PurchaseMethod | null {
  return PURCHASE_METHODS.find((x) => x.label === label || x.v === label)?.v ?? null;
}

/** The six steps the flow is drawn as, in order. */
export const FLOW_STEPS = ["Requirement", "Purchase method", "Vendor / quotation", "Approval", "Purchase order", "Receipt"] as const;

/** A PO that still stands — one that was cancelled or sent back no longer holds its requirements. */
export const LIVE_PO = ["Pending approval", "Approved", "Sent", "Partly received", "Received", "Closed"];
/** A PO goods may be received against. */
export const RECEIVABLE_PO = ["Approved", "Sent", "Partly received"];

export type RequirementState = {
  status: string;
  /** The rule copied on raise; null on a requirement from before the rule, read as the item's rule now. */
  rule: PurchaseMethod;
  method: "direct" | "quotation" | null;
  supplierId: string | null;
  quotationId: string | null;
  quoteCount: number;
  minQuotations: number;
  /** The live PO this requirement is on, with what was ordered and what has arrived. */
  po: { status: string; ordered: number; received: number } | null;
  /** A requirement from before POs, already ordered or received the old way. */
  legacy: boolean;
};

export type Stage = {
  /** Words for the list and the chips. */
  stage: string;
  /** Index into FLOW_STEPS of the step waiting now; FLOW_STEPS.length when the flow is done; −1 when cancelled. */
  step: number;
  /** What happens next, in a sentence. */
  next: string;
  /** Whether this requirement may be put on a new PO. */
  readyForPo: boolean;
};

export function requirementStage(r: RequirementState): Stage {
  const done = FLOW_STEPS.length;
  if (r.status === "Cancelled") return { stage: "Cancelled", step: -1, next: "Cancelled — nothing more happens.", readyForPo: false };
  if (r.po) {
    const { status, ordered, received } = r.po;
    if (status === "Pending approval") return { stage: "PO awaiting approval", step: 3, next: "The approver approves the PO or sends it back.", readyForPo: false };
    if (status === "Approved") return { stage: "PO approved", step: 4, next: "Send the PO to the vendor.", readyForPo: false };
    if (status === "Closed") return { stage: received > 0 ? "Closed short" : "Closed", step: done, next: "The PO was closed; nothing more is expected.", readyForPo: false };
    if (status === "Received" || (ordered > 0 && received >= ordered)) return { stage: "Received", step: done, next: "Received in full.", readyForPo: false };
    if (received > 0) return { stage: "Partly received", step: 5, next: "Receive the rest against the PO, or close it short.", readyForPo: false };
    return { stage: "PO sent", step: 5, next: "Waiting for the goods. Receive them against the PO at the gate.", readyForPo: false };
  }
  if (r.legacy) {
    if (r.status === "Received") return { stage: "Received", step: done, next: "Received before POs were kept in the ERP.", readyForPo: false };
    return { stage: `${r.status} (before POs)`, step: 4, next: "Ordered before POs were kept in the ERP. Receive it as it arrives, or cancel it.", readyForPo: false };
  }
  if (!r.method) {
    return r.rule === "buyer"
      ? { stage: "Buyer decision", step: 1, next: "The buyer decides: direct purchase or quotation.", readyForPo: false }
      : { stage: "Buyer decision", step: 1, next: "Choose how this is bought.", readyForPo: false };
  }
  if (r.method === "quotation" && !r.quotationId) {
    if (r.quoteCount < r.minQuotations)
      return {
        stage: "Collect quotations",
        step: 2,
        next: `Collect quotations — ${r.quoteCount} of at least ${r.minQuotations}.`,
        readyForPo: false,
      };
    return { stage: "Compare quotations", step: 2, next: "Compare the quotations and select one.", readyForPo: false };
  }
  if (!r.supplierId) return { stage: "Select vendor", step: 2, next: "Select the vendor to buy from.", readyForPo: false };
  return { stage: "Ready for PO", step: 3, next: "Raise the purchase order; it goes for approval.", readyForPo: true };
}

/* ------------------------------------------------------------- quotations */

export type QuoteIn = { id: string; ratePaise: number; gstBp: number; freightPaise: number; validUntil: string | null };

export type QuoteFigures = { materialPaise: number; gstPaise: number; freightPaise: number; landedPaise: number; perUnitLandedPaise: number };

/** What a quotation lands at for the quantity required: material, its GST and the freight. */
export function quoteFigures(q: Pick<QuoteIn, "ratePaise" | "gstBp" | "freightPaise">, quantity: number): QuoteFigures {
  const materialPaise = Math.round(q.ratePaise * quantity);
  const gstPaise = Math.round((materialPaise * q.gstBp) / 10000);
  const landedPaise = materialPaise + gstPaise + (q.freightPaise || 0);
  return { materialPaise, gstPaise, freightPaise: q.freightPaise || 0, landedPaise, perUnitLandedPaise: quantity > 0 ? Math.round(landedPaise / quantity) : 0 };
}

export function quoteExpired(validUntil: string | null, today: string): boolean {
  return !!validUntil && validUntil < today;
}

/**
 * The quotations ranked by landed cost, cheapest first. An expired quotation
 * is ranked after every live one and can never be the lowest: a price the
 * vendor no longer stands behind is not a price.
 */
export function rankQuotes<T extends QuoteIn>(quotes: T[], quantity: number, today: string): (T & { fig: QuoteFigures; rank: number; lowest: boolean; expired: boolean })[] {
  const out = quotes.map((q) => ({ ...q, fig: quoteFigures(q, quantity), expired: quoteExpired(q.validUntil, today) }));
  out.sort((a, b) => Number(a.expired) - Number(b.expired) || a.fig.landedPaise - b.fig.landedPaise);
  return out.map((q, i) => ({ ...q, rank: i + 1, lowest: i === 0 && !q.expired }));
}

/* --------------------------------------------------------------------- POs */

export function poLabel(n: number): string {
  return `PO-${n}`;
}

export type PoLineIn = { quantity: number; ratePaise: number; gstBp: number };

export function poLineFigures(l: PoLineIn) {
  const amountPaise = Math.round(l.quantity * l.ratePaise);
  const gstPaise = Math.round((amountPaise * l.gstBp) / 10000);
  return { amountPaise, gstPaise, totalPaise: amountPaise + gstPaise };
}

export function poTotals(lines: PoLineIn[], freightPaise: number) {
  let amount = 0;
  let gst = 0;
  for (const l of lines) {
    const f = poLineFigures(l);
    amount += f.amountPaise;
    gst += f.gstPaise;
  }
  return { amountPaise: amount, gstPaise: gst, freightPaise: freightPaise || 0, totalPaise: amount + gst + (freightPaise || 0) };
}

/**
 * Where a PO stands once goods have been received against it. Only the
 * receiving states move: an unapproved, closed, cancelled or rejected PO is
 * left as it is, and Approved stays Approved until something arrives (it was
 * received without having been marked sent, which still counts as sent).
 */
export function poStatusAfterReceipt(status: string, lines: { ordered: number; received: number }[]): string {
  if (!["Approved", "Sent", "Partly received", "Received"].includes(status)) return status;
  const any = lines.some((l) => l.received > 0);
  if (!any) return status === "Approved" ? "Approved" : "Sent";
  const all = lines.every((l) => l.received >= l.ordered);
  return all ? "Received" : "Partly received";
}

/** The most that may still be received on a line: what is pending, plus the tolerance on what was ordered. */
export function receivableQuantity(ordered: number, received: number, tolerancePercent: number): number {
  const ceiling = ordered * (1 + Math.max(0, tolerancePercent) / 100);
  return Math.max(0, Math.round((ceiling - received) * 1000) / 1000);
}

/** The purchase unit of an item: what a requirement, a quotation, a PO and the register all count it in. */
export function purchaseUnit(itemUnit: string, materialType: string): "Kg" | "Litre" | "Pcs" {
  if (materialType === "Box") return "Pcs";
  if (itemUnit === "Kg") return "Kg";
  if (itemUnit === "Litre") return "Litre";
  return "Pcs";
}

/** The PO's text, sent to the vendor on WhatsApp or by email. Money in rupees, Indian grouping. */
export function poMessage(po: {
  number: number;
  date: string;
  vendor: string;
  deliverTo: string;
  deliveryDate: string;
  paymentTerms: string;
  freightPaise: number;
  remarks: string | null;
  lines: { item: string; quantity: number; unit: string; ratePaise: number; gstBp: number }[];
  company: string;
}): string {
  const rs = (p: number) => "₹" + (p / 100).toLocaleString("en-IN", { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 });
  const t = poTotals(po.lines, po.freightPaise);
  const rows = po.lines.map((l, i) => {
    const f = poLineFigures(l);
    return `${i + 1}. ${l.item} — ${l.quantity.toLocaleString("en-IN")} ${l.unit} @ ${rs(l.ratePaise)} + GST ${l.gstBp / 100}% = ${rs(f.totalPaise)}`;
  });
  return [
    `PURCHASE ORDER ${poLabel(po.number)}`,
    `${po.company}`,
    `Date: ${po.date}`,
    `To: ${po.vendor}`,
    ``,
    ...rows,
    ``,
    `Amount: ${rs(t.amountPaise)}`,
    `GST: ${rs(t.gstPaise)}`,
    ...(t.freightPaise ? [`Freight: ${rs(t.freightPaise)}`] : []),
    `Total: ${rs(t.totalPaise)}`,
    ``,
    `Deliver to: ${po.deliverTo}`,
    `Delivery by: ${po.deliveryDate}`,
    `Payment terms: ${po.paymentTerms}`,
    ...(po.remarks ? [`Note: ${po.remarks}`] : []),
    ``,
    `Please quote ${poLabel(po.number)} on your invoice and delivery challan.`,
  ].join("\n");
}
