/* ---------------------------------------------------------------------------
 * THE ORDER-TO-DELIVERY RULES (PRD v1.2), pure.
 *
 * An order line carries several businesses' answers at once — whether the back
 * office has checked what was entered, whether the goods are made, whether the
 * bill is in Tally and checked, whether it has left, and where the lorry is.
 * The PRD's rule 4 is that these are SEPARATE status domains and none may
 * overwrite another, so each is said here by its own function, from its own
 * facts, and the screens print them side by side.
 *
 * Storage did not have to change shape for that: `erp_orders.status` still
 * holds Under Process / Ready / Hold From Office / Cancel, because the godown,
 * the order book and the Factory app all read it. What changed is how it is
 * READ — Under Process and Ready are the production domain, and Hold and
 * Cancel are the order's, said in the order domain's words.
 * ------------------------------------------------------------------------- */

export const ORDER_SOURCES = ["WhatsApp", "Phone", "Sales Order", "Other"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

/** Pending | Verified | Correction — the back office's check of an entered order. */
export type OrderCheck = "Pending" | "Verified" | "Correction";
/** Pending | Approved | Rejected — the independent invoice check. */
export type InvoiceCheck = "Pending" | "Approved" | "Rejected";

/* ------------------------------------------------------------ the domains */

export type OrderFacts = {
  /** `erp_orders.status`: Under Process | Ready | Hold From Office | Cancel. */
  status: string;
  orderCheck: string;
  /** Billed: the line has its billing record. */
  billed: boolean;
  /** `erp_order_details.invoice_check`, where billed. */
  invoiceCheck: string | null;
  /** Boxes still to scan at the dispatch desk, or null where none are owed. */
  toScan: string | null;
  /** Dispatch-verified: the goods have left. */
  dispatched: boolean;
  /** The bill's transport record, once it has left. */
  transport: { stage: string | null; hasLr: boolean; issue: string | null } | null;
};

export const DELIVERED_STAGE = "Close - Received to Party";

/** ORDER: Verification Pending, Correction Required, Verified, On Hold, Cancelled, Closed. */
export function orderStatusOf(f: Pick<OrderFacts, "status" | "orderCheck" | "transport">): string {
  if (f.status === "Cancel") return "Cancelled";
  if (f.transport?.stage === DELIVERED_STAGE) return "Closed";
  if (f.status === "Hold From Office") return "On Hold";
  if (f.orderCheck === "Correction") return "Correction Required";
  if (f.orderCheck !== "Verified") return "Verification Pending";
  return "Verified";
}

/** PRODUCTION: Under Process or Ready — and nothing else, ever (rule 3). Null where the order is held or cancelled. */
export function productionOf(status: string): "Under Process" | "Ready" | null {
  return status === "Ready" ? "Ready" : status === "Under Process" ? "Under Process" : null;
}

/** BILLING: Invoice Pending, Verification Pending, Approved, Correction Required. */
export function billingOf(f: Pick<OrderFacts, "status" | "billed" | "invoiceCheck">): string | null {
  if (f.status === "Cancel") return null;
  if (!f.billed) return "Invoice Pending";
  if (f.invoiceCheck === "Approved") return "Approved";
  if (f.invoiceCheck === "Rejected") return "Correction Required";
  return "Verification Pending";
}

/** DISPATCH: Pending, Scanning / Verification Pending, Ready to Dispatch, Dispatched. */
export function dispatchOf(f: Pick<OrderFacts, "status" | "billed" | "invoiceCheck" | "toScan" | "dispatched">): string | null {
  if (f.status === "Cancel") return null;
  if (f.dispatched) return "Dispatched";
  /* The invoice check is optional: a pending one holds nothing, a rejected invoice holds the goods. */
  if (!f.billed || f.invoiceCheck === "Rejected") return "Pending";
  if (f.toScan) return "Scanning / Verification Pending";
  return "Ready to Dispatch";
}

/** LOGISTICS / DELIVERY: Logistics Pending, In Transit, Delivered / Closed, Exception — null until the goods leave. */
export function logisticsOf(f: Pick<OrderFacts, "dispatched" | "transport">): string | null {
  if (!f.dispatched) return null;
  const t = f.transport;
  if (!t) return "Logistics Pending";
  if (t.stage === DELIVERED_STAGE) return "Delivered / Closed";
  if (t.issue) return "Exception";
  if (t.stage === "Reached Destination Area" || t.stage === "Out for Delivery") return "Delivery Pending Confirmation";
  return t.hasLr ? "In Transit" : "Logistics Pending";
}

/* --------------------------------------------- one order, one complete bill */

export type BillLine = {
  id: string;
  label: string;
  status: string;
  orderCheck: string;
  partyPending: boolean;
  ratePaise: number | null;
  billed: boolean;
};

/**
 * WHY AN ORDER CANNOT BE BILLED YET, in the order the office has to fix them.
 * One order is one complete bill (rule 1), so the order is billed whole: every
 * line not cancelled has to be Ready. A line that is not going with this bill
 * is moved to a new, linked order rather than left behind (rule 2).
 */
export function orderBillBlockers(lines: BillLine[]): string[] {
  const live = lines.filter((l) => l.status !== "Cancel");
  if (!live.length) return ["every line is cancelled"];
  if (live.every((l) => l.billed)) return ["already billed"];
  const miss: string[] = [];
  if (live.some((l) => l.orderCheck !== "Verified")) miss.push("the back office to verify the order");
  const notReady = live.filter((l) => l.status !== "Ready");
  if (notReady.length) miss.push(`${notReady.map((l) => l.label).join(", ")} to be Ready — or moved to a new order to go later`);
  if (live.some((l) => l.partyPending)) miss.push("approval for this Pending customer");
  const noRate = live.filter((l) => l.ratePaise == null);
  if (noRate.length) miss.push(`a rate on ${noRate.map((l) => l.label).join(", ")}`);
  return miss;
}

/** A Tally invoice number as it is compared: trimmed, upper case, inner spaces closed. */
export function invoiceKey(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().replace(/\s+/g, "").toUpperCase();
  return s || null;
}

/** An order already carrying the invoice number somebody is about to record. */
export type InvoiceHolder = { orderNo: number; billingId: string; billingName: string; invoiceDate: string | null };

/**
 * WHETHER AN INVOICE NUMBER MAY BE SHARED, and if not, the sentence saying why.
 * One Tally invoice routinely covers several orders for one party, so a number
 * already on another order is allowed — but only where that order is billed
 * to the SAME party on the SAME invoice date, because a Tally invoice has one
 * party and one date. Anything else is the same number typed twice by mistake,
 * and it is refused naming the order that already holds it.
 */
export function invoiceShareRefusal(invoiceNo: string, billingId: string, invoiceDate: string, holders: InvoiceHolder[]): string | null {
  const otherParty = holders.find((h) => h.billingId !== billingId);
  if (otherParty) return `Invoice ${invoiceNo} is already on order ${otherParty.orderNo}, billed to ${otherParty.billingName}. An invoice shared by several orders has to be for one party.`;
  const otherDate = holders.find((h) => (h.invoiceDate ?? null) !== invoiceDate);
  if (otherDate) return `Invoice ${invoiceNo} is already on order ${otherDate.orderNo}, dated ${otherDate.invoiceDate ?? "—"}. Orders sharing an invoice share its date.`;
  return null;
}

/* ---------------------------------------------- what the checker approved */

export type InvoiceLine = { id: string; qtyCans: number; ratePaise: number | null; discountBp: number | null; gstBp: number | null; skuId: string };
export type InvoiceSnapshot = { invoiceNo: string | null; invoiceDate: string | null; lines: InvoiceLine[] };

/**
 * WHAT CHANGED SINCE THE INVOICE WAS CHECKED, in words — empty where nothing
 * did. Any change to the invoice's figures after approval sends it back to the
 * checker (step 6); a change to a remark or a transporter does not, because
 * the checker never looked at those.
 */
export function invoiceChanges(before: InvoiceSnapshot, after: InvoiceSnapshot): string[] {
  const out: string[] = [];
  if (invoiceKey(before.invoiceNo) !== invoiceKey(after.invoiceNo)) out.push(`invoice no. ${before.invoiceNo ?? "—"} → ${after.invoiceNo ?? "—"}`);
  if ((before.invoiceDate ?? null) !== (after.invoiceDate ?? null)) out.push(`invoice date ${before.invoiceDate ?? "—"} → ${after.invoiceDate ?? "—"}`);
  const was = new Map(before.lines.map((l) => [l.id, l]));
  const now = new Map(after.lines.map((l) => [l.id, l]));
  for (const [id, a] of now) {
    const b = was.get(id);
    if (!b) {
      out.push("a line was added");
      continue;
    }
    if (b.skuId !== a.skuId) out.push("a line's goods");
    if (b.qtyCans !== a.qtyCans) out.push(`quantity ${b.qtyCans} → ${a.qtyCans}`);
    if ((b.ratePaise ?? null) !== (a.ratePaise ?? null)) out.push("a rate");
    if ((b.discountBp ?? null) !== (a.discountBp ?? null)) out.push("a discount");
    if ((b.gstBp ?? null) !== (a.gstBp ?? null)) out.push("GST");
  }
  for (const id of was.keys()) if (!now.has(id)) out.push("a line was removed");
  return [...new Set(out)];
}

/* ------------------------------------------------------------ duplicates */

export type OrderShape = { orderNo: number; billingId: string; date: string; lines: { skuId: string; qtyCans: number }[] };

const shapeKey = (lines: { skuId: string; qtyCans: number }[]) =>
  lines
    .map((l) => `${l.skuId}×${l.qtyCans}`)
    .sort()
    .join("|");

/**
 * A LIKELY DUPLICATE: the same billing party, on the same order date, with
 * exactly the same goods in the same quantities. That is the one check that is
 * reliable (step 1) — a party ordering the same thing again next week is a
 * reorder, and the same party ordering different goods today is a second order.
 */
export function likelyDuplicate(candidate: Omit<OrderShape, "orderNo">, existing: OrderShape[]): number | null {
  const key = shapeKey(candidate.lines);
  const hit = existing.find((o) => o.billingId === candidate.billingId && o.date === candidate.date && shapeKey(o.lines) === key);
  return hit ? hit.orderNo : null;
}

/* ---------------------------------------------------------- moving a line */

/**
 * WHAT A MOVE TO A NEW ORDER LEAVES BEHIND. Moving the whole line moves it;
 * moving part splits it, and both parts have to be quantities the SKU can be
 * sold in — whole boxes on a boxed SKU.
 */
export function splitForMove(qtyCans: number, move: number, cansPerBox: number, loose: boolean): { ok: true; stays: number; moves: number } | { ok: false; reason: string } {
  if (!Number.isInteger(move) || move <= 0) return { ok: false, reason: "Move at least one can." };
  if (move > qtyCans) return { ok: false, reason: `The line has ${qtyCans} cans.` };
  const whole = (n: number) => loose || cansPerBox <= 1 || n % cansPerBox === 0;
  if (!whole(move) || !whole(qtyCans - move)) return { ok: false, reason: `Both parts must be whole boxes of ${cansPerBox}.` };
  return { ok: true, stays: qtyCans - move, moves: move };
}
