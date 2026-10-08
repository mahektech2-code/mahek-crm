/* ---------------------------------------------------------------------------
 * Sales-order arithmetic (spec §11), PURE: the order line, its allocation and
 * its bill figures are computed here and nowhere else, so the order list, the
 * label export, order details and the dashboard read one answer.
 *
 * Money is paise. A rate is per can, or per litre on a drum line.
 * ------------------------------------------------------------------------- */

export type OrderType = "Drum" | "Can" | "Box";

/** The order line's type, from the SKU's box type (spec §11.2 "Type"). */
export function orderType(boxType: string | null | undefined): OrderType {
  const b = (boxType ?? "").trim();
  if (b === "Empty Drum") return "Drum";
  if (!b) return "Can";
  if (b.startsWith("Empty Box")) return "Box";
  return "Can";
}

/**
 * Boxes on a line: a loose SKU is 0, otherwise cans ÷ cans per box — which
 * must come out whole ("INVALID" otherwise).
 */
export function boxQuantity(qtyCans: number, cansPerBox: number, loose: boolean): { boxes: number; valid: boolean } {
  if (loose || cansPerBox <= 1) return { boxes: 0, valid: true };
  const boxes = qtyCans / cansPerBox;
  return { boxes, valid: Number.isInteger(boxes) };
}

/** Labels to print: one a box on a boxed line, otherwise one a can. */
export function labelCount(type: OrderType, boxes: number, qtyCans: number): number {
  return Math.round(type === "Box" ? boxes : qtyCans);
}

export type Allocation = "Done" | "Add More Quantity" | "Remove Some Quantity";

/** Where a line's lot allocation stands against what it needs (spec §11.2 "Can Quantity Verification"). */
export function allocationState(target: number, allocated: number): Allocation {
  if (Math.abs(target - allocated) < 1e-9) return "Done";
  return target < allocated ? "Remove Some Quantity" : "Add More Quantity";
}

/** What a line allocates in: boxes from packing stock on a boxed SKU, cans from FG stock otherwise. */
export function allocationTarget(boxed: boolean, boxes: number, qtyCans: number): number {
  return boxed ? boxes : qtyCans;
}

export type BillFigures = {
  litres: number;
  amountPaise: number | null;
  discountedPaise: number | null;
  finalPaise: number | null;
  company: string;
};

/**
 * A detail line's bill (spec §11.6): amount on cans (or litres for a drum),
 * less the discount, plus transport, with GST on that.
 */
export function billFigures(p: {
  type: OrderType;
  qtyCans: number;
  litresPerCan: number;
  ratePaise: number | null;
  discountBp: number | null;
  transportCostPaise: number;
  gstBp: number;
}): BillFigures {
  const litres = Math.round(p.qtyCans * p.litresPerCan * 1000) / 1000;
  const company = p.gstBp > 0 ? "Mahek Marketing India" : "Mylac";
  if (p.ratePaise == null) return { litres, amountPaise: null, discountedPaise: null, finalPaise: null, company };
  const amount = Math.round((p.type === "Drum" ? litres : p.qtyCans) * p.ratePaise);
  const discounted = Math.round((amount * (p.discountBp ?? 0)) / 10000);
  const base = amount - discounted + (p.transportCostPaise || 0);
  const final = Math.round((base * p.gstBp) / 10000 + base);
  return { litres, amountPaise: amount, discountedPaise: discounted, finalPaise: final, company };
}

/**
 * The cost of what was sent: the average cost of the lots allocated, on the
 * cans (or litres for a drum), plus extra freight (spec §11.6 "Lotcode Costing").
 */
export function lotCosting(p: { type: OrderType; qtyCans: number; litres: number; costs: (number | null)[]; extraPaise: number | null }): number | null {
  if (!p.costs.length || p.costs.some((c) => c == null)) return null;
  const avg = (p.costs as number[]).reduce((a, c) => a + c, 0) / p.costs.length;
  return Math.round(avg * (p.type === "Drum" ? p.litres : p.qtyCans) + (p.extraPaise ?? 0));
}

export function margin(p: { amountPaise: number | null; discountedPaise: number | null; costingPaise: number | null; creditNotePaise: number | null }): number | null {
  if (p.amountPaise == null || p.costingPaise == null) return null;
  return p.amountPaise - (p.discountedPaise ?? 0) - p.costingPaise - (p.creditNotePaise ?? 0);
}

/** "Aug2026", from an ISO date. */
export function monthId(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const [y, m] = isoDate.split("-");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
  return mon ? `${mon}${y}` : null;
}

/** Whole days from one ISO date to another. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10)) - Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10))) / 86400000);
}

/** An ISO date plus whole days. */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + days));
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** "{instructions} - {delivery type} - {payment type} - {weight type}", from the delivery party (spec §11.2). */
export function standingInstructions(p: { instructions: string | null; deliveryType: string | null; paymentType: string | null; weightType: string | null }): string {
  const parts = [p.instructions, p.deliveryType, p.paymentType, p.weightType].map((x) => (x ?? "").trim());
  /* A party with none of the four says nothing, rather than "- - -". */
  return parts.some(Boolean) ? parts.join(" - ") : "";
}

/** A-20: the target is reached when the month's sale meets a target that exists. */
export function targetReached(monthlySalePaise: number, targetPaise: number | null): boolean {
  return targetPaise != null && targetPaise > 0 && monthlySalePaise >= targetPaise;
}

/**
 * READY MEANS THE GOODS ARE ON THE SHELF. A line is marked Ready only where the
 * godown holds enough unallocated stock of its SKU — packed boxes for a boxed
 * line, filled cans for a loose one — after what the lines ALREADY Ready and
 * still short of allocation will take. Lines asked for together are judged in
 * order, each spending what it needs, so two lines cannot both claim the last
 * box. `free` is stock left on the lots (allocations are already out of it).
 */
export type ReadyAsk = { id: string; key: string; need: number };
export type ReadyAnswer = { id: string; ok: boolean; need: number; free: number };
export function readyStockCheck(asks: ReadyAsk[], free: Map<string, number>, alreadyReady: Map<string, number>): ReadyAnswer[] {
  const left = new Map<string, number>();
  for (const [k, v] of free) left.set(k, v - (alreadyReady.get(k) ?? 0));
  return asks.map((a) => {
    const have = Math.max(0, left.get(a.key) ?? 0);
    const ok = a.need <= 0 || have >= a.need;
    if (ok) left.set(a.key, have - Math.max(0, a.need));
    return { id: a.id, ok, need: a.need, free: have };
  });
}
