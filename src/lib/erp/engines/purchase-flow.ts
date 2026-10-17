/* ---------------------------------------------------------------------------
 * THE PURCHASE FLOW, as rules (PURE, client-safe):
 *
 *   Requirement → Blind count → Vendor → Approval → PO → Receipt
 *
 * THE BLIND COUNT (Inventory Accuracy Control, `stock-check.ts`) holds a
 * requirement that carries `stockCheckRequired` only until the count is
 * ENTERED. A count that differs from the book flags the requirement and
 * tells stock control; the purchase goes on to its vendor regardless.
 *
 * Every requirement is bought DIRECT: the vendor is picked (the item's
 * default vendor is offered) and the PO is raised. Supplier rates are kept on
 * the Quotation manager, never on a requirement — the quotation step that
 * used to sit here is gone.
 * NO PURCHASE IS COMPLETED WITHOUT A PO: goods inward and a register row both
 * name an approved PO's line.
 *
 * One file says where a requirement has got to, what a PO is worth and what a
 * receipt does to it — so the list, the drawer, the dashboard tile and the
 * form summary read one answer.
 * ------------------------------------------------------------------------- */

/** The steps the flow is drawn as, in order. */
export const FLOW_STEPS = ["Requirement", "Blind count", "Vendor", "Approval", "Purchase order", "Receipt"] as const;

/** A PO that still stands — one that was cancelled or sent back no longer holds its requirements. */
export const LIVE_PO = ["Pending approval", "Approved", "Sent", "Partly received", "Received", "Closed"];
/** A PO goods may be received against. */
export const RECEIVABLE_PO = ["Approved", "Sent", "Partly received"];

export type RequirementState = {
  status: string;
  supplierId: string | null;
  /** The live PO this requirement is on, with what was ordered and what has arrived. */
  po: { status: string; ordered: number; received: number } | null;
  /** A requirement from before POs, already ordered or received the old way. */
  legacy: boolean;
  /** The blind count's verdict on it (`stockGate`): it blocks only while the count is not yet entered. */
  gate?: { blocks: boolean; stage: string | null; next: string | null } | null;
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
  if (r.gate?.blocks) {
    return { stage: r.gate.stage ?? "Blind count", step: 1, next: r.gate.next ?? "Count the stock before choosing the vendor.", readyForPo: false };
  }
  if (!r.supplierId) return { stage: "Select vendor", step: 2, next: "Select the vendor to buy from.", readyForPo: false };
  return { stage: "Ready for PO", step: 3, next: "Raise the purchase order; it goes for approval.", readyForPo: true };
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

/** The purchase unit of an item: what a requirement, a PO and the register all count it in. */
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

/* ------------------------------------------------- a requirement of many items */

/** A requirement's number, as every screen prints it. */
export function requirementLabel(n: number): string {
  return `REQ-${n}`;
}

/**
 * The label each item is picked by on a requirement. The item master keeps a
 * name unique only within its category, so a name two categories share is
 * told apart by the category; every other item is its plain name.
 */
export function itemPickLabels(items: { name: string; materialType: string }[]): Map<string, { name: string; type: string }> {
  const count = new Map<string, number>();
  items.forEach((m) => count.set(m.name.toLowerCase(), (count.get(m.name.toLowerCase()) ?? 0) + 1));
  const out = new Map<string, { name: string; type: string }>();
  for (const m of items) {
    const label = (count.get(m.name.toLowerCase()) ?? 0) > 1 ? `${m.name} · ${m.materialType}` : m.name;
    out.set(label, { name: m.name, type: m.materialType });
  }
  return out;
}

export type PastedLine = { item: string; qty: string };
export type PasteResult = { lines: PastedLine[]; unmatched: string[]; duplicates: string[] };

/**
 * A list pasted from a spreadsheet or typed one per row — "Toluene, 200",
 * "MEK<tab>50", "Tin can 5L 120" — read into requirement lines. The quantity
 * is the LAST number on the row; everything before it names the item, matched
 * to the offered labels exactly (ignoring case), then to the one label that
 * contains it. A row that names nothing offered is returned unmatched rather
 * than guessed, and an item already on the requirement or earlier in the
 * paste is a duplicate, not a second line.
 */
export function parsePastedLines(text: string, labels: string[], already: string[] = []): PasteResult {
  const lower = labels.map((l) => [l.toLowerCase(), l] as const);
  const seen = new Set(already.map((a) => a.toLowerCase()));
  const out: PasteResult = { lines: [], unmatched: [], duplicates: [] };
  for (const raw of text.split(/\r?\n/)) {
    const row = raw.trim();
    if (!row) continue;
    const m = row.match(/^(.*?)[\s,;\t]+(-?\d+(?:[.,]\d+)?)\s*[A-Za-z.]*\s*$/);
    const name = (m ? m[1] : row).replace(/[\s,;\t]+$/, "").trim();
    const qty = m ? m[2].replace(",", ".") : "";
    if (!name) continue;
    const key = name.toLowerCase();
    let label = lower.find(([l]) => l === key)?.[1];
    if (!label) {
      const hits = key.length >= 3 ? lower.filter(([l]) => l.includes(key)) : [];
      if (hits.length === 1) label = hits[0][1];
    }
    if (!label) {
      out.unmatched.push(row);
      continue;
    }
    if (seen.has(label.toLowerCase())) {
      out.duplicates.push(label);
      continue;
    }
    seen.add(label.toLowerCase());
    out.lines.push({ item: label, qty });
  }
  return out;
}
