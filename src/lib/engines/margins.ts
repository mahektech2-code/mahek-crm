/* ---------------------------------------------------------------------------
 * THE FOUNDER'S MARGINS — the arithmetic, pure and client-safe.
 *
 * A line's margin is the ERP's, never a second reading of it: amount, less
 * the discount, less the cost of the lots the dispatch desk allocated (with
 * the line's extra expenses, which the ERP books into its costing), less the
 * credit notes issued against the bill and goods, all before GST
 * (`margin()` in `lib/erp/engines/sales.ts`). The service hands this file one
 * `MarginLine` per billed, dispatched ERP line; everything here only adds
 * them up, so a figure on any tab and the line under it cannot disagree.
 *
 * A LINE WITH NO LOT COST HAS NO MARGIN, and it is never 0% or 100%. The
 * client's own spreadsheet showed a product at 100% margin because its lot
 * had not been allocated — a cost of nothing read as a cost of zero. Such a
 * line counts in sales and in litres, and is HELD OUT of margin and margin %
 * and counted on its own, so a percentage is always margin over the sales
 * that were actually costed.
 * ------------------------------------------------------------------------- */

export type MarginLine = {
  id: string;
  orderNo: number;
  /** ISO date the line left (dispatch date). */
  date: string;
  customerId: string;
  customer: string;
  salesman: string;
  state: string;
  district: string;
  city: string;
  godown: string;
  product: string;
  formulation: string;
  lots: string[];
  cans: number;
  litres: number;
  /** Rate per can, or per litre on a drum, as billed. */
  ratePaise: number | null;
  amountPaise: number;
  discountPaise: number;
  /** The allocated lots' cost, WITHOUT the line's extra expenses. Null: no lot cost yet. */
  lotCostPaise: number | null;
  /**
   * Where that cost came from: the lots the dispatch desk allocated, or — for a
   * line that left before lots were allocated (26 Oct 2026) — the old order
   * sheet's own "Lotcode Costing". Null exactly when the cost is.
   */
  costSource: "lots" | "sheet" | null;
  extraPaise: number;
  creditNotePaise: number;
  /** The ERP's margin. Null exactly when the lot cost is unknown. */
  marginPaise: number | null;
  /** Dispatch date less order date, in days. */
  days: number | null;
};

export type MarginRules = {
  healthyAtOrAbove: number;
  fairAtOrAbove: number;
  thinAtOrAbove: number;
  floorPercent: number;
  targetPercent: number;
  productDropPoints: number;
  customerDropPercent: number;
};

export type Totals = {
  lines: number;
  orders: number;
  customers: number;
  cans: number;
  litres: number;
  amount: number;
  discount: number;
  /** Amount less discount: what the margin % is taken of. */
  sales: number;
  lotCost: number;
  extra: number;
  creditNote: number;
  /** Sales of the lines that have a lot cost. */
  costedSales: number;
  costedLitres: number;
  margin: number;
  /** Lines held out for want of a lot cost. */
  noCost: number;
  noCostSales: number;
  /** Of the costed lines, those costed from the old order sheet rather than an allocated lot. */
  sheetCosted: number;
  sheetCostedSales: number;
  /** Margin over costed sales; null with nothing costed. */
  pct: number | null;
  /** Margin per costed litre. */
  perLitre: number | null;
  /** Sales per litre. */
  ratePerLitre: number | null;
  /** Lot cost per costed litre. */
  costPerLitre: number | null;
  leakage: number;
};

export function salesOf(l: MarginLine): number {
  return l.amountPaise - l.discountPaise;
}

export function linePct(l: MarginLine): number | null {
  const s = salesOf(l);
  return l.marginPaise == null || s <= 0 ? null : (l.marginPaise / s) * 100;
}

export function totals(lines: readonly MarginLine[]): Totals {
  const orders = new Set<number>();
  const customers = new Set<string>();
  const t: Totals = {
    lines: lines.length, orders: 0, customers: 0, cans: 0, litres: 0, amount: 0, discount: 0, sales: 0, lotCost: 0, extra: 0, creditNote: 0,
    costedSales: 0, costedLitres: 0, margin: 0, noCost: 0, noCostSales: 0, sheetCosted: 0, sheetCostedSales: 0, pct: null, perLitre: null, ratePerLitre: null, costPerLitre: null, leakage: 0,
  };
  for (const l of lines) {
    orders.add(l.orderNo);
    customers.add(l.customerId);
    const s = salesOf(l);
    t.cans += l.cans;
    t.litres += l.litres;
    t.amount += l.amountPaise;
    t.discount += l.discountPaise;
    t.sales += s;
    t.extra += l.extraPaise;
    t.creditNote += l.creditNotePaise;
    if (l.marginPaise == null) {
      t.noCost += 1;
      t.noCostSales += s;
    } else {
      t.margin += l.marginPaise;
      t.costedSales += s;
      t.costedLitres += l.litres;
      t.lotCost += l.lotCostPaise ?? 0;
      if (l.costSource === "sheet") {
        t.sheetCosted += 1;
        t.sheetCostedSales += s;
      }
    }
  }
  t.orders = orders.size;
  t.customers = customers.size;
  t.pct = t.costedSales > 0 ? (t.margin / t.costedSales) * 100 : null;
  t.perLitre = t.costedLitres > 0 ? t.margin / t.costedLitres : null;
  t.ratePerLitre = t.litres > 0 ? t.sales / t.litres : null;
  t.costPerLitre = t.costedLitres > 0 ? t.lotCost / t.costedLitres : null;
  t.leakage = t.discount + t.extra + t.creditNote;
  return t;
}

/* ------------------------------------------------------------------ bands */

export type Band = "healthy" | "fair" | "thin" | "loss" | "nocost";

export const BAND_LABEL: Record<Band, string> = {
  healthy: "Healthy",
  fair: "Fair",
  thin: "Thin",
  loss: "Under the thin line",
  nocost: "No lot cost",
};

export const BAND_ORDER: readonly Band[] = ["healthy", "fair", "thin", "loss", "nocost"];

export function bandOf(pct: number | null, r: Pick<MarginRules, "healthyAtOrAbove" | "fairAtOrAbove" | "thinAtOrAbove">): Band {
  if (pct == null) return "nocost";
  if (pct >= r.healthyAtOrAbove) return "healthy";
  if (pct >= r.fairAtOrAbove) return "fair";
  if (pct >= r.thinAtOrAbove) return "thin";
  return "loss";
}

/** The words a band is drawn with, thresholds included, so a pill can say why. */
export function bandRange(b: Band, r: MarginRules): string {
  switch (b) {
    case "healthy":
      return `${r.healthyAtOrAbove}% and above`;
    case "fair":
      return `${r.fairAtOrAbove}–${r.healthyAtOrAbove}%`;
    case "thin":
      return `${r.thinAtOrAbove}–${r.fairAtOrAbove}%`;
    case "loss":
      return `Under ${r.thinAtOrAbove}%`;
    default:
      return "Margin unknown until a lot is allocated";
  }
}

export function underFloor(l: MarginLine, r: Pick<MarginRules, "floorPercent">): boolean {
  const p = linePct(l);
  return p != null && p < r.floorPercent;
}

/* ---------------------------------------------------------------- roll-ups */

export type Rollup = { key: string; lines: MarginLine[]; t: Totals; prev: Totals | null };

/** One row per key, with the same key's previous-period totals where it sold then. */
export function rollup(cur: readonly MarginLine[], prev: readonly MarginLine[] | null, keyOf: (l: MarginLine) => string): Rollup[] {
  const by = new Map<string, MarginLine[]>();
  for (const l of cur) {
    const k = keyOf(l);
    const a = by.get(k);
    if (a) a.push(l);
    else by.set(k, [l]);
  }
  const pby = new Map<string, MarginLine[]>();
  for (const l of prev ?? []) {
    const k = keyOf(l);
    const a = pby.get(k);
    if (a) a.push(l);
    else pby.set(k, [l]);
  }
  return [...by.entries()].map(([key, lines]) => {
    const p = pby.get(key);
    return { key, lines, t: totals(lines), prev: prev && p ? totals(p) : null };
  });
}

/* --------------------------------------------------------- why it moved */

export type Bridge = {
  prevMargin: number;
  /** Litres moved at the previous period's margin per litre. */
  volume: number;
  /** The same products sold at a different rate per litre. */
  price: number;
  /** The same products costed at a different lot cost per litre. */
  cost: number;
  /** Discount, extra expenses and credit notes, against the previous period. */
  leakage: number;
  /** What is left: a different mix of products, and products sold in only one period. */
  mix: number;
  margin: number;
};

/**
 * Margin then to margin now, in five steps that add up exactly — `mix` is the
 * remainder by construction, so the bridge can never claim more than moved.
 * Price and cost are measured product by product, on costed lines only, so a
 * product sold at a new rate is not confused with more of a dearer product.
 */
export function bridge(cur: readonly MarginLine[], prev: readonly MarginLine[]): Bridge {
  const c = totals(cur);
  const p = totals(prev);
  const curBy = rollup(cur.filter((l) => l.marginPaise != null), null, (l) => l.product);
  const prevBy = new Map(rollup(prev.filter((l) => l.marginPaise != null), null, (l) => l.product).map((r) => [r.key, r.t]));
  let price = 0;
  let cost = 0;
  for (const r of curBy) {
    const b = prevBy.get(r.key);
    if (!b || !b.costedLitres || !r.t.costedLitres) continue;
    const rateNow = r.t.costedSales / r.t.costedLitres;
    const rateThen = b.costedSales / b.costedLitres;
    price += (rateNow - rateThen) * r.t.costedLitres;
    cost -= ((r.t.costPerLitre ?? 0) - (b.costPerLitre ?? 0)) * r.t.costedLitres;
  }
  const volume = (c.costedLitres - p.costedLitres) * (p.perLitre ?? 0);
  /* Only costed lines' expenses: an uncosted line has no margin to take them from, and counting them would leave Mix to cancel them out. */
  const costed = (ls: readonly MarginLine[]) => ls.filter((l) => l.marginPaise != null).reduce((a, l) => a + l.extraPaise + l.creditNotePaise, 0);
  const leakage = costed(prev) - costed(cur);
  const mix = c.margin - p.margin - volume - price - cost - leakage;
  return { prevMargin: p.margin, volume, price, cost, leakage, mix, margin: c.margin };
}

/* ---------------------------------------------------------------- alerts */

export type MarginAlert = {
  id: string;
  tone: "bad" | "warn" | "info";
  title: string;
  body: string;
  /** Where it opens: a tab, a view inside it, and a quick filter. */
  go: { tab: string; view?: string; show?: string; open?: string };
  /** Margin at stake, in paise, where one can be said. */
  stakePaise: number | null;
};

/**
 * What needs the founder, read off the lines and the rules — nothing stored,
 * so an alert clears itself the moment its cause does.
 */
export function marginAlerts(cur: readonly MarginLine[], prev: readonly MarginLine[] | null, r: MarginRules, money: (p: number) => string): MarginAlert[] {
  const out: MarginAlert[] = [];
  const under = cur.filter((l) => underFloor(l, r));
  if (under.length) {
    const t = totals(under);
    const stake = under.reduce((a, l) => a + Math.max(0, (r.floorPercent / 100) * salesOf(l) - (l.marginPaise ?? 0)), 0);
    out.push({
      id: "under",
      tone: "bad",
      title: `${under.length} line${under.length === 1 ? " is" : "s are"} under the ${r.floorPercent}% floor`,
      body: `${money(t.sales)} of sales earned ${money(t.margin)}. Most are ${topOf(under, (l) => l.salesman)}’s.`,
      go: { tab: "lines", show: "under" },
      stakePaise: Math.round(stake),
    });
  }
  const noCost = cur.filter((l) => l.marginPaise == null);
  if (noCost.length) {
    out.push({
      id: "nocost",
      tone: "warn",
      title: `${noCost.length} line${noCost.length === 1 ? " has" : "s have"} no lot cost`,
      body: `${money(noCost.reduce((a, l) => a + salesOf(l), 0))} of sales whose lot is not allocated, and which the old order sheet does not cost either, so their margin is unknown. They are held out of margin %, never shown as 100%.`,
      go: { tab: "lines", show: "nocost" },
      stakePaise: null,
    });
  }
  const sheet = cur.filter((l) => l.costSource === "sheet");
  if (sheet.length) {
    out.push({
      id: "sheet",
      tone: "info",
      title: `${sheet.length} line${sheet.length === 1 ? " is" : "s are"} costed from the old order sheet`,
      body: `${money(sheet.reduce((a, l) => a + salesOf(l), 0))} of sales left before lots were allocated in the ERP (26 Oct 2026). Their cost is the sheet's own "Lotcode Costing", the figure its margin was worked from.`,
      go: { tab: "lines", show: "sheet" },
      stakePaise: null,
    });
  }
  if (prev && prev.length) {
    for (const p of rollup(cur, prev, (l) => l.product)) {
      if (!p.prev || p.t.pct == null || p.prev.pct == null) continue;
      const d = p.t.pct - p.prev.pct;
      if (d > -r.productDropPoints) continue;
      out.push({
        id: `drop:${p.key}`,
        tone: "bad",
        title: `${p.key} fell ${Math.abs(d).toFixed(1)} pp`,
        body: `${p.prev.pct.toFixed(1)}% → ${p.t.pct.toFixed(1)}%. Lot cost per litre ${money(Math.round(p.prev.costPerLitre ?? 0))} → ${money(Math.round(p.t.costPerLitre ?? 0))}.`,
        go: { tab: "products", view: "sku", open: p.key },
        stakePaise: Math.round((-d / 100) * p.t.costedSales),
      });
    }
    const top = rollup(cur, prev, (l) => l.customerId)
      .filter((c) => c.prev)
      .sort((a, b) => (b.prev?.sales ?? 0) - (a.prev?.sales ?? 0))
      .slice(0, 20);
    for (const c of top) {
      if (!c.prev || c.prev.margin <= 0) continue;
      const fall = ((c.prev.margin - c.t.margin) / c.prev.margin) * 100;
      if (fall < r.customerDropPercent) continue;
      out.push({
        id: `cust:${c.key}`,
        tone: "info",
        title: `${c.lines[0]!.customer}: margin down ${fall.toFixed(0)}%`,
        body: `${money(c.t.margin)} against ${money(c.prev.margin)} on ${money(c.t.sales)} of sales.`,
        go: { tab: "customers", open: c.key },
        stakePaise: c.prev.margin - c.t.margin,
      });
    }
  }
  return out;
}

export function topOf<T>(rows: readonly T[], keyOf: (r: T) => string): string {
  const n = new Map<string, number>();
  for (const r of rows) n.set(keyOf(r), (n.get(keyOf(r)) ?? 0) + 1);
  let best = "—";
  let most = 0;
  for (const [k, v] of n) if (v > most) [best, most] = [k, v];
  return best;
}
