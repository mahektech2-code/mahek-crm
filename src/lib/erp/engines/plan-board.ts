import type { ExpectedPlan } from "./expected-plan";
import type { OrderDemand, PlanCategory } from "./production-plan";

/* ---------------------------------------------------------------------------
 * UNDER PROCESS ON ONE PAGE — pure. Every product the orders ask for, every
 * base they need and every line somebody typed is one row with a tick box and
 * a "make today" figure. The Production Head ticks what the floor makes and
 * presses Print plan: the ticked rows ARE the plan, written as its lines and
 * printed on the sheet the floor already knows. Confirmed work starts ticked;
 * anything still waiting for the MRP check or Accounts starts unticked and may
 * be ticked, and then it prints as an ordinary line.
 *
 * An order whose line carries a remark is a row of its own under its product
 * (Nov 2026): the product's row adds up the orders without one, and each
 * remarked order prints on its own line with its remark, so the floor knows
 * which cans it is for. Stock is the product's, so it is read on the product's
 * row only.
 * ------------------------------------------------------------------------- */

export type BoardLine = {
  id: string;
  category: string;
  itemId: string | null;
  source: string;
  sourceKey: string | null;
  productName: string;
  size: string | null;
  quantity: number;
  unit: string;
  remarks: string | null;
};

export type BoardRow = {
  /** `loose:<id>`, `packing:<sku>`, `sfg:<formulation>`, or `line:<id>` for a typed line nothing else covers. */
  key: string;
  category: PlanCategory;
  itemId: string | null;
  name: string;
  size: string | null;
  code: string | null;
  /** "loose", "6 cans/box"; null for a base or a typed line. */
  packing: string | null;
  /** What the figures below are in: cans for a product, litres for a base. */
  measure: "cans" | "L" | null;
  confirmed: number | null;
  mrp: number;
  accounts: number;
  stock: number | null;
  verdict: { tone: "ok" | "short"; text: string } | null;
  /** The figure "make today" starts at, in `unit`. */
  qty: number;
  unit: string;
  units: string[];
  ticked: boolean;
  /** The plan line this row is, where it is already on the plan. */
  lineId: string | null;
  /** Cans per box, for a packing row; 1 otherwise. */
  cansPerBox: number;
  /** How much of `qty` (in this row's own measure) the confirmed work covers; beyond it the line is not approved yet. */
  confirmedNeed: number;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A packing figure in boxes where every count is whole boxes, else in cans. */
function packUnit(cpb: number, ...cans: number[]): "Boxes" | "Cans" {
  return cpb > 1 && cans.every((c) => c % cpb === 0) ? "Boxes" : "Cans";
}

export function buildBoard(plan: ExpectedPlan, lines: BoardLine[], demand: OrderDemand[] = []): BoardRow[] {
  const used = new Set<string>();
  const lineFor = (key: string, category: string, itemId: string | null, typedToo = true): BoardLine | null => {
    const byKey = lines.find((l) => !used.has(l.id) && l.source === "order" && l.sourceKey === key);
    const hit = byKey ?? (typedToo && itemId ? lines.find((l) => !used.has(l.id) && l.source !== "order" && l.category === category && l.itemId === itemId) : undefined);
    if (!hit) return null;
    used.add(hit.id);
    return hit;
  };
  const rows: BoardRow[] = [];

  for (const p of plan.products) {
    const total = p.confirmed + p.mrp + p.accounts;
    const units = p.category === "packing" ? ["Boxes", "Cans"] : ["Cans"];
    const remarked = demand.filter((d) => d.orderNo != null && d.productKey === p.key);
    /* What the product's own row is for: every order without a remark. */
    const confirmed = Math.max(0, p.confirmed - remarked.reduce((n, d) => n + d.cans, 0));
    const own = confirmed + p.mrp + p.accounts;
    const unit = p.category === "packing" ? packUnit(p.cansPerBox, confirmed, own) : "Cans";
    const per = unit === "Boxes" ? p.cansPerBox : 1;
    const line = lineFor(p.key, p.category, p.itemId);
    const verdict: BoardRow["verdict"] = p.verdict.tone === "ok" ? { tone: "ok", text: "Enough" } : { tone: "short", text: `Short ${total - p.stock}` };
    /* Every order of it has a remark: the product's row has nothing left to make, so its stock goes on the first remarked row. */
    const plain = own > 0 || !!line || !remarked.length;
    if (plain)
      rows.push({
        key: p.key,
        category: p.category,
        itemId: p.itemId,
        name: p.name,
        size: p.size,
        code: p.code,
        packing: p.packing,
        measure: "cans",
        confirmed,
        mrp: p.mrp,
        accounts: p.accounts,
        stock: p.stock,
        verdict,
        qty: line ? line.quantity : (confirmed > 0 ? confirmed : own) / per,
        unit: line ? line.unit : unit,
        units,
        ticked: !!line || confirmed > 0,
        lineId: line?.id ?? null,
        cansPerBox: p.cansPerBox,
        confirmedNeed: confirmed,
      });
    remarked.forEach((d, i) => {
      const u = p.category === "packing" ? packUnit(p.cansPerBox, d.cans) : "Cans";
      const l = lineFor(d.key, p.category, p.itemId, false);
      const first = !plain && i === 0;
      rows.push({
        key: d.key,
        category: p.category,
        itemId: p.itemId,
        name: p.name,
        size: p.size,
        code: p.code,
        packing: p.packing,
        measure: "cans",
        confirmed: d.cans,
        mrp: 0,
        accounts: 0,
        stock: first ? p.stock : null,
        verdict: first ? verdict : null,
        qty: l ? l.quantity : d.cans / (u === "Boxes" ? p.cansPerBox : 1),
        unit: l ? l.unit : u,
        units,
        ticked: true,
        lineId: l?.id ?? null,
        cansPerBox: p.cansPerBox,
        confirmedNeed: d.cans,
      });
    });
  }

  for (const b of plan.bases) {
    const confirmedShort = Math.max(0, b.confirmedLitres - b.inTank);
    const line = lineFor(`sfg:${b.formulationId}`, "sfg", b.formulationId);
    rows.push({
      key: `sfg:${b.formulationId}`,
      category: "sfg",
      itemId: b.formulationId,
      name: b.name,
      size: null,
      code: null,
      packing: null,
      measure: "L",
      confirmed: b.confirmedLitres,
      mrp: 0,
      accounts: b.expectedLitres,
      stock: b.inTank,
      verdict: b.shortLitres > 0 ? { tone: "short", text: `Short ${b.shortLitres} L` } : { tone: "ok", text: "Enough" },
      qty: line ? line.quantity : Math.ceil(confirmedShort > 0 ? confirmedShort : b.shortLitres),
      unit: line ? line.unit : "Litre",
      units: ["Litre", "Kg"],
      ticked: !!line || confirmedShort > 0,
      lineId: line?.id ?? null,
      cansPerBox: 1,
      confirmedNeed: r1(confirmedShort),
    });
  }

  /* A line typed by hand, or one the orders no longer ask for, is a row of its own, ticked: it is on the plan. */
  for (const l of lines) {
    if (used.has(l.id)) continue;
    const category = (["sfg", "loose", "packing"].includes(l.category) ? l.category : "loose") as PlanCategory;
    rows.push({
      key: `line:${l.id}`,
      category,
      itemId: l.itemId,
      name: l.productName,
      size: l.size,
      code: null,
      packing: null,
      measure: null,
      confirmed: null,
      mrp: 0,
      accounts: 0,
      stock: null,
      verdict: null,
      qty: l.quantity,
      unit: l.unit,
      units: category === "sfg" ? ["Litre", "Kg"] : category === "packing" ? ["Boxes", "Cans"] : ["Cans"],
      ticked: true,
      lineId: l.id,
      cansPerBox: 1,
      confirmedNeed: 0,
    });
  }

  const section = (r: BoardRow) => (r.category === "sfg" ? 1 : 0);
  return rows.sort((a, b) => section(a) - section(b) || a.name.localeCompare(b.name));
}

/**
 * Whether a ticked row prints work that is not approved yet: more than the
 * confirmed orders need, on a row where something is still waiting. A typed
 * line is the Production Head's own and never is.
 */
export function beyondConfirmed(row: BoardRow, qty: number, unit: string): boolean {
  if (row.mrp + row.accounts <= 0) return false;
  if (row.measure === "L") return unit === "Litre" && qty > row.confirmedNeed;
  if (row.measure === "cans") return (unit === "Boxes" ? qty * row.cansPerBox : qty) > row.confirmedNeed;
  return false;
}

/** The column filters' values for one row: what a filter on that column matches. */
export type BoardFacet = "kind" | "confirmed" | "waiting" | "stock" | "verdict" | "unit";

export function facetValues(row: BoardRow, unit: string): Record<BoardFacet, string[]> {
  const kind = row.category === "sfg" ? "Base (SFG)" : row.category === "packing" ? "Packing" : "Loose cans";
  const waiting = [...(row.mrp > 0 ? ["MRP check"] : []), ...(row.accounts > 0 ? [row.measure === "L" ? "Expected" : "Accounts"] : [])];
  return {
    kind: [kind],
    confirmed: [row.confirmed == null ? "Typed line" : row.confirmed > 0 ? "Has confirmed" : "None confirmed"],
    waiting: waiting.length ? waiting : ["Nothing waiting"],
    stock: [row.stock == null ? "Not read" : row.stock > 0 ? "In stock" : "None in stock"],
    verdict: [row.verdict ? (row.verdict.tone === "short" ? "Short" : "Enough") : "Not read"],
    unit: [unit],
  };
}
