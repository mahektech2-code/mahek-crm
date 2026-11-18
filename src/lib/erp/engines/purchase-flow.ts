import { roundBill } from "@/lib/bill-round";

/* ---------------------------------------------------------------------------
 * THE PURCHASE FLOW, as rules (PURE, client-safe):
 *
 *   Requirement → Purchase method → PO number → Receipt
 *
 * THE PO NUMBER COMES FROM THE QUOTATION MANAGER (Oct 2026, a reversal).
 * The admin marks the rate to buy there (Ready to buy) and the desk buys it
 * with the PO number made in Tally, so the ERP no longer asks for a vendor,
 * compares quotations or approves a PO of its own: the requirement is given
 * that PO number, everything else is fetched from the bought cell
 * (`pickQuotePoCell`), and goods are received against it. A requirement
 * already on the old path (a vendor chosen, a PO awaiting approval) finishes
 * on it.
 *
 * THERE IS NO COUNT IN IT (Nov 2026, a reversal). A requirement used to open a
 * blind count of its item and wait until the count was entered — Blind count,
 * Book comparison and Verification were three steps of this flow. Mahek took
 * them out: a requirement goes straight to its purchase method. Stock is still
 * counted on Stock accuracy (cycle counts, floor checks), on its own clock and
 * never in front of a purchase. `stock_check_required` on old rows is read by
 * nothing.
 *
 * The item master's PURCHASE RULE decides the method — direct purchase,
 * quotation, or the buyer decides — and it is copied onto the requirement
 * when it is raised. A quotation is required only where that rule says so.
 * NO PURCHASE IS COMPLETED WITHOUT A PO: goods inward and a register row both
 * name an approved PO's line.
 *
 * One file says where a requirement has got to, what a PO is worth and what a receipt does to it — so the list, the record,
 * the dashboard tile and the form summary read one answer.
 * ------------------------------------------------------------------------- */

export type PurchaseMethod = "direct" | "quotation" | "buyer";

export const PURCHASE_METHODS: { v: PurchaseMethod; label: string; sub: string }[] = [
  { v: "direct", label: "Direct purchase", sub: "No quotation: create the PO on the requirement, to the item's default vendor. Regular boxes, cans, stationery and the routine chemicals." },
  { v: "quotation", label: "Quotation", sub: "Rates are compared and bought on the Quotation manager, which makes the PO number; the requirement links that number. Price-sensitive chemicals." },
  { v: "buyer", label: "Buyer decision", sub: "Decided requirement by requirement: create the PO on it, or link a PO number from the Quotation manager." },
];

/**
 * HOW A REQUIREMENT GETS ITS PO, read off the item's purchase rule (copied on
 * raise): a Quotation item is bought on the Quotation manager and LINKS the PO
 * number made there; a Direct purchase item needs no quotation and CREATES its
 * PO on the requirement. A Buyer-decision item, or one an old buyer decision
 * left open, may do either.
 */
export type PoRoute = "link" | "create" | "either";

export function poRouteOf(r: Pick<RequirementState, "rule" | "method">): PoRoute {
  const m = r.method ?? (r.rule === "buyer" ? null : r.rule);
  return m === "quotation" ? "link" : m === "direct" ? "create" : "either";
}

export function methodLabel(m: string | null | undefined): string {
  return PURCHASE_METHODS.find((x) => x.v === m)?.label ?? "—";
}

export function methodByLabel(label: string | null | undefined): PurchaseMethod | null {
  return PURCHASE_METHODS.find((x) => x.label === label || x.v === label)?.v ?? null;
}

/** The steps the flow is drawn as, in order. */
export const FLOW_STEPS = ["Requirement", "Purchase method", "PO number", "Receipt"] as const;

/** Where each step sits in FLOW_STEPS — named, so a step moved in the list moves every reader. */
export const STEP = { method: 1, po: 2, receipt: 3 } as const;

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
  /** The live PO this requirement is on, with what was ordered and what has arrived. */
  po: { status: string; ordered: number; received: number; done?: boolean } | null;
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
    const lineDone = !!r.po.done;
    /* A PO raised the old way, still waiting on its approver. */
    if (status === "Pending approval") return { stage: "PO awaiting approval", step: STEP.po, next: "The approver approves the PO or sends it back.", readyForPo: false };
    if (status === "Closed") return { stage: received > 0 ? "Closed short" : "Closed", step: done, next: "The PO was closed; nothing more is expected.", readyForPo: false };
    if (status === "Received" || lineDone || (ordered > 0 && received >= ordered)) return { stage: "Received", step: done, next: "Received in full.", readyForPo: false };
    if (received > 0) return { stage: "Partly received", step: STEP.receipt, next: "Receive the rest against the PO, or close it short.", readyForPo: false };
    return { stage: "Waiting for goods", step: STEP.receipt, next: "Receive the goods against the PO number at the gate.", readyForPo: false };
  }
  if (r.legacy) {
    if (r.status === "Received") return { stage: "Received", step: done, next: "Received before POs were kept in the ERP.", readyForPo: false };
    return { stage: `${r.status} (before POs)`, step: STEP.receipt, next: "Ordered before POs were kept in the ERP. Receive it as it arrives, or cancel it.", readyForPo: false };
  }
  /* Raised: the next thing owed is the PO — by the item's rule. */
  const route = poRouteOf(r);
  if (route === "link")
    return { stage: "Waiting for PO number", step: STEP.method, next: "Buy it on the Quotation manager, then link the PO number it made here.", readyForPo: false };
  if (route === "create")
    return { stage: "Create PO", step: STEP.method, next: "Direct purchase — no quotation. Create the PO here.", readyForPo: true };
  return { stage: "Create or link PO", step: STEP.method, next: "Buyer decision — create the PO here, or link a PO number from the Quotation manager.", readyForPo: true };
}

/* ------------------------------------------------- the Quotation manager's PO */

/** A PO number as it is compared: spaces squeezed, case ignored. The number is stored as it was typed on the Quotation manager. */
export function normalisePoNo(s: string): string {
  return s.trim().replace(/\s+/g, " ").toUpperCase();
}

/** A rate as the Quotation manager holds it — text somebody typed — read as rupees: "89.5", "₹ 89.50/kg". Null where there is no positive number. */
export function quoteRatePaise(value: string): number | null {
  const m = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const p = Math.round(Number(m[0]) * 100);
  return p > 0 ? p : null;
}

export type QuotePoCell = {
  rowId: string;
  columnId: string;
  materialId: string | null;
  /** "Drum · Toluene · Reliance" — the column as the sheet heads it. */
  material: string;
  party: string;
  supplierId: string | null;
  value: string;
  status: string | null;
  rowStatus: string | null;
  drums: number | null;
  poNo: string;
  quotedOn: string;
  boughtBy: string | null;
  boughtAt: string | null;
};

/**
 * Which bought cell a PO number gives a requirement for this item, or the
 * sentence that says why none does. Bought is Purchase it (`po`) or picked up
 * (`pickup`); a cancelled cell or row bought nothing. Where one PO number
 * carries the item twice, the newest purchase is the one.
 */
export function pickQuotePoCell(
  cells: QuotePoCell[],
  materialId: string,
  item: string,
  poNo: string,
): { ok: true; cell: QuotePoCell; ratePaise: number } | { ok: false; error: string } {
  const shown = poNo.trim();
  if (!cells.length) return { ok: false, error: `No PO numbered ${shown} on the Quotation manager. Check the number, or buy it there first.` };
  const bought = cells.filter((c) => (c.status === "po" || c.status === "pickup") && c.rowStatus !== "cancel");
  if (!bought.length) return { ok: false, error: `PO ${shown} is marked cancelled on the Quotation manager.` };
  const mine = bought.filter((c) => c.materialId === materialId).sort((a, b) => String(b.boughtAt).localeCompare(String(a.boughtAt)));
  if (!mine.length) {
    const named = [...new Set(bought.map((c) => c.material))].join(", ");
    return { ok: false, error: `PO ${shown} on the Quotation manager is for ${named} — not ${item}.` };
  }
  const cell = mine[0];
  if (!cell.supplierId) return { ok: false, error: `The party "${cell.party}" on that row is not one of the Purchase parties. Pick it from the list on the Quotation manager first.` };
  const ratePaise = quoteRatePaise(cell.value);
  if (ratePaise == null) return { ok: false, error: `The rate for ${item} on PO ${shown} is "${cell.value}", which is not a number.` };
  return { ok: true, cell, ratePaise };
}

/* --------------------------------------------------------------------- POs */

export function poLabel(n: number): string {
  return `PO-${n}`;
}

/**
 * The ERP series number inside a PO number the Quotation manager made
 * ("PO-1243" → 1243), so the ERP PO created when a requirement is linked
 * carries the same number. Null for a number typed before they were made
 * (an older Tally number), which then takes a fresh one.
 */
export function seriesNumberOf(poNo: string): number | null {
  const m = /^PO-(\d{1,9})$/.exec(normalisePoNo(poNo));
  return m ? Number(m[1]) : null;
}

/** A PO's name on every screen: the Quotation manager's PO number where it came from there, else the ERP's own. */
export function poName(po: { poNumber: number; qmPoNo?: string | null }): string {
  return po.qmPoNo || poLabel(po.poNumber);
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
  /* A purchase order's total is a round figure, with its round off said (`lib/bill-round.ts`). */
  const { totalPaise, roundOffPaise } = roundBill(amount + gst + (freightPaise || 0));
  return { amountPaise: amount, gstPaise: gst, freightPaise: freightPaise || 0, roundOffPaise, totalPaise };
}

/* ------------------------------------------ what arrived, and the corrections */

/**
 * THE GOODS RECEIPT CORRECTS THE PO (Nov 2026, a reversal). Goods are weighed
 * and counted at the gate and never match the PO exactly; that is the trade.
 * The GRN used to refuse anything past the PO plus a tolerance and leave a
 * shortfall waiting until somebody closed the PO short. Now whatever arrived is
 * received, and the person making the GRN corrects the PO on the spot with a
 * CORRECTION LINE under the line it corrects — never by editing the line:
 *
 *   - more than the line still expects: the extra, +qty, at the line's rate;
 *   - less, and nothing more is coming: the shortfall, −qty, at the line's rate;
 *   - less, and more is coming: no correction; the line stays open.
 *
 * What a line EXPECTS is its quantity plus its live corrections, and it is
 * complete once that has arrived. The flagged difference compares the end
 * result with the ORIGINAL quantity, so a correction beyond the configured
 * percent is pointed out to the purchase desk. Nothing here refuses anything.
 */
export type CorrectionKind = "extra" | "short";

/** What the GRN asks about an extra: add it to the PO (the default), or leave the PO alone. */
export const EXTRA_OPTS = ["Add the extra to the PO at the same rate", "Leave the PO as it is"] as const;
/** What the GRN asks about a shortfall: the default changes nothing. */
export const SHORT_OPTS = ["More is coming: leave the PO as it is", "That is everything: take the rest off the PO"] as const;

/** What a line now expects: its own quantity plus every live correction under it. */
export function expectedQuantity(ordered: number, corrections: { quantity: number; cancelled?: boolean }[]): number {
  const sum = corrections.filter((c) => !c.cancelled).reduce((a, c) => a + c.quantity, 0);
  return Math.round((ordered + sum) * 1000) / 1000;
}

/** Where a receipt leaves a line: nothing to correct, an extra, or a shortfall that may or may not be made up. */
export function receiptGap(expected: number, receivedBefore: number, arriving: number): { kind: "exact" | "more" | "less"; quantity: number } {
  const pending = Math.round((expected - receivedBefore) * 1000) / 1000;
  const gap = Math.round((arriving - pending) * 1000) / 1000;
  if (gap > 0) return { kind: "more", quantity: gap };
  if (gap < 0) return { kind: "less", quantity: -gap };
  return { kind: "exact", quantity: 0 };
}

/**
 * The correction a receipt makes, or null. An extra is added unless the gate
 * said to leave the PO alone; a shortfall only where the gate said nothing
 * more is coming.
 */
export function correctionFor(
  gap: ReturnType<typeof receiptGap>,
  choice: { addExtra: boolean; nothingMoreComing: boolean },
): { kind: CorrectionKind; quantity: number } | null {
  if (gap.kind === "more" && choice.addExtra) return { kind: "extra", quantity: gap.quantity };
  if (gap.kind === "less" && choice.nothingMoreComing) return { kind: "short", quantity: -gap.quantity };
  return null;
}

export type ReceiptLine = { ordered: number; received: number };

/** Whether nothing more is waited for on this line: what it now expects has arrived (or more). */
export function lineDone(l: ReceiptLine): boolean {
  return l.received + 1e-9 >= l.ordered;
}

/** How far a figure differs from what was ordered, in percent of the order: +12 is 12% more, −8 is 8% less. One decimal. */
export function receiptDifferencePercent(ordered: number, actual: number): number {
  if (!(ordered > 0)) return 0;
  return Math.round(((actual - ordered) / ordered) * 1000) / 10;
}

/**
 * The flag a PO line earns, in words, or null: where the line ENDS — what it
 * now expects once corrected, or what arrived where that is more — differs
 * from its ORIGINAL quantity by more than `flagPercent`.
 */
export function quantityDifferenceNote(original: number, expected: number, received: number, flagPercent: number): string | null {
  const end = Math.max(expected, received);
  if (!(original > 0) || end === original) return null;
  const d = receiptDifferencePercent(original, end);
  if (Math.abs(d) <= Math.max(0, flagPercent)) return null;
  return d > 0 ? `${d}% more than ordered` : `${-d}% less than ordered`;
}

/**
 * Where a PO stands once goods have been received against it. Only the
 * receiving states move: an unapproved, closed, cancelled or rejected PO is
 * left as it is, and Approved stays Approved until something arrives (it was
 * received without having been marked sent, which still counts as sent).
 * `ordered` is what each line now EXPECTS, corrections included.
 */
export function poStatusAfterReceipt(status: string, lines: ReceiptLine[]): string {
  if (!["Approved", "Sent", "Partly received", "Received"].includes(status)) return status;
  const any = lines.some((l) => l.received > 0);
  if (!any) return status === "Approved" ? "Approved" : "Sent";
  const all = lines.every((l) => lineDone(l));
  return all ? "Received" : "Partly received";
}

/** The purchase unit of an item: what a requirement, a quotation, a PO and the register all count it in. */
export function purchaseUnit(itemUnit: string, materialType: string): "Kg" | "Litre" | "Pcs" {
  if (materialType === "Box") return "Pcs";
  if (itemUnit === "Kg") return "Kg";
  if (itemUnit === "Litre") return "Litre";
  return "Pcs";
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
