import type { MrpAnswer } from "./mrp";
import { sizeName, type PlanCategory, type UnderProcessLine } from "./production-plan";

/* ---------------------------------------------------------------------------
 * EXPECTED ORDERS ON THE DAY'S PLAN — pure. Production plans at ten and
 * Accounts approve at twelve, so the plan shows, beside what is CONFIRMED
 * (cleared at the MRP check, the plan's own order lines), what is EXPECTED:
 * orders Accounts approved that wait for the MRP check, and TOs that wait for
 * Accounts. Expected work is counted so the day can be planned and is never a
 * plan line: only the base (SFG) may be started ahead, as a typed line marked
 * for expected orders. A held TO, or one with no godown, is listed and not
 * counted. Everything is in cans; a boxed product says its boxes beside them.
 * ------------------------------------------------------------------------- */

export type ExpectedStage = "confirmed" | "mrp" | "accounts";

export type DemandLine = UnderProcessLine & { formulationId?: string | null; formulationName?: string | null; party?: string | null };

/** One order or TO the plan is reading, with where it is. */
export type ExpectedSource = {
  key: string;
  stage: Exclude<ExpectedStage, "confirmed">;
  orderNo: number | null;
  toNo: number | null;
  party: string;
  /** When it reached where it waits: approved by Accounts, or the TO taken. */
  since: string;
  by: string | null;
  held: boolean;
  holdReason: string | null;
  sentBack: boolean;
  noGodown: boolean;
  lines: DemandLine[];
};

export type PlanStock = {
  /** Loose filled cans by finished good (or SKU where none). */
  looseCans: Map<string, number>;
  /** Packed boxes by SKU. */
  packedBoxes: Map<string, number>;
  /** QC-approved base in the tank, litres, by formulation. */
  baseLitres: Map<string, number>;
};

export type ProductOrder = { stage: ExpectedStage; ref: string; party: string; cans: number; since: string | null };

export type ProductRow = {
  key: string;
  category: Exclude<PlanCategory, "sfg">;
  /** The finished good (loose) or SKU (packing) a plan line names; null for a loose SKU with no finished good. */
  itemId: string | null;
  name: string;
  size: string | null;
  code: string | null;
  /** "loose" or "6 cans/box". */
  packing: string;
  cansPerBox: number;
  confirmed: number;
  mrp: number;
  accounts: number;
  stock: number;
  verdict: { tone: "ok" | "short"; text: string; note: string | null };
  orders: ProductOrder[];
};

export type BaseRow = {
  formulationId: string;
  name: string;
  /** Litres still to fill for confirmed orders, beyond the cans already filled. */
  confirmedLitres: number;
  expectedLitres: number;
  inTank: number;
  shortLitres: number;
  /** The expected orders and TOs the base is for, oldest first: "TO-1051". */
  expectedFor: string[];
};

export type ExpectedPlan = {
  products: ProductRow[];
  bases: BaseRow[];
  counts: { confirmedOrders: number; mrpOrders: number; accountsTos: number; oldestAccounts: string | null };
  shortProducts: string[];
};

const r1 = (n: number) => Math.round(n * 10) / 10;

export const sourceRef = (s: { orderNo: number | null; toNo: number | null }) => (s.orderNo != null ? `Order ${s.orderNo}` : `TO-${s.toNo}`);

/** A held TO, or one with no godown, is listed but adds nothing to the day's figures. */
export const counted = (s: ExpectedSource) => !s.held && !s.noGodown;

export function expectedPlan(confirmed: DemandLine[], sources: ExpectedSource[], stockIn: PlanStock): ExpectedPlan {
  type Acc = Omit<ProductRow, "stock" | "verdict" | "category"> & { fg: string; litresPerCan: number; formulationId: string | null; formulationName: string | null; expectedRefs: Map<string, string> };
  const by = new Map<string, Acc>();
  const add = (l: DemandLine, stage: ExpectedStage, ref: string, party: string, since: string | null, sinceKey: string) => {
    if (!(l.qtyCans > 0)) return;
    const cpb = Math.max(1, l.cansPerBox || 1);
    const loose = cpb <= 1;
    const key = loose ? `loose:${l.finishedGoodId ?? l.skuId}` : `packing:${l.skuId}`;
    let a = by.get(key);
    if (!a) {
      a = {
        key,
        fg: l.finishedGoodId ?? l.skuId,
        itemId: loose ? (l.finishedGoodId ?? null) : l.skuId,
        name: loose ? (l.finishedGoodName ?? l.skuName) : l.skuName,
        size: sizeName(l.millilitres),
        code: loose ? (l.looseCode ?? l.skuCode) : l.skuCode,
        packing: loose ? "loose" : `${cpb} cans/box`,
        cansPerBox: cpb,
        confirmed: 0,
        mrp: 0,
        accounts: 0,
        orders: [],
        litresPerCan: (l.millilitres ?? 0) / 1000,
        formulationId: l.formulationId ?? null,
        formulationName: l.formulationName ?? null,
        expectedRefs: new Map(),
      };
      by.set(key, a);
    }
    a[stage] += l.qtyCans;
    const same = a.orders.find((o) => o.ref === ref && o.stage === stage);
    if (same) same.cans += l.qtyCans;
    else a.orders.push({ stage, ref, party, cans: l.qtyCans, since });
    if (stage !== "confirmed") a.expectedRefs.set(sinceKey, ref);
  };
  for (const l of confirmed) add(l, "confirmed", `Order ${l.orderNo}`, l.party ?? "", null, "");
  const live = sources.filter(counted).sort((x, y) => x.since.localeCompare(y.since));
  for (const s of live) for (const l of s.lines) add(l, s.stage, sourceRef(s), s.party, s.since, `${s.since}|${s.key}`);

  const products: ProductRow[] = [];
  const bases = new Map<string, BaseRow & { refs: Map<string, string> }>();
  /* Filled cans of a finished good serve its loose orders first; what is left can be boxed, as the MRP check reads it. */
  const looseLeft = new Map(stockIn.looseCans);
  for (const a of by.values())
    if (a.key.startsWith("loose:")) looseLeft.set(a.fg, Math.max(0, (looseLeft.get(a.fg) ?? 0) - (a.confirmed + a.mrp + a.accounts)));
  const rows = [...by.values()].sort((x, y) => Number(y.key.startsWith("loose:")) - Number(x.key.startsWith("loose:")));
  for (const a of rows) {
    let stock: number;
    if (a.key.startsWith("loose:")) stock = stockIn.looseCans.get(a.fg) ?? 0;
    else {
      const boxedCans = (stockIn.packedBoxes.get(a.key.slice(8)) ?? 0) * a.cansPerBox;
      const spare = looseLeft.get(a.fg) ?? 0;
      const use = Math.min(spare, Math.max(0, a.confirmed + a.mrp + a.accounts - boxedCans));
      looseLeft.set(a.fg, spare - use);
      stock = boxedCans + use;
    }
    const total = a.confirmed + a.mrp + a.accounts;
    let verdict: ProductRow["verdict"];
    if (stock >= total) verdict = { tone: "ok", text: `Enough · ${total === 0 ? 0 : stock - total} spare`, note: null };
    else {
      const short = total - stock;
      const extra = a.cansPerBox > 1 ? `${Math.ceil(short / a.cansPerBox)} boxes` : a.litresPerCan > 0 ? `${nf(r1(short * a.litresPerCan))} L` : null;
      verdict = { tone: "short", text: `Short ${short} cans${extra ? ` · ${extra}` : ""}`, note: a.mrp + a.accounts === 0 ? "(confirmed)" : null };
    }
    const order = { confirmed: 0, mrp: 1, accounts: 2 };
    products.push({
      key: a.key,
      category: a.key.startsWith("loose:") ? "loose" : "packing",
      itemId: a.itemId,
      name: a.name,
      size: a.size,
      code: a.code,
      packing: a.packing,
      cansPerBox: a.cansPerBox,
      confirmed: a.confirmed,
      mrp: a.mrp,
      accounts: a.accounts,
      stock,
      verdict,
      orders: [...a.orders].sort((x, y) => order[x.stage] - order[y.stage] || (x.since ?? "").localeCompare(y.since ?? "")),
    });
    if (a.formulationId && a.litresPerCan > 0) {
      const confirmedFill = Math.max(0, a.confirmed - stock);
      const totalFill = Math.max(0, total - stock);
      const b = bases.get(a.formulationId) ?? { formulationId: a.formulationId, name: a.formulationName ?? "Base", confirmedLitres: 0, expectedLitres: 0, inTank: 0, shortLitres: 0, expectedFor: [], refs: new Map() };
      b.confirmedLitres = r1(b.confirmedLitres + confirmedFill * a.litresPerCan);
      b.expectedLitres = r1(b.expectedLitres + (totalFill - confirmedFill) * a.litresPerCan);
      if (totalFill > confirmedFill) for (const [k, ref] of a.expectedRefs) b.refs.set(k, ref);
      bases.set(a.formulationId, b);
    }
  }
  const baseRows = [...bases.values()]
    .map(({ refs, ...b }) => {
      const inTank = r1(stockIn.baseLitres.get(b.formulationId) ?? 0);
      return { ...b, inTank, shortLitres: r1(Math.max(0, b.confirmedLitres + b.expectedLitres - inTank)), expectedFor: [...new Set([...refs].sort(([x], [y]) => x.localeCompare(y)).map(([, r]) => r))] };
    })
    .filter((b) => b.confirmedLitres > 0 || b.expectedLitres > 0)
    .sort((x, y) => y.shortLitres - x.shortLitres || x.name.localeCompare(y.name));

  products.sort((x, y) => (x.verdict.tone === y.verdict.tone ? 0 : x.verdict.tone === "short" ? -1 : 1) || x.name.localeCompare(y.name));
  const accountsTos = live.filter((s) => s.stage === "accounts");
  return {
    products,
    bases: baseRows,
    counts: {
      confirmedOrders: new Set(confirmed.filter((l) => l.qtyCans > 0).map((l) => l.orderNo)).size,
      mrpOrders: live.filter((s) => s.stage === "mrp").length,
      accountsTos: accountsTos.length,
      oldestAccounts: accountsTos.length ? accountsTos[0].since : null,
    },
    shortProducts: products.filter((p) => p.verdict.tone === "short").map((p) => p.name),
  };
}

const NF = new Intl.NumberFormat("en-IN");
const nf = (n: number) => NF.format(n);

/**
 * The words in an expected order's Stock check column, from the MRP check's
 * own answer for it: planning only, nothing here is cleared. Material shorts
 * first, then each product: on the shelf, base in the tank, or base short.
 */
export function stockCheckWords(answer: MrpAnswer, formulationOf: Map<string, string | null>): { tone: "ok" | "short"; lines: { tone: "ok" | "short"; text: string }[] } {
  const materials = answer.bases.flatMap((b) => b.materials).filter((m) => m.short > 0);
  const cans = answer.cans.filter((c) => c.short > 0);
  const short = [...materials.map((m) => `${m.name} ${nf(m.short)}${m.unit ? ` ${unitShort(m.unit)}` : ""}`.trim()), ...cans.map((c) => `${c.name} ${nf(c.short)}`)];
  if (answer.lines.every((l) => l.toMakeCans === 0)) return { tone: "ok", lines: [{ tone: "ok", text: "All in stock" }] };
  if (short.length) return { tone: "short", lines: [{ tone: "short", text: `Short: ${short.slice(0, 2).join(", ")}${short.length > 2 ? ` and ${short.length - 2} more` : ""}` }] };
  const baseOf = new Map(answer.bases.map((b) => [b.formulationId, b]));
  const lines = answer.lines.map((l) => {
    const fid = formulationOf.get(l.lineId) ?? null;
    const b = fid ? baseOf.get(fid) : undefined;
    const name = shortName(l.sku);
    if (l.toMakeCans === 0) return { tone: "ok" as const, text: `${name}: enough` };
    if (!b) return { tone: "short" as const, text: `${name}: no base named` };
    return b.shortLitres > 0 ? { tone: "short" as const, text: `${name}: base short ${nf(Math.round(b.shortLitres))} L` } : { tone: "ok" as const, text: `${name}: base in tank` };
  });
  const tone = lines.some((l) => l.tone === "short") ? "short" : "ok";
  return { tone, lines: lines.length === 1 && tone === "ok" ? [{ tone: "ok", text: "Can be made" }] : lines };
}

const unitShort = (u: string) => (u === "Litre" ? "L" : u === "Kg" ? "kg" : u === "Pcs" ? "" : u);

/** "Nano Thinner - 20 Liter (Loose)" → "Nano Thinner": the first words, enough to tell lines apart. */
function shortName(sku: string): string {
  return sku.split(/\s+-\s+|\s*\(/)[0].trim() || sku;
}
