import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { erpStockCounts } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { calendarDate } from "@/lib/business-date";
import {
  abcClasses,
  causeCandidates,
  gateCountStatus,
  judgeCount,
  pickCycleCounts,
  reorderJustification,
  stockGate,
  type CauseFact,
  type CountKind,
  type CountStatus,
  type CycleCandidate,
  type Justification,
  type StockGate,
} from "./engines/stock-check";
import { nextNumber, erpId } from "./server";
import { rmLots, stockUnit, type Ex } from "./stock";

/* ---------------------------------------------------------------------------
 * INVENTORY ACCURACY CONTROL, wired to the ledgers. The rules are
 * `engines/stock-check.ts`; this file finds the figures they are handed:
 * the book for one shelf, the movements still on their way into it, the
 * records that are missing anywhere, and which counts a requirement waits on.
 *
 * It never moves stock. The one write here is opening a count.
 * ------------------------------------------------------------------------- */

const today = () => calendarDate(new Date());

async function q<T>(query: ReturnType<typeof sql>, ex: Ex = db): Promise<T[]> {
  return (await ex.execute(query)) as unknown as T[];
}

const n = (v: unknown) => (v == null ? 0 : Number(v));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** A quantity in the material's own unit, in the unit stock is held in (kg → litres by density). */
function toStockUnit(qty: number, unit: string | null, density: number | null): number {
  if (unit === "Kg" && density && density > 0) return r3(qty / density);
  return r3(qty);
}

const fmtDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }) : "");

/* -------------------------------------------------------- one shelf */

export type ShelfFacts = {
  item: string;
  godown: string;
  unit: "Ltr" | "Pcs";
  /** Ledger stock across the item's lots at the godown. */
  book: number;
  lots: { lotNo: string; stock: number }[];
  /** On the shelf, not yet in the book: at the gate, under test, in the register unposted. */
  pendingIn: number;
  /** Off the shelf, not yet out of the book. Every consuming record here is written as the stock is used, so this is zero today and kept for the ledgers that are not. */
  pendingOut: number;
  /** The records that could explain a difference, for `causeCandidates`. */
  facts: CauseFact[];
  tolerancePercent: number;
  toleranceFloor: number;
};

/** Everything a count of one raw material at one godown is judged against. */
export async function shelfFacts(rawMaterialId: string, godownId: string, ex: Ex = db): Promise<ShelfFacts> {
  const day = today();
  const [config, lots, [meta], inward, unposted, issues, fills, transfersOut, receipts] = await Promise.all([
    getConfig(),
    rmLots(ex),
    q<{ item: string; unit: string; density: number | null; tol: number | null; godown: string }>(
      sql`select m.name as item, m.unit, m.density::float8 as density, m.count_tolerance_percent::float8 as tol,
                 (select name from erp_godowns where id = ${godownId}) as godown
            from erp_raw_materials m where m.id = ${rawMaterialId}`,
      ex,
    ),
    /* Delivered and not in the register: matched by its own link, or by PR and item for lines from before the link. */
    q<{ id: string; pr: number; date: string; routed: string | null; qty: number; unit: string }>(
      sql`select i.id, i.pr_number as pr, i.received_date::text as date, i.routed, i.quantity::float8 as qty, i.unit
            from erp_inward i
           where i.raw_material_id = ${rawMaterialId} and i.godown_id = ${godownId}
             and not exists (select 1 from erp_purchases p
                              where p.inward_id = i.id or (p.pr_number = i.pr_number and p.raw_material_id = i.raw_material_id))`,
      ex,
    ),
    q<{ id: string; pr: number; lot: string; date: string; qty: number }>(
      sql`select p.id, p.pr_number as pr, p.lot_no as lot, p.purchase_date::text as date, p.available_litres::float8 as qty
            from erp_purchases p
           where p.raw_material_id = ${rawMaterialId} and p.godown_id = ${godownId}
             and not exists (select 1 from erp_rm_entries e where e.source_type = 'purchase' and e.source_id = p.id)`,
      ex,
    ),
    q<{ id: string; no: number; date: string; qty: number; lot: string }>(
      sql`select id, sfg_no as no, batch_date::text as date, total_use::float8 as qty, lot_code as lot from erp_sfg_lines
           where raw_material_id = ${rawMaterialId} and godown_id = ${godownId} and batch_date >= (${day}::date - 14)`,
      ex,
    ),
    q<{ id: string; no: number; date: string; qty: number }>(
      sql`select id, fg_num as no, fill_date::text as date, cans::float8 as qty from erp_fg_fills
           where can_use_id = ${rawMaterialId} and godown_id = ${godownId} and fill_date >= (${day}::date - 14)`,
      ex,
    ),
    q<{ id: string; date: string; qty: number; lot: string; to: string }>(
      sql`select t.id, t.transfer_date::text as date, t.quantity::float8 as qty, t.lot_no as lot, g.name as to
            from erp_transfers t join erp_godowns g on g.id = t.to_godown_id
           where t.item_type = 'Purchase' and t.item_id = ${rawMaterialId} and t.from_godown_id = ${godownId}
             and t.transfer_date >= (${day}::date - 14)`,
      ex,
    ),
    q<{ id: string; pr: number; lot: string; date: string; qty: number }>(
      sql`select p.id, p.pr_number as pr, p.lot_no as lot, e.entry_date::text as date, e.quantity::float8 as qty
            from erp_rm_entries e join erp_purchases p on p.id = e.source_id
           where e.source_type = 'purchase' and e.raw_material_id = ${rawMaterialId} and e.godown_id = ${godownId}
             and e.entry_date >= (${day}::date - 14)`,
      ex,
    ),
  ]);
  const unit = stockUnit(meta?.unit ?? "Litre");
  const mine = lots.filter((l) => l.rawMaterialId === rawMaterialId && l.godownId === godownId);
  const facts: CauseFact[] = [];
  let pendingIn = 0;
  for (const i of inward) {
    const qty = toStockUnit(i.qty, i.unit, meta?.density ?? null);
    pendingIn += qty;
    const where = i.routed === "Testing" ? "under test" : i.routed === "Purchase" ? "sent to the register, not there" : "at the gate, not sent on";
    facts.push({
      kind: i.routed === "Testing" ? "under_test" : i.routed === "Purchase" ? "unposted_purchase" : "unrouted_inward",
      qty,
      label: `PR ${i.pr} · ${qty} ${unit} received ${fmtDate(i.date)}, ${where}`,
      screen: i.routed === "Testing" ? "testing" : "inward",
      ids: [i.id],
    });
  }
  for (const p of unposted) {
    pendingIn += n(p.qty);
    facts.push({ kind: "unposted_purchase", qty: n(p.qty), label: `PR ${p.pr} · lot ${p.lot} in the register since ${fmtDate(p.date)}, not posted to stock (rate missing)`, screen: "register", ids: [p.id] });
  }
  for (const s of issues) facts.push({ kind: "recent_issue", qty: n(s.qty), label: `SFG ${s.no} (${s.lot}) used ${n(s.qty)} ${unit} on ${fmtDate(s.date)}`, screen: "sfgBatches", ids: [s.id] });
  for (const f of fills) facts.push({ kind: "recent_issue", qty: n(f.qty), label: `FG fill ${f.no} used ${n(f.qty)} cans on ${fmtDate(f.date)}`, screen: "fgFill", ids: [f.id] });
  for (const t of transfersOut) facts.push({ kind: "recent_issue", qty: n(t.qty), label: `Transfer of ${n(t.qty)} ${unit} (lot ${t.lot}) to ${t.to} on ${fmtDate(t.date)}`, screen: "transfers", ids: [t.id] });
  for (const r of receipts) facts.push({ kind: "recent_receipt", qty: n(r.qty), label: `PR ${r.pr} · lot ${r.lot} posted ${n(r.qty)} ${unit} on ${fmtDate(r.date)}`, screen: "register", ids: [r.id] });
  return {
    item: meta?.item ?? "",
    godown: meta?.godown ?? "",
    unit,
    book: r3(mine.reduce((t, l) => t + l.stock, 0)),
    lots: mine.map((l) => ({ lotNo: l.lotNo, stock: l.stock })),
    pendingIn: r3(pendingIn),
    pendingOut: 0,
    facts,
    tolerancePercent: meta?.tol ?? config["erp.stockCheck.tolerancePercent"],
    toleranceFloor: config["erp.stockCheck.toleranceFloor"],
  };
}

/** A shelf's facts judged against one counted figure. */
export function judgeOnShelf(f: ShelfFacts, counted: number) {
  const j = judgeCount({ counted, book: f.book, pendingIn: f.pendingIn, pendingOut: f.pendingOut, tolerancePercent: f.tolerancePercent, toleranceFloor: f.toleranceFloor });
  return { ...j, causes: causeCandidates(j.difference, j.tolerance, f.facts) };
}

/* --------------------------------------------------- opening a count */

export type OpenCount = {
  kind: CountKind;
  rawMaterialId: string;
  godownId: string;
  reason: string;
  dueDate?: string;
  requisitionId?: string | null;
  recountOfId?: string | null;
  assignedToId?: string | null;
  byId: string | null;
};

/**
 * Opens a count — or, where one is already open for that shelf, answers with
 * it: two counters sent to one shelf at once is two answers to one question.
 * A recount is the exception, because its parent is no longer open.
 */
export async function openCount(tx: Ex, c: OpenCount): Promise<{ id: string; countNo: number; created: boolean }> {
  const t = tx as unknown as typeof db;
  if (c.kind !== "recount") {
    const [existing] = await q<{ id: string; no: number; req: string | null }>(
      sql`select id, count_no as no, requisition_id as req from erp_stock_counts
           where raw_material_id = ${c.rawMaterialId} and godown_id = ${c.godownId} and status = 'open' limit 1`,
      tx,
    );
    if (existing) {
      if (c.requisitionId && !existing.req) await t.update(erpStockCounts).set({ requisitionId: c.requisitionId }).where(sql`${erpStockCounts.id} = ${existing.id}`);
      return { id: existing.id, countNo: Number(existing.no), created: false };
    }
  }
  const [unitRow] = await q<{ unit: string }>(sql`select unit from erp_raw_materials where id = ${c.rawMaterialId}`, tx);
  const id = erpId("esc");
  const countNo = await nextNumber(tx, "stockCount");
  await t.insert(erpStockCounts).values({
    id,
    countNo,
    kind: c.kind,
    status: "open",
    rawMaterialId: c.rawMaterialId,
    godownId: c.godownId,
    unit: stockUnit(unitRow?.unit ?? "Litre"),
    requisitionId: c.requisitionId ?? null,
    recountOfId: c.recountOfId ?? null,
    reason: c.reason,
    assignedToId: c.assignedToId ?? null,
    dueDate: c.dueDate ?? today(),
    createdById: c.byId,
  });
  return { id, countNo, created: true };
}

export const countLabel = (no: number) => `SC-${no}`;

/* ------------------------------------------------- the purchase gate */

export type GateInfo = {
  gate: StockGate;
  /** The count the gate reads, where there is one. */
  count: { id: string; countNo: number; status: CountStatus; kind: string } | null;
  justification: Justification | null;
  /** What is on the shelf by the newest count, in the stock unit. */
  onShelf: number | null;
  unit: "Ltr" | "Pcs";
};

type GateReq = {
  id: string;
  rawMaterialId: string | null;
  godownId: string;
  createdAt: Date;
  requiredQty: number;
  unit: string;
  stockCheckRequired: boolean;
  stockExceptionStatus: string | null;
  qtyConfirmedAt: Date | null;
};

const LIVE: CountStatus[] = ["open", "flagged", "recount", "investigating"];

/**
 * Where each requirement stands with its stock check. A requirement reads
 * the counts raised for it, any later count of its shelf, and any count of
 * its shelf still unresolved — an open discrepancy on a shelf blocks every
 * purchase for it, which is the point.
 */
export async function gatesFor(reqs: GateReq[]): Promise<Map<string, GateInfo>> {
  const out = new Map<string, GateInfo>();
  const want = reqs.filter((r) => r.stockCheckRequired && r.rawMaterialId);
  if (!want.length) return out;
  const items = [...new Set(want.map((r) => r.rawMaterialId as string))];
  const [counts, levels, mats, config] = await Promise.all([
    q<{ id: string; no: number; status: CountStatus; kind: string; req: string | null; parent: string | null; rm: string; godown: string; created: string; counted: number | null; countedAt: string | null }>(
      sql`select id, count_no as no, status, kind, requisition_id as req, recount_of_id as parent, raw_material_id as rm, godown_id as godown,
                 created_at::text as created, counted_qty::float8 as counted, counted_at::text as "countedAt"
            from erp_stock_counts where raw_material_id in ${items}`,
    ),
    q<{ rm: string; godown: string; min: number; max: number }>(
      sql`select raw_material_id as rm, godown_id as godown, min_qty::float8 as min, max_qty::float8 as max from erp_rm_levels
           where raw_material_id in ${items}`,
    ),
    q<{ id: string; unit: string; density: number | null }>(
      sql`select id, unit, density::float8 as density from erp_raw_materials where id in ${items}`,
    ),
    getConfig(),
  ]);
  const matOf = new Map(mats.map((m) => [m.id, m]));
  for (const r of want) {
    const rm = r.rawMaterialId as string;
    const shelf = counts.filter((c) => c.rm === rm && c.godown === r.godownId);
    const roots = shelf.filter((c) => !c.parent && (c.req === r.id || new Date(c.created) >= r.createdAt || LIVE.includes(c.status)));
    const status = gateCountStatus(roots.map((c) => ({ status: c.status, createdAt: new Date(c.created) })));
    const root = status ? [...roots].filter((c) => c.status === status).sort((a, b) => b.created.localeCompare(a.created))[0] : null;
    /* The newest figure anybody counted for this check — the root or a recount of it. */
    const family = root ? shelf.filter((c) => (c.id === root.id || c.parent === root.id) && c.countedAt) : [];
    const latest = family.sort((a, b) => String(b.countedAt).localeCompare(String(a.countedAt)))[0];
    const onShelf = latest?.counted ?? null;
    const m = matOf.get(rm);
    const level = levels.find((l) => l.rm === rm && l.godown === r.godownId);
    const requested = toStockUnit(r.requiredQty, r.unit, m?.density ?? null);
    const justification =
      onShelf != null ? reorderJustification({ requested, onShelf, min: level?.min ?? null, max: level?.max ?? null, allowancePercent: config["erp.stockCheck.unexpectedQtyPercent"] }) : null;
    const gate = stockGate({
      required: true,
      countStatus: status,
      exception: (r.stockExceptionStatus as "requested" | "approved" | "rejected" | null) ?? null,
      unexpectedQty: !!justification?.unexpected,
      qtyConfirmed: !!r.qtyConfirmedAt,
    });
    out.set(r.id, {
      gate,
      count: root ? { id: root.id, countNo: Number(root.no), status: root.status, kind: root.kind } : null,
      justification,
      onShelf,
      unit: stockUnit(m?.unit ?? "Litre"),
    });
  }
  return out;
}

/* ---------------------------------------------------- missing records */

export type MissingRecord = {
  id: string;
  kind: "sfg_no_entry" | "fill_no_entry" | "purchase_no_entry" | "inward_waiting" | "transfer_no_in" | "pack_incomplete";
  title: string;
  detail: string;
  date: string;
  godown: string;
  item: string;
  /** Always a missing RECORD of a movement — the goods are where they are; the book has not caught up. */
  missing: "transaction";
  screen: string;
  ids: string[];
};

export const MISSING_LABEL: Record<MissingRecord["kind"], string> = {
  sfg_no_entry: "Batch completed, no SFG receipt",
  fill_no_entry: "Filling complete, no FG receipt",
  purchase_no_entry: "Receipt with no inventory entry",
  inward_waiting: "Goods received, not yet in stock",
  transfer_no_in: "Transfer issued, not received",
  pack_incomplete: "Packing not matching the cans filled",
};

/**
 * Every record that should have a stock entry and does not, across the ERP.
 * A SUGGESTION list: each row says what is missing and opens the record
 * behind it; nothing here creates the entry, because the entry is a fact
 * somebody has to stand behind.
 */
export async function missingRecords(): Promise<MissingRecord[]> {
  const day = today();
  const [sfg, fills, purchases, inward, transfers, packs] = await Promise.all([
    q<{ id: string; no: number; lot: string; date: string; godown: string; item: string; qty: number }>(sql`
      select l.id, l.sfg_no as no, l.lot_code as lot, l.batch_date::text as date, g.name as godown, f.name as item, l.total_use::float8 as qty
        from erp_sfg_lines l join erp_godowns g on g.id = l.godown_id join product_formulations f on f.id = l.formulation_id
       where not exists (select 1 from erp_sfg_entries e where e.source_type = 'sfg' and e.source_id = l.id)
       order by l.batch_date desc limit 200`),
    q<{ id: string; no: number; lot: string; date: string; godown: string; item: string; cans: number }>(sql`
      select x.id, x.fg_num as no, x.lot_code as lot, x.fill_date::text as date, g.name as godown, fg.name as item, x.cans
        from erp_fg_fills x join erp_godowns g on g.id = x.godown_id join finished_goods fg on fg.id = x.finished_good_id
       where not exists (select 1 from erp_fg_entries e where e.source_type = 'fill' and e.source_id = x.id)
       order by x.fill_date desc limit 200`),
    q<{ id: string; pr: number; lot: string; date: string; godown: string; item: string; qty: number; rate: number | null }>(sql`
      select p.id, p.pr_number as pr, p.lot_no as lot, p.purchase_date::text as date, g.name as godown, m.name as item,
             p.quantity::float8 as qty, p.rate_paise::float8 as rate
        from erp_purchases p join erp_godowns g on g.id = p.godown_id join erp_raw_materials m on m.id = p.raw_material_id
       where not exists (select 1 from erp_rm_entries e where e.source_type = 'purchase' and e.source_id = p.id)
       order by p.purchase_date desc limit 200`),
    q<{ id: string; pr: number; date: string; godown: string; item: string; qty: number; unit: string; routed: string | null }>(sql`
      select i.id, i.pr_number as pr, i.received_date::text as date, g.name as godown, m.name as item, i.quantity::float8 as qty, i.unit, i.routed
        from erp_inward i join erp_godowns g on g.id = i.godown_id join erp_raw_materials m on m.id = i.raw_material_id
       where i.received_date <= (${day}::date - 2)
         and not exists (select 1 from erp_purchases p where p.inward_id = i.id or (p.pr_number = i.pr_number and p.raw_material_id = i.raw_material_id))
       order by i.received_date desc limit 200`),
    q<{ id: string; date: string; type: string; item: string; lot: string; qty: number; from: string; to: string }>(sql`
      select t.id, t.transfer_date::text as date, t.item_type as type, t.item_name as item, t.lot_no as lot, t.quantity::float8 as qty,
             gf.name as from, gt.name as to
        from erp_transfers t join erp_godowns gf on gf.id = t.from_godown_id join erp_godowns gt on gt.id = t.to_godown_id
       where not exists (
         select 1 from erp_rm_entries e where t.item_type = 'Purchase' and e.source_type = 'transfer' and e.source_id = t.id
         union all select 1 from erp_sfg_entries e where t.item_type = 'Semi Finished' and e.source_type = 'transfer' and e.source_id = t.id
         union all select 1 from erp_fg_entries e where t.item_type = 'Finish Goods' and e.source_type = 'transfer' and e.source_id = t.id
         union all select 1 from erp_pack_entries e where t.item_type = 'FG Packing' and e.source_type = 'transfer' and e.source_id = t.id)
       order by t.transfer_date desc limit 200`),
    q<{ batch: string; id: string; date: string; godown: string; item: string; boxes: number; cpb: number; cans: number }>(sql`
      select l.batch_no as batch, min(l.id) as id, min(l.pack_date)::text as date, min(g.name) as godown, min(p.name) as item,
             max(l.boxes)::float8 as boxes, coalesce(max(p.cans_per_box), 1)::float8 as cpb, sum(l.cans)::float8 as cans
        from erp_pack_lines l join erp_godowns g on g.id = l.godown_id join products p on p.id = l.sku_id
       group by l.batch_no
      having sum(l.cans) <> max(l.boxes) * coalesce(max(p.cans_per_box), 1) and min(l.pack_date) <= (${day}::date - 1)
       order by min(l.pack_date) desc limit 200`),
  ]);
  const out: MissingRecord[] = [];
  for (const x of sfg)
    out.push({ id: `sfg:${x.id}`, kind: "sfg_no_entry", title: MISSING_LABEL.sfg_no_entry, detail: `SFG ${x.no}, lot ${x.lot}: the batch line is saved and its yield never reached SFG stock.`, date: x.date, godown: x.godown, item: x.item, missing: "transaction", screen: "sfgBatches", ids: [x.id] });
  for (const x of fills)
    out.push({ id: `fill:${x.id}`, kind: "fill_no_entry", title: MISSING_LABEL.fill_no_entry, detail: `FG fill ${x.no}, lot ${x.lot}: ${x.cans} cans filled and never in FG stock.`, date: x.date, godown: x.godown, item: x.item, missing: "transaction", screen: "fgFill", ids: [x.id] });
  for (const x of purchases)
    out.push({
      id: `pur:${x.id}`,
      kind: "purchase_no_entry",
      title: MISSING_LABEL.purchase_no_entry,
      detail: `PR ${x.pr}, lot ${x.lot}: in the purchase register and not in raw-material stock${x.rate == null ? " — its rate is missing, which is what posts it" : ""}.`,
      date: x.date,
      godown: x.godown,
      item: x.item,
      missing: "transaction",
      screen: "register",
      ids: [x.id],
    });
  for (const x of inward)
    out.push({
      id: `inw:${x.id}`,
      kind: "inward_waiting",
      title: MISSING_LABEL.inward_waiting,
      detail: `PR ${x.pr}: ${x.qty} ${x.unit} received ${fmtDate(x.date)}, ${x.routed === "Testing" ? "under test" : x.routed === "Purchase" ? "sent to the register and not there" : "never sent to testing or the register"}.`,
      date: x.date,
      godown: x.godown,
      item: x.item,
      missing: "transaction",
      screen: x.routed === "Testing" ? "testing" : "inward",
      ids: [x.id],
    });
  for (const x of transfers)
    out.push({ id: `trf:${x.id}`, kind: "transfer_no_in", title: MISSING_LABEL.transfer_no_in, detail: `${x.qty} of lot ${x.lot} left ${x.from} for ${x.to} and never reached ${x.to}'s stock.`, date: x.date, godown: x.to, item: x.item, missing: "transaction", screen: "transfers", ids: [x.id] });
  for (const x of packs)
    out.push({
      id: `pack:${x.batch}`,
      kind: "pack_incomplete",
      title: MISSING_LABEL.pack_incomplete,
      detail: `Batch ${x.batch}: ${x.boxes} boxes of ${x.cpb} need ${x.boxes * x.cpb} cans and ${x.cans} were drawn — the boxes are not in packing stock until it matches.`,
      date: x.date,
      godown: x.godown,
      item: x.item,
      missing: "transaction",
      screen: "packBatches",
      ids: [x.id],
    });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/* ------------------------------------------------- the daily cycle count */

export type CyclePlan = { opened: number; skipped: string | null; picks: { key: string; reason: string }[] };

/**
 * Opens today's cycle counts: items ranked by ABC class (value moved over 90
 * days), how overdue, how often they move and how often they were wrong.
 * Idempotent: a second run the same day opens only what the day's allowance
 * has left.
 */
export async function planCycleCounts(byId: string | null = null): Promise<CyclePlan> {
  const config = await getConfig();
  const limit = config["erp.stockCheck.dailyCount"];
  if (limit <= 0) return { opened: 0, skipped: "the daily cycle count is set to zero", picks: [] };
  const day = today();
  const [[{ done }], lots, moved, history] = await Promise.all([
    q<{ done: number }>(sql`select count(*)::int as done from erp_stock_counts where kind = 'cycle' and due_date = ${day}`),
    rmLots(),
    q<{ rm: string; godown: string; qty: number; moves: number }>(sql`
      select rm, godown, sum(qty)::float8 as qty, count(*)::int as moves from (
        select raw_material_id as rm, godown_id as godown, quantity as qty from erp_rm_entries where entry_date >= (${day}::date - 90)
        union all select raw_material_id, godown_id, total_use from erp_sfg_lines where batch_date >= (${day}::date - 90)
        union all select item_id, from_godown_id, quantity from erp_transfers where item_type = 'Purchase' and transfer_date >= (${day}::date - 90)
        union all select can_use_id, godown_id, cans from erp_fg_fills where can_use_id is not null and fill_date >= (${day}::date - 90)
      ) m group by 1, 2`),
    q<{ rm: string; godown: string; last: string | null; wrong: number; open: number }>(sql`
      select raw_material_id as rm, godown_id as godown,
             max((counted_at at time zone 'Asia/Kolkata')::date)::text as last,
             count(*) filter (where recount_of_id is null and created_at >= now() - interval '90 days'
                              and (status in ('flagged', 'recount', 'investigating') or resolution in ('adjusted', 'missing_entry')))::int as wrong,
             count(*) filter (where status = 'open')::int as open
        from erp_stock_counts where status <> 'cancelled' group by 1, 2`),
  ]);
  const left = limit - Number(done);
  if (left <= 0) return { opened: 0, skipped: `today's ${limit} cycle counts are already open`, picks: [] };
  /* Every shelf that holds stock or moved lately is a candidate; Item Lost Record never is. */
  const [lost] = await q<{ id: string }>(sql`select id from erp_godowns where reserved limit 1`);
  const shelves = new Map<string, { rm: string; godown: string; value: number; moves: number; rate: number }>();
  for (const l of lots) {
    if (l.godownId === lost?.id || (l.stock <= 0 && !moved.some((m) => m.rm === l.rawMaterialId && m.godown === l.godownId))) continue;
    const k = `${l.rawMaterialId}|${l.godownId}`;
    const s = shelves.get(k) ?? { rm: l.rawMaterialId, godown: l.godownId, value: 0, moves: 0, rate: 0 };
    s.rate = Math.max(s.rate, l.ratePaise ?? 0);
    shelves.set(k, s);
  }
  for (const m of moved) {
    const s = shelves.get(`${m.rm}|${m.godown}`);
    if (!s) continue;
    s.moves = Number(m.moves);
    /* A shelf with no rate still moved: weigh it by quantity so it is not always C. */
    s.value = Number(m.qty) * (s.rate || 1);
  }
  const classes = abcClasses([...shelves.entries()].map(([key, s]) => ({ key, value: s.value })));
  const hist = new Map(history.map((h) => [`${h.rm}|${h.godown}`, h]));
  const cands: CycleCandidate[] = [...shelves.keys()].map((key) => {
    const h = hist.get(key);
    return { key, abc: classes.get(key) ?? "C", lastCounted: h?.last ?? null, movements: shelves.get(key)!.moves, discrepancies: Number(h?.wrong ?? 0), hasOpenCount: Number(h?.open ?? 0) > 0 };
  });
  const picks = pickCycleCounts(cands, day, { A: config["erp.stockCheck.cycleDaysA"], B: config["erp.stockCheck.cycleDaysB"], C: config["erp.stockCheck.cycleDaysC"] }, left);
  let opened = 0;
  await db.transaction(async (tx) => {
    for (const p of picks) {
      const [rm, godown] = p.key.split("|");
      const r = await openCount(tx, { kind: "cycle", rawMaterialId: rm, godownId: godown, reason: `Daily cycle count — ${p.reason}`, byId });
      if (r.created) opened++;
    }
  });
  return { opened, skipped: null, picks: picks.map((p) => ({ key: p.key, reason: p.reason })) };
}

/**
 * Opens a count of every shelf at one godown that holds stock — the periodic
 * comprehensive count, or a count after an event (a spill, a move).
 */
export async function openGodownCounts(godownId: string, kind: "full" | "event", reason: string, byId: string | null): Promise<number> {
  const lots = (await rmLots()).filter((l) => l.godownId === godownId && l.stock > 0);
  const items = [...new Set(lots.map((l) => l.rawMaterialId))];
  let opened = 0;
  await db.transaction(async (tx) => {
    for (const rm of items) if ((await openCount(tx, { kind, rawMaterialId: rm, godownId, reason, byId })).created) opened++;
  });
  return opened;
}

/** When the last comprehensive count finished, and whether the next is due. */
export async function fullCountDue(): Promise<{ last: string | null; due: boolean; everyDays: number }> {
  const every = (await getConfig())["erp.stockCheck.fullCountDays"];
  const [r] = await q<{ last: string | null }>(sql`select max((created_at at time zone 'Asia/Kolkata')::date)::text as last from erp_stock_counts where kind = 'full'`);
  const last = r?.last ?? null;
  if (every <= 0) return { last, due: false, everyDays: every };
  const due = !last || (Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000 >= every;
  return { last, due, everyDays: every };
}

/* ------------------------------------------------------ the dashboard */

export type ControlWork = {
  /** Open counts; `due` is whether it is due today or overdue. */
  toCount: { id: string; godown: string; due: boolean }[];
  flags: { id: string; godown: string }[];
  recounts: { id: string; godown: string }[];
  investigating: { id: string; godown: string }[];
  adjustments: { id: string; godown: string }[];
  exceptions: { id: string; godown: string }[];
  missing: number;
  /** The reasons adjustments were approved for over 90 days, most frequent first. */
  repeatCauses: { reason: string; n: number }[];
  /** Counts finished over 30 days, and how many matched first time. */
  accuracy: { counted: number; matched: number };
};

/** The control's work waiting now, for the dashboard tiles and the sidebar badge. */
export async function controlWork(): Promise<ControlWork> {
  const day = today();
  const [counts, adj, ex, missing, causes, acc] = await Promise.all([
    q<{ id: string; status: CountStatus; parent: string | null; due: string; godown: string }>(sql`
      select c.id, c.status, c.recount_of_id as parent, c.due_date::text as due, g.name as godown
        from erp_stock_counts c join erp_godowns g on g.id = c.godown_id
       where c.status in ('open', 'flagged', 'recount', 'investigating')`),
    q<{ id: string; godown: string }>(sql`select a.id, g.name as godown from erp_stock_adjustments a join erp_godowns g on g.id = a.godown_id where a.status = 'pending'`),
    q<{ id: string; godown: string }>(sql`select r.id, g.name as godown from erp_requisitions r join erp_godowns g on g.id = r.godown_id where r.stock_exception_status = 'requested' and r.status = 'Pending'`),
    missingRecords().then((m) => m.length),
    q<{ reason: string; n: number }>(sql`
      select reason_code as reason, count(*)::int as n from erp_stock_adjustments
       where status = 'approved' and decided_at >= now() - interval '90 days' group by 1 order by 2 desc limit 5`),
    q<{ counted: number; matched: number }>(sql`
      select count(*)::int as counted, count(*) filter (where status = 'matched')::int as matched from erp_stock_counts
       where recount_of_id is null and counted_at >= now() - interval '30 days'`),
  ]);
  const pick = (f: (c: (typeof counts)[number]) => boolean) => counts.filter(f).map((c) => ({ id: c.id, godown: c.godown }));
  return {
    toCount: counts.filter((c) => c.status === "open").map((c) => ({ id: c.id, godown: c.godown, due: c.due <= day })),
    flags: pick((c) => !c.parent && c.status === "flagged"),
    recounts: pick((c) => !c.parent && c.status === "recount"),
    investigating: pick((c) => !c.parent && c.status === "investigating"),
    adjustments: adj,
    exceptions: ex,
    missing,
    repeatCauses: causes.map((c) => ({ reason: c.reason, n: Number(c.n) })),
    accuracy: { counted: Number(acc[0]?.counted ?? 0), matched: Number(acc[0]?.matched ?? 0) },
  };
}

/** Requirements the stock check is holding right now. */
export async function heldRequirements(): Promise<{ id: string; godown: string }[]> {
  const rows = await q<GateReq & { godown: string; created: string; confirmed: string | null }>(sql`
    select r.id, r.raw_material_id as "rawMaterialId", r.godown_id as "godownId", r.created_at::text as created,
           r.required_qty::float8 as "requiredQty", r.unit, r.stock_check_required as "stockCheckRequired",
           r.stock_exception_status as "stockExceptionStatus", r.qty_confirmed_at::text as confirmed, g.name as godown
      from erp_requisitions r join erp_godowns g on g.id = r.godown_id
     where r.stock_check_required and r.status = 'Pending'
       and not exists (select 1 from erp_po_lines l join erp_purchase_orders o on o.id = l.po_id
                        where l.requisition_id = r.id and o.status in ('Pending approval', 'Approved', 'Sent', 'Partly received', 'Received', 'Closed'))`);
  const gates = await gatesFor(rows.map((r) => ({ ...r, createdAt: new Date(r.created), qtyConfirmedAt: r.confirmed ? new Date(r.confirmed) : null })));
  return rows.filter((r) => gates.get(r.id)?.gate.blocks).map((r) => ({ id: r.id, godown: r.godown }));
}
