import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import { fgLots, packLots, rmLots, sfgLots } from "./stock";
import type { DateWindow } from "./period";
import type { AdjustStage } from "./engines/stock-adjust";
import { adjustReasonText } from "./engines/stock-adjust";

/* ---------------------------------------------------------------------------
 * STOCK INQUIRY — one item of one stage, in detail: what is in stock now and
 * where, and every movement in and out over a period with a running balance.
 *
 * The movements are read from the SAME sources `stock.ts` adds up: the stage's
 * inflow ledger, and the documents that consume it (transfers out, SFG use,
 * filling, packing, lot allocations to orders, returns to the vendor, the cans
 * and boxes filling and packing use). Item Lost Record is left out entirely —
 * stock written off there has left, and counting it at both ends would make
 * every write-off read as nothing.
 * ------------------------------------------------------------------------- */

export type Movement = {
  date: string;
  kind: string;
  doc: string | null;
  lot: string | null;
  godown: string;
  qty: number;
  note: string | null;
  by: string | null;
  balance: number;
};

export type InquiryLot = { lot: string; godownId: string; godown: string; stock: number; since: string };

export type Inquiry = {
  stage: AdjustStage;
  itemId: string;
  item: string;
  unit: string;
  lots: InquiryLot[];
  stockNow: number;
  opening: number;
  totalIn: number;
  totalOut: number;
  adjusted: number;
  movements: Movement[];
  /** More movements in the period than are drawn; the newest are kept. */
  capped: boolean;
};

export const MOVEMENT_CAP = 2000;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The items of a stage that hold stock somewhere (Item Lost Record aside), for the picker. */
export async function inquiryItems(stage: AdjustStage): Promise<{ id: string; name: string }[]> {
  const lots = await lotsOf(stage);
  const seen = new Map<string, string>();
  for (const l of lots) if (!seen.has(l.itemId)) seen.set(l.itemId, l.item);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

type AnyLot = { itemId: string; item: string; lot: string; godownId: string; godown: string; stock: number; unit: string; since: string };

async function lotsOf(stage: AdjustStage): Promise<AnyLot[]> {
  const reserved = new Set(((await db.execute(sql`select id from erp_godowns where reserved`)) as unknown as { id: string }[]).map((g) => g.id));
  const keep = (l: AnyLot) => !reserved.has(l.godownId) && Math.abs(l.stock) > 0.0005;
  if (stage === "rm")
    return (await rmLots()).map((l) => ({ itemId: l.rawMaterialId, item: l.item, lot: l.lotNo, godownId: l.godownId, godown: l.godown, stock: l.stock, unit: l.unit, since: l.latestDate })).filter(keep);
  if (stage === "sfg")
    return (await sfgLots()).map((l) => ({ itemId: l.formulationId, item: l.product, lot: l.lotCode, godownId: l.godownId, godown: l.godown, stock: l.stock, unit: "Ltr", since: l.latestDate })).filter(keep);
  if (stage === "fg")
    return (await fgLots()).map((l) => ({ itemId: l.finishedGoodId, item: l.product, lot: l.lotCode, godownId: l.godownId, godown: l.godown, stock: l.stock, unit: "cans", since: l.latestDate })).filter(keep);
  return (await packLots()).map((l) => ({ itemId: l.skuId, item: l.sku, lot: l.batchNo, godownId: l.godownId, godown: l.godown, stock: l.stock, unit: "boxes", since: l.latestDate })).filter(keep);
}

/** What an inflow entry's source type is, in words. */
function inKind(stage: AdjustStage): SQL {
  const made = stage === "rm" ? "Received" : stage === "sfg" ? "Made (SFG batch)" : stage === "fg" ? "Filled" : "Packed";
  return sql`case e.source_type
    when 'transfer' then 'Transfer in'
    when 'adjustment' then 'Adjusted by hand'
    when 'return' then 'Customer return'
    when 'rework' then 'Rework'
    when 'opening' then 'Opening stock'
    else ${made} end`;
}

/**
 * Every movement of one item as rows of (date, kind, doc, lot, godown_id, qty,
 * note, by, seq), qty signed: in above zero, out below. Item Lost Record is
 * excluded at the godown join in `movementsFor`.
 */
function movementUnion(stage: AdjustStage, itemId: string): SQL {
  const day = (ts: SQL) => sql`(${ts} at time zone ${APP_TIMEZONE})::date`;
  /* A hand adjustment's reason and author, on the entry it added. */
  const adjIn = sql`left join erp_manual_adjustments ma on e.source_type = 'adjustment' and ma.id = e.source_id
                    left join erp_stock_adjustments sa on e.source_type = 'adjustment' and sa.id = e.source_id
                    left join users ua on ua.id = coalesce(ma.created_by_id, sa.requested_by_id)`;
  const adjNote = sql`case when ma.id is not null then ma.reason_code || '|' || coalesce(ma.note, '') when sa.id is not null then 'count|' || sa.reason end`;
  /* Transfers out of the item's lots: an ordinary move, a write-off, or a hand adjustment's removal. */
  const tType = stage === "rm" ? "Purchase" : stage === "sfg" ? "Semi Finished" : stage === "fg" ? "Finish Goods" : "FG Packing";
  const transfersOut = sql`
    select t.transfer_date as d, case when tg.reserved and t.remark like 'Stock adjusted %' then 'Adjusted by hand' when tg.reserved then 'Written off' else 'Transfer out to ' || tg.name end as kind,
           t.id as doc, t.lot_no as lot, t.from_godown_id as godown_id, -t.quantity::float8 as qty,
           case when tg.reserved and t.remark like 'Stock adjusted %' then 'adj|' || t.remark else t.remark end as note, ut.name as by, t.created_at as seq
      from erp_transfers t join erp_godowns tg on tg.id = t.to_godown_id left join users ut on ut.id = t.created_by_id
     where t.item_type = ${tType} and t.item_id = ${itemId}`;

  if (stage === "rm")
    return sql`
      select e.entry_date as d, ${inKind(stage)} as kind,
             case when e.source_type = 'purchase' then 'PR-' || p.pr_number::text else e.source_id end as doc,
             e.lot_no as lot, e.godown_id, e.quantity::float8 as qty, ${adjNote} as note, ua.name as by, e.posted_at as seq
        from erp_rm_entries e left join erp_purchases p on e.source_type = 'purchase' and p.id = e.source_id ${adjIn}
       where e.raw_material_id = ${itemId}
      union all ${transfersOut}
      union all
      select l.batch_date, 'Used in SFG batch', 'SFG-' || l.sfg_no::text, l.rm_lot_no, l.godown_id, -l.total_use::float8, null, null, l.created_at
        from erp_sfg_lines l where l.raw_material_id = ${itemId}
      union all
      select coalesce(o.dispatch_date, ${day(sql`o.confirmed_at`)}), 'Returned to vendor', 'RO-' || o.outward_no::text, o.lot_no, o.godown_id, -o.stock_qty::float8, null, null, o.created_at
        from erp_return_outwards o where o.status = 'confirmed' and o.raw_material_id = ${itemId}
      union all
      select f.fill_date, 'Cans used in filling', 'Fill ' || f.fg_num::text, null, f.godown_id, -f.cans::float8, null, null, f.created_at
        from erp_fg_fills f where f.packing_type = 'Can' and f.can_use_id = ${itemId}
      union all
      select l.pack_date, 'Boxes used in packing', l.batch_no, null, l.godown_id, -(l.boxes * coalesce(pk.empty_boxes_required, 0))::float8, null, null, l.created_at
        from (select distinct on (batch_no) batch_no, sku_id, boxes, godown_id, pack_date, created_at from erp_pack_lines order by batch_no, created_at) l
        join erp_product_packing pk on pk.product_id = l.sku_id
        join erp_raw_materials m on lower(m.name) = lower(pk.box_type)
       where m.id = ${itemId}`;

  if (stage === "sfg")
    return sql`
      select e.entry_date as d, ${inKind(stage)} as kind, e.source_id as doc, e.lot_code as lot, e.godown_id, e.quantity::float8 as qty, ${adjNote} as note, ua.name as by, e.posted_at as seq
        from erp_sfg_entries e ${adjIn}
       where e.formulation_id = ${itemId}
      union all ${transfersOut}
      union all
      select f.fill_date, 'Filled into cans', 'Fill ' || f.fg_num::text, f.sfg_lot_code, f.godown_id, -(f.can_size * f.cans)::float8, null, null, f.created_at
        from erp_fg_fills f where f.formulation_id = ${itemId}`;

  if (stage === "fg")
    return sql`
      select e.entry_date as d, ${inKind(stage)} as kind,
             case when e.source_type = 'fill' then 'Fill ' || f.fg_num::text else e.source_id end as doc,
             e.lot_code as lot, e.godown_id, e.quantity::float8 as qty, ${adjNote} as note, ua.name as by, e.posted_at as seq
        from erp_fg_entries e left join erp_fg_fills f on e.source_type = 'fill' and f.id = e.source_id ${adjIn}
       where e.finished_good_id = ${itemId}
      union all ${transfersOut}
      union all
      select l.pack_date, 'Packed into boxes', l.batch_no, l.fg_lot_code, l.godown_id, -l.cans::float8, null, null, l.created_at
        from erp_pack_lines l where l.finished_good_id = ${itemId}
      union all
      select ${day(sql`b.created_at`)}, 'Sent loose on an order', 'ORDER-' || o.order_no::text, b.lot_code, b.godown_id, -b.quantity::float8, null, null, b.created_at
        from erp_batch_codes b join erp_orders o on o.id = b.order_id
       where b.lot_from = 'fg' and b.finished_good_id = ${itemId}`;

  return sql`
    select e.entry_date as d, ${inKind(stage)} as kind, e.source_id as doc, e.batch_no as lot, e.godown_id, e.boxes::float8 as qty, ${adjNote} as note, ua.name as by, e.posted_at as seq
      from erp_pack_entries e ${adjIn}
     where e.sku_id = ${itemId}
    union all ${transfersOut}
    union all
    select ${day(sql`b.created_at`)}, 'Sent on an order', 'ORDER-' || o.order_no::text, b.lot_code, b.godown_id, -b.quantity::float8, null, null, b.created_at
      from erp_batch_codes b join erp_orders o on o.id = b.order_id
     where b.lot_from = 'pack' and b.lot_code in (select distinct batch_no from erp_pack_entries where sku_id = ${itemId})`;
}

/** "damaged|", "other|extra half drum", "adj|Stock adjusted ADJ… — Damaged" → the reason in words. */
function noteText(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith("adj|")) {
    const m = /—\s*(.+)$/.exec(raw.slice(4));
    return m ? m[1] : null;
  }
  const bar = raw.indexOf("|");
  if (bar < 0) return raw;
  const code = raw.slice(0, bar);
  const rest = raw.slice(bar + 1) || null;
  if (code === "count") return rest ? `Stock count: ${rest}` : "Stock count";
  return adjustReasonText(code, rest);
}

export async function stockInquiry(q: { stage: AdjustStage; itemId: string; godownId: string | null; window: DateWindow }): Promise<Inquiry | null> {
  const all = (await lotsOf(q.stage)).filter((l) => l.itemId === q.itemId);
  const named = await itemName(q.stage, q.itemId);
  if (!named) return null;
  const lots = all.filter((l) => !q.godownId || l.godownId === q.godownId);
  const u = movementUnion(q.stage, q.itemId);
  const where = sql`not g.reserved ${q.godownId ? sql`and m.godown_id = ${q.godownId}` : sql``}`;
  const from = q.window.from;
  const to = q.window.to;
  const [{ opening }] = from
    ? ((await db.execute(sql`select coalesce(sum(m.qty), 0)::float8 as opening from (${u}) m join erp_godowns g on g.id = m.godown_id where ${where} and m.d < ${from}::date`)) as unknown as { opening: number }[])
    : [{ opening: 0 }];
  const inWin = sql`${where} ${from ? sql`and m.d >= ${from}::date` : sql``} ${to ? sql`and m.d <= ${to}::date` : sql``}`;
  const [tot] = (await db.execute(sql`
    select count(*)::int as n,
           coalesce(sum(m.qty) filter (where m.qty > 0), 0)::float8 as "in",
           coalesce(-sum(m.qty) filter (where m.qty < 0), 0)::float8 as "out",
           coalesce(sum(m.qty) filter (where m.kind = 'Adjusted by hand'), 0)::float8 as adj
      from (${u}) m join erp_godowns g on g.id = m.godown_id where ${inWin}`)) as unknown as { n: number; in: number; out: number; adj: number }[];
  /* The newest are kept when a period holds more than the cap; the balance before them is worked back from the total. */
  const rows = (await db.execute(sql`
    select m.d::text as date, m.kind, m.doc, m.lot, g.name as godown, m.qty, m.note, m.by
      from (${u}) m join erp_godowns g on g.id = m.godown_id where ${inWin}
     order by m.d desc, m.seq desc limit ${MOVEMENT_CAP}`)) as unknown as { date: string; kind: string; doc: string | null; lot: string | null; godown: string; qty: number; note: string | null; by: string | null }[];
  rows.reverse();
  const capped = Number(tot.n) > rows.length;
  const shownSum = rows.reduce((t, r) => t + Number(r.qty), 0);
  const periodSum = Number(tot.in) - Number(tot.out);
  let bal = r3(Number(opening) + periodSum - shownSum);
  const movements: Movement[] = rows.map((r) => {
    bal = r3(bal + Number(r.qty));
    return { date: r.date, kind: r.kind, doc: r.doc, lot: r.lot, godown: r.godown, qty: r3(Number(r.qty)), note: noteText(r.note), by: r.by, balance: bal };
  });
  return {
    stage: q.stage,
    itemId: q.itemId,
    item: named.name,
    unit: named.unit,
    lots: lots.map((l) => ({ lot: l.lot, godownId: l.godownId, godown: l.godown, stock: l.stock, since: l.since })).sort((a, b) => a.since.localeCompare(b.since)),
    stockNow: r3(lots.reduce((t, l) => t + l.stock, 0)),
    opening: r3(Number(opening)),
    totalIn: r3(Number(tot.in)),
    totalOut: r3(Number(tot.out)),
    adjusted: r3(Number(tot.adj)),
    movements,
    capped,
  };
}

async function itemName(stage: AdjustStage, id: string): Promise<{ name: string; unit: string } | null> {
  const q =
    stage === "rm"
      ? sql`select name, case when unit = 'Unit' then 'Pcs' else 'Ltr' end as unit from erp_raw_materials where id = ${id}`
      : stage === "sfg"
        ? sql`select name, 'Ltr' as unit from product_formulations where id = ${id}`
        : stage === "fg"
          ? sql`select name, 'cans' as unit from finished_goods where id = ${id}`
          : sql`select name, 'boxes' as unit from products where id = ${id}`;
  const [r] = (await db.execute(q)) as unknown as { name: string; unit: string }[];
  return r ?? null;
}

/** Godowns an inquiry can be narrowed to: every working one, never Item Lost Record. */
export async function inquiryGodowns(): Promise<{ id: string; name: string }[]> {
  return (await db.execute(sql`select id, name from erp_godowns where not reserved order by name`)) as unknown as { id: string; name: string }[];
}
