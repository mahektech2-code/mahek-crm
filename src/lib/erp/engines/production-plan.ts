/* ---------------------------------------------------------------------------
 * UNDER PROCESS — the rules of the daily production plan. PURE, like every
 * engine: what a line must carry, and what state each line is in against the
 * last sheet the floor was handed.
 *
 * THE MARKING RULE IS ONE QUESTION: was this line on the last print, exactly
 * as it is now? Yes is GIVEN; on it but different is EDITED; not on it is NEW;
 * deleted after it was on it is REMOVED (listed once on the next print). A line
 * added and deleted between two prints never reached the floor and is not
 * drawn at all. The screen's colours and the print's underline both read it.
 * ------------------------------------------------------------------------- */

import type { PlanSnapshotLine } from "@/db/schema";

export type PlanCategory = "sfg" | "loose" | "packing";

export type CategorySpec = {
  key: PlanCategory;
  label: string;
  /** The word in the print's Category column. */
  short: string;
  /** Null where the category has no size (SFG is made by the litre). */
  sizeLabel: string | null;
  qtyLabel: string;
  units: string[];
  /** Whether the quantity must be whole — cans and boxes are counted. */
  whole: boolean;
};

export const PLAN_CATEGORIES: CategorySpec[] = [
  { key: "sfg", label: "SFG manufacturing", short: "SFG", sizeLabel: null, qtyLabel: "Manufacturing quantity", units: ["Litre", "Kg"], whole: false },
  { key: "loose", label: "Loose can preparation", short: "Loose can", sizeLabel: "Can size", qtyLabel: "Number of cans", units: ["Cans"], whole: true },
  { key: "packing", label: "Packing", short: "Packing", sizeLabel: "Pack size", qtyLabel: "Packing quantity", units: ["Boxes", "Cans"], whole: true },
];

export function categorySpec(key: string): CategorySpec | undefined {
  return PLAN_CATEGORIES.find((c) => c.key === key);
}

export type LineInput = {
  category: string;
  itemId: string;
  quantity: string;
  unit: string;
  remarks?: string;
};

/** What is wrong with a line, field by field; empty means it may be saved. */
export function lineProblems(l: LineInput, known: { itemExists: boolean; size: string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  const spec = categorySpec(l.category);
  if (!spec) {
    out.category = "Pick a work category.";
    return out;
  }
  if (!l.itemId.trim()) out.itemId = "Pick a product.";
  else if (!known.itemExists) out.itemId = `That product is not on the ${spec.label.toLowerCase()} list.`;
  else if (spec.sizeLabel && !known.size) out.itemId = `This product has no ${spec.sizeLabel.toLowerCase()} recorded. Set it on Products first.`;
  const q = Number(l.quantity.trim());
  if (!l.quantity.trim()) out.quantity = "Enter the quantity.";
  else if (!Number.isFinite(q) || q <= 0) out.quantity = "The quantity must be more than zero.";
  else if (spec.whole && !Number.isInteger(q)) out.quantity = "Cans and boxes are counted in whole numbers.";
  if (!spec.units.includes(l.unit)) out.unit = "Pick a unit.";
  if ((l.remarks ?? "").length > 300) out.remarks = "Keep remarks under 300 characters.";
  return out;
}

export type LineState = "given" | "new" | "edited" | "removed";

type Comparable = Omit<PlanSnapshotLine, "id">;

function same(a: Comparable, b: Comparable): boolean {
  return (
    a.category === b.category &&
    a.productName === b.productName &&
    (a.size ?? null) === (b.size ?? null) &&
    a.quantity === b.quantity &&
    a.unit === b.unit &&
    (a.remarks ?? null) === (b.remarks ?? null)
  );
}

/**
 * A line's state against the last print. Null means "do not draw" — a line
 * deleted that the floor never saw. Before any print every live line is NEW,
 * and the first print underlines nothing (`printMarks` says so).
 */
export function lineState(line: PlanSnapshotLine & { deleted: boolean }, lastPrint: Map<string, PlanSnapshotLine> | null): LineState | null {
  const printed = lastPrint?.get(line.id) ?? null;
  if (line.deleted) return printed ? "removed" : null;
  if (!printed) return "new";
  return same(line, printed) ? "given" : "edited";
}

/** How many lines differ from the last print — the "N changed since Print 2" count. */
export function changedSince(lines: (PlanSnapshotLine & { deleted: boolean })[], lastPrint: Map<string, PlanSnapshotLine> | null): number {
  return lines.filter((l) => {
    const s = lineState(l, lastPrint);
    return s === "new" || s === "edited" || s === "removed";
  }).length;
}

export type PrintRow = PlanSnapshotLine & { sr: number; mark: "new" | "edited" | null; was: number | null };

/**
 * A print's rows in category order, numbered, with what changed since the
 * print before it. The FIRST print of a day marks nothing; a later one
 * underlines new and edited lines and lists what was removed.
 */
export function printMarks(current: PlanSnapshotLine[], previous: PlanSnapshotLine[] | null): { rows: PrintRow[]; removed: PlanSnapshotLine[] } {
  const prev = previous ? new Map(previous.map((l) => [l.id, l])) : null;
  const order = new Map(PLAN_CATEGORIES.map((c, i) => [c.key as string, i]));
  const sorted = [...current].sort((a, b) => (order.get(a.category) ?? 9) - (order.get(b.category) ?? 9));
  const rows = sorted.map((l, i): PrintRow => {
    const p = prev?.get(l.id) ?? null;
    const mark = !prev ? null : !p ? "new" : same(l, p) ? null : "edited";
    return { ...l, sr: i + 1, mark, was: mark === "edited" && p && p.quantity !== l.quantity ? p.quantity : null };
  });
  const ids = new Set(current.map((l) => l.id));
  const removed = previous ? previous.filter((l) => !ids.has(l.id)) : [];
  return { rows, removed };
}

/** "20 L", "4 L", "800 ml" — how a can or pack is named on the floor. */
export function sizeName(millilitres: number | null | undefined): string | null {
  if (millilitres == null || !Number.isFinite(millilitres) || millilitres <= 0) return null;
  if (millilitres < 1000) return `${Math.round(millilitres)} ml`;
  const l = millilitres / 1000;
  return `${Number.isInteger(l) ? l : Number(l.toFixed(2))} L`;
}

/* ---------------------------------------------------------------------------
 * WHAT THE ORDERS ASK FOR. Every order line whose status is "Under Process"
 * (Orders → Production) comes into the day's plan by itself, one plan line per
 * product: a loose SKU (one can a box) as loose-can preparation of its
 * finished good, in cans; a boxed SKU as packing, in boxes — or in cans where
 * the orders do not add up to whole boxes, because a rounded box is a figure
 * nobody ordered. SFG is not derived: how much liquid a day needs is the
 * Production Head's judgement, typed as before.
 * ------------------------------------------------------------------------- */

export type UnderProcessLine = {
  orderNo: number;
  skuId: string;
  skuName: string;
  skuCode: string | null;
  cansPerBox: number;
  millilitres: number | null;
  finishedGoodId: string | null;
  finishedGoodName: string | null;
  qtyCans: number;
};

export type OrderDemand = {
  key: string;
  category: PlanCategory;
  itemId: string | null;
  productName: string;
  productCode: string | null;
  size: string | null;
  quantity: number;
  unit: string;
  orderRefs: string;
};

export function orderDemand(lines: UnderProcessLine[]): OrderDemand[] {
  type Acc = { d: Omit<OrderDemand, "quantity" | "unit" | "orderRefs">; cans: number; cpb: number; orders: Set<number> };
  const by = new Map<string, Acc>();
  for (const l of lines) {
    if (!(l.qtyCans > 0)) continue;
    const loose = (l.cansPerBox || 1) <= 1;
    const category: PlanCategory = loose ? "loose" : "packing";
    const itemId = loose ? (l.finishedGoodId ?? l.skuId) : l.skuId;
    const key = `${category}:${itemId}`;
    let a = by.get(key);
    if (!a) {
      a = {
        d: {
          key,
          category,
          itemId: loose && !l.finishedGoodId ? null : itemId,
          productName: loose ? (l.finishedGoodName ?? l.skuName) : l.skuName,
          productCode: l.skuCode,
          size: sizeName(l.millilitres),
        },
        cans: 0,
        cpb: Math.max(1, l.cansPerBox || 1),
        orders: new Set(),
      };
      by.set(key, a);
    }
    a.cans += l.qtyCans;
    a.orders.add(l.orderNo);
  }
  const order = new Map(PLAN_CATEGORIES.map((c, i) => [c.key as string, i]));
  return [...by.values()]
    .map(({ d, cans, cpb, orders }): OrderDemand => {
      const boxes = cans / cpb;
      const inBoxes = d.category === "packing" && Number.isInteger(boxes);
      return {
        ...d,
        quantity: d.category === "packing" && inBoxes ? boxes : cans,
        unit: d.category === "loose" ? "Cans" : inBoxes ? "Boxes" : "Cans",
        orderRefs: [...orders].sort((x, y) => x - y).join(", "),
      };
    })
    .sort((a, b) => (order.get(a.category)! - order.get(b.category)!) || a.productName.localeCompare(b.productName));
}
