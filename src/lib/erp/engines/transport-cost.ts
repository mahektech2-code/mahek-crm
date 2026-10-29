/* ---------------------------------------------------------------------------
 * THE TRANSPORT PAYMENT, SHARED OUT BY LITRES (Order-to-Delivery PRD step 11).
 * Pure and client-safe: the payment dialog previews the split with this exact
 * function, and the server writes what it returns — a preview that disagreed
 * with the save would be worse than none.
 *
 * One payment covers one vehicle trip, and the trip carries several bills for
 * several customers. The amount is shared out ONLY by dispatched litres — never
 * by boxes, weight or the number of bills — and the shares add up to the amount
 * to the paisa: the rounding is the largest-remainder method, so the paise left
 * over after flooring go to the bills that lost the most to the floor, ties to
 * the larger bill and then to the id, so the same inputs always give the same
 * split.
 *
 * Also the two status vocabularies the PRD's section 6 asks for on this side:
 * the transport-cost status of a trip, and the logistics / delivery status of
 * a bill — both DERIVED from facts already stored, never typed.
 * ------------------------------------------------------------------------- */

export type LitreItem = { id: string; litres: number | null | undefined };
export type LitreShare = { id: string; litres: number; amountPaise: number };

export type Allocation =
  | { ok: true; totalLitres: number; costPerLitrePaise: number; rows: LitreShare[] }
  | { ok: false; reason: string };

/** Litres are kept to two decimals, as `erp_transports.litres` and the allocation row store them. */
const litres2 = (v: number) => Math.round(v * 100) / 100;

export function allocateByLitres(totalPaise: number, items: LitreItem[]): Allocation {
  if (!Number.isFinite(totalPaise) || !Number.isInteger(totalPaise) || totalPaise <= 0) return { ok: false, reason: "The transport amount must be more than zero." };
  if (!items.length) return { ok: false, reason: "Choose at least one bill to share the amount over." };
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) return { ok: false, reason: "A bill is chosen twice." };
    seen.add(it.id);
    const l = it.litres;
    if (l == null || !Number.isFinite(l) || litres2(l) <= 0) return { ok: false, reason: `Bill ${it.id} has no dispatched litres. Correct its litres before sharing the cost.` };
  }
  const clean = items.map((it) => ({ id: it.id, litres: litres2(it.litres as number) }));
  /* Integer hundredths of a litre, so the arithmetic below is exact. */
  const units = clean.map((c) => Math.round(c.litres * 100));
  const totalUnits = units.reduce((a, b) => a + b, 0);
  if (totalUnits <= 0) return { ok: false, reason: "The chosen bills carry no dispatched litres." };
  const raw = units.map((u) => (totalPaise * u) / totalUnits);
  const floor = raw.map((r) => Math.floor(r));
  let left = totalPaise - floor.reduce((a, b) => a + b, 0);
  const order = clean
    .map((c, i) => ({ i, rem: raw[i] - floor[i], units: units[i], id: c.id }))
    .sort((a, b) => b.rem - a.rem || b.units - a.units || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const o of order) {
    if (left <= 0) break;
    floor[o.i] += 1;
    left -= 1;
  }
  const totalLitres = totalUnits / 100;
  return {
    ok: true,
    totalLitres,
    costPerLitrePaise: totalPaise / totalLitres,
    rows: clean.map((c, i) => ({ id: c.id, litres: c.litres, amountPaise: floor[i] })),
  };
}

/* --------------------------------------------- the transport-cost status */

export type TransportCostStatus = "Not Recorded" | "Recorded" | "Allocation Pending" | "Allocated" | "Reconciliation Required";

export type PaymentFacts = {
  status: "recorded" | "allocated" | "reversed";
  amountPaise: number;
  /** Its live shares, each with the litres it was allocated on and the bill's litres now. */
  shares: { transportId: string; litres: number; amountPaise: number; billLitresNow: number | null }[];
};

/** Whether a live payment's shares still describe it: they add up to it, and every bill still carries the litres it was shared on. */
export function needsReconciling(p: PaymentFacts): boolean {
  if (p.status !== "allocated") return false;
  const sum = p.shares.reduce((a, s) => a + s.amountPaise, 0);
  if (sum !== p.amountPaise) return true;
  return p.shares.some((s) => s.billLitresNow == null || litres2(s.billLitresNow) !== litres2(s.litres));
}

/**
 * A TRIP's transport-cost status, from its payments and its bills:
 *  - Not Recorded — no live payment;
 *  - Recorded — a live payment has been written but nothing shared out yet;
 *  - Allocation Pending — every live payment is shared out, but some bill on the trip carries none of it;
 *  - Allocated — every bill on the trip carries a share of a live payment;
 *  - Reconciliation Required — a share no longer matches its payment or its bill.
 */
export function tripCostStatus(payments: PaymentFacts[], billIds: string[]): TransportCostStatus {
  const live = payments.filter((p) => p.status !== "reversed");
  if (!live.length) return "Not Recorded";
  if (live.some(needsReconciling)) return "Reconciliation Required";
  if (live.some((p) => p.status === "recorded")) return "Recorded";
  const covered = new Set(live.flatMap((p) => p.shares.map((s) => s.transportId)));
  return billIds.every((id) => covered.has(id)) ? "Allocated" : "Allocation Pending";
}

/** In the ERP's badge tones (`lib/erp/ui.ts` Tone). */
export const COST_STATUS_TONE: Record<TransportCostStatus, "neutral" | "warn" | "danger" | "success"> = {
  "Not Recorded": "neutral",
  Recorded: "warn",
  "Allocation Pending": "warn",
  Allocated: "success",
  "Reconciliation Required": "danger",
};

/* --------------------------------------- the logistics / delivery status */

export type DeliveryStatus = "Logistics Pending" | "In Transit" | "Delivery Pending Confirmation" | "Delivered" | "Exception";

/**
 * A bill's logistics status, as the PRD's section 6 names it. An open problem
 * is an EXCEPTION whatever the stage; delivered is only ever the explicit
 * "received by the party" act; reaching the destination area, or the expected
 * day passing, is waiting for that confirmation rather than delivery.
 */
export function deliveryStatus(
  t: { phase: "toTransport" | "lrPending" | "onRoad" | "delivered"; stage: string; issue: string | null; expectedDeliveryOn: string | null },
  today: string,
): DeliveryStatus {
  if (t.phase === "delivered") return "Delivered";
  if (t.issue) return "Exception";
  if (t.phase === "toTransport" || t.phase === "lrPending") return "Logistics Pending";
  if (t.stage === "Reached Destination Area" || t.stage === "Out for Delivery" || (t.expectedDeliveryOn != null && t.expectedDeliveryOn < today)) return "Delivery Pending Confirmation";
  return "In Transit";
}

export const DELIVERY_STATUS_TONE: Record<DeliveryStatus, "neutral" | "info" | "warn" | "danger" | "success"> = {
  "Logistics Pending": "neutral",
  "In Transit": "info",
  "Delivery Pending Confirmation": "warn",
  Delivered: "success",
  Exception: "danger",
};

/** ₹ per litre, said to the paisa — "₹1.25 / L". */
export function perLitreWords(costPerLitrePaise: number): string {
  return `₹${(costPerLitrePaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / L`;
}
