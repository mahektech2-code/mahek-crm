import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { fillFigures, packCosting, boxFigures, sfgRate } from "./engines/production";

/* ---------------------------------------------------------------------------
 * Stock, read off the inventory ledgers (spec §6.1). ONE statement of
 * "current stock lot wise" per stage, read by every screen, form, validation
 * and dashboard tile that asks — so a list, the form that consumes from it and
 * the tile that counts it can never disagree about a lot.
 *
 * Current stock (lot, godown) = Σ inflow entries − Σ outflows. Inflows are the
 * stage's entries (its own documents, and transfers in). Outflows are read
 * from the documents that consume stock, never written as entries:
 *
 *   RM   ← transfers out · SFG consumption
 *   SFG  ← transfers out · FG filling
 *   FG   ← transfers out · packing lines · lot allocations to orders
 *   Pack ← transfers out · lot allocations to orders
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
const num = (v: unknown) => (v == null ? 0 : Number(v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Anything that runs SQL: the pool, or a transaction that has locked the lot it is about to consume. */
export type Ex = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

async function rows<T>(q: ReturnType<typeof sql>, ex: Ex = db): Promise<T[]> {
  return (await ex.execute(q)) as unknown as T[];
}

/**
 * Serialises consumers of one lot at one godown for the rest of the caller's
 * transaction, so two forms saved at once cannot both spend the last litre.
 */
export async function lockLot(ex: Ex, stage: string, lot: string, godownId: string): Promise<void> {
  await ex.execute(sql`select pg_advisory_xact_lock(hashtext(${`erp:${stage}:${lot}:${godownId}`}))`);
}

/* =================================================================== RM */

export type RmLot = {
  rawMaterialId: string;
  item: string;
  materialType: string;
  unit: string;
  lotNo: string;
  godownId: string;
  godown: string;
  stock: number;
  /** The latest inflow entry for this lot at this godown (the source's slice). */
  latestEntryId: string;
  latestDate: string;
  /** Rate per litre (or per piece) of the lot, from its purchase, in paise. */
  ratePaise: number | null;
};

/** Pieces for countables, litres for everything else — the unit stock is held in. */
export function stockUnit(rmUnit: string): "Ltr" | "Pcs" {
  return rmUnit === "Unit" ? "Pcs" : "Ltr";
}

/**
 * Every raw-material lot at every godown with its current stock. Lots at zero
 * are included (the log and the validations need them); screens that show
 * "available" stock filter to above zero.
 */
export async function rmLots(ex: Ex = db): Promise<RmLot[]> {
  const out = await rows<Row>(
    sql`
    with inflow as (
      select raw_material_id, lot_no, godown_id, sum(quantity)::float8 as qty
        from erp_rm_entries group by 1, 2, 3
    ),
    outflow as (
      select lot_no, godown_id, sum(qty)::float8 as qty from (
        select lot_no, from_godown_id as godown_id, quantity as qty from erp_transfers where item_type = 'Purchase'
        union all
        select rm_lot_no, godown_id, total_use from erp_sfg_lines
      ) o group by 1, 2
    ),
    latest as (
      select distinct on (lot_no, godown_id) lot_no, godown_id, id, entry_date
        from erp_rm_entries order by lot_no, godown_id, entry_date desc, posted_at desc, id desc
    ),
    rate as (
      select distinct on (lot_no) lot_no, rate_paise, unit, density from erp_purchases order by lot_no, created_at desc
    )
    select i.raw_material_id as "rawMaterialId", m.name as item, m.material_type as "materialType", m.unit as "rmUnit",
           i.lot_no as "lotNo", i.godown_id as "godownId", g.name as godown,
           (i.qty - coalesce(o.qty, 0))::float8 as stock,
           l.id as "latestEntryId", l.entry_date::text as "latestDate",
           case when r.rate_paise is null then null
                when r.unit = 'Kg' then round(r.rate_paise * coalesce(r.density, 0))::float8
                else r.rate_paise::float8 end as "ratePaise"
      from inflow i
      join erp_raw_materials m on m.id = i.raw_material_id
      join erp_godowns g on g.id = i.godown_id
      left join outflow o on o.lot_no = i.lot_no and o.godown_id = i.godown_id
      left join latest l on l.lot_no = i.lot_no and l.godown_id = i.godown_id
      left join rate r on r.lot_no = i.lot_no
     order by m.name, i.lot_no, g.name
  `,
    ex,
  );
  return out.map((r) => ({
    rawMaterialId: String(r.rawMaterialId),
    item: String(r.item),
    materialType: String(r.materialType),
    unit: stockUnit(String(r.rmUnit)),
    lotNo: String(r.lotNo),
    godownId: String(r.godownId),
    godown: String(r.godown),
    stock: r3(num(r.stock)),
    latestEntryId: String(r.latestEntryId),
    latestDate: String(r.latestDate),
    ratePaise: r.ratePaise == null ? null : Number(r.ratePaise),
  }));
}

/** One lot's current stock at one godown — the figure every consuming form validates against. */
export async function rmLotStock(lotNo: string, godownId: string, ex: Ex = db): Promise<number> {
  const lots = await rmLots(ex);
  return lots.find((l) => l.lotNo === lotNo && l.godownId === godownId)?.stock ?? 0;
}

/** Current raw-material stock per raw-material id, across every godown. */
export async function rmTotalsByItem(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const l of await rmLots()) out.set(l.rawMaterialId, (out.get(l.rawMaterialId) ?? 0) + l.stock);
  return out;
}

/** Current stock of one raw material at one godown, across its lots. */
export async function rmItemStockAt(rawMaterialId: string, godownId: string): Promise<number> {
  let t = 0;
  for (const l of await rmLots()) if (l.rawMaterialId === rawMaterialId && l.godownId === godownId) t += l.stock;
  return t;
}

/* ================================================================== SFG */

export type SfgLot = {
  formulationId: string;
  product: string;
  lotCode: string;
  godownId: string;
  godown: string;
  stock: number;
  latestEntryId: string;
  latestDate: string;
  latestType: string;
  batches: number | null;
  /** Σ consumption over the lot's batch lines ÷ its batches. */
  batchSize: number | null;
  ratePaise: number | null;
};

/** The SFG rate of every lot code, from its batch lines and their raw-material lots' rates. */
export async function sfgRates(): Promise<Map<string, number | null>> {
  const rm = new Map((await rmLots()).map((l) => [l.lotNo, l.ratePaise]));
  const lines = await rows<{ lotCode: string; lot: string; use: number }>(
    sql`select lot_code as "lotCode", rm_lot_no as lot, total_use::float8 as use from erp_sfg_lines`,
  );
  const by = new Map<string, { totalUse: number; rmRatePaise: number | null }[]>();
  for (const l of lines) {
    const a = by.get(l.lotCode) ?? [];
    a.push({ totalUse: Number(l.use), rmRatePaise: rm.get(l.lot) ?? null });
    by.set(l.lotCode, a);
  }
  const out = new Map<string, number | null>();
  for (const [k, v] of by) out.set(k, sfgRate(v));
  return out;
}

export async function sfgLots(ex: Ex = db): Promise<SfgLot[]> {
  const [out, rates, sizes] = await Promise.all([
    rows<Row>(sql`
      with inflow as (
        select formulation_id, lot_code, godown_id, sum(quantity)::float8 as qty from erp_sfg_entries group by 1, 2, 3
      ),
      outflow as (
        select lot_code, godown_id, sum(qty)::float8 as qty from (
          select lot_no as lot_code, from_godown_id as godown_id, quantity as qty from erp_transfers where item_type = 'Semi Finished'
          union all
          select sfg_lot_code, godown_id, can_size * cans from erp_fg_fills
        ) o group by 1, 2
      ),
      latest as (
        select distinct on (lot_code, godown_id) lot_code, godown_id, id, entry_date, source_type, batches
          from erp_sfg_entries order by lot_code, godown_id, entry_date desc, posted_at desc, id desc
      )
      select i.formulation_id as "formulationId", f.name as product, i.lot_code as "lotCode", i.godown_id as "godownId",
             g.name as godown, (i.qty - coalesce(o.qty, 0))::float8 as stock,
             l.id as "latestEntryId", l.entry_date::text as "latestDate", l.source_type as "latestType", l.batches::float8 as batches
        from inflow i
        join product_formulations f on f.id = i.formulation_id
        join erp_godowns g on g.id = i.godown_id
        left join outflow o on o.lot_code = i.lot_code and o.godown_id = i.godown_id
        left join latest l on l.lot_code = i.lot_code and l.godown_id = i.godown_id
       order by f.name, i.lot_code, g.name
    `, ex),
    sfgRates(),
    rows<{ lotCode: string; use: number; batches: number }>(
      sql`select lot_code as "lotCode", sum(total_use)::float8 as use, max(batches)::float8 as batches from erp_sfg_lines group by lot_code`,
    ),
  ]);
  const size = new Map(sizes.map((s) => [s.lotCode, s]));
  return out.map((r) => {
    const s = size.get(String(r.lotCode));
    return {
      formulationId: String(r.formulationId),
      product: String(r.product),
      lotCode: String(r.lotCode),
      godownId: String(r.godownId),
      godown: String(r.godown),
      stock: r3(num(r.stock)),
      latestEntryId: String(r.latestEntryId),
      latestDate: String(r.latestDate),
      latestType: r.latestType === "transfer" ? "Transfer" : "Semi Finished",
      batches: s ? Number(s.batches) : null,
      batchSize: s && Number(s.batches) > 0 ? r3(Number(s.use) / Number(s.batches)) : null,
      ratePaise: rates.get(String(r.lotCode)) ?? null,
    };
  });
}

/* =================================================================== FG */

export type FgLot = {
  finishedGoodId: string;
  product: string;
  lotCode: string;
  godownId: string;
  godown: string;
  /** Cans. */
  stock: number;
  skuId: string | null;
  sku: string | null;
  packingType: string | null;
  latestEntryId: string;
  latestDate: string;
  /** Per can where the lot is in cans, else per litre (spec §8.2). */
  ratePaise: number | null;
  /** Value of one can of this lot, whatever the rate basis. */
  perCanPaise: number | null;
};

const fgKey = (fg: string, lot: string) => `${fg}|${lot}`;

/** Every FG lot's rate, from its filling records' costing. */
export async function fgRates(): Promise<Map<string, { ratePaise: number | null; perCanPaise: number | null }>> {
  const [fills, sfg] = await Promise.all([
    rows<Row>(sql`
      select f.finished_good_id as fg, f.lot_code as lot, f.sfg_lot_code as "sfgLot", f.can_size::float8 as "canSize",
             f.cans, f.can_adjusted as "canAdjusted", f.packing_type as "packingType", m.price_paise::float8 as "packingRate"
        from erp_fg_fills f left join erp_raw_materials m on m.id = f.can_use_id
    `),
    sfgRates(),
  ]);
  const acc = new Map<string, { cost: number; cans: number; litres: number; basis: string; unknown: boolean }>();
  for (const f of fills) {
    const fig = fillFigures({
      canSize: num(f.canSize),
      cans: num(f.cans),
      canAdjusted: num(f.canAdjusted),
      packingType: String(f.packingType),
      sfgRatePaise: sfg.get(String(f.sfgLot)) ?? null,
      packingRatePaise: f.packingRate == null ? null : Number(f.packingRate),
    });
    const k = fgKey(String(f.fg), String(f.lot));
    const a = acc.get(k) ?? { cost: 0, cans: 0, litres: 0, basis: fig.rateBasis, unknown: false };
    if (fig.costingPaise == null) a.unknown = true;
    else a.cost += fig.costingPaise;
    a.cans += num(f.cans);
    a.litres += fig.useLitres;
    acc.set(k, a);
  }
  const out = new Map<string, { ratePaise: number | null; perCanPaise: number | null }>();
  for (const [k, a] of acc) {
    if (a.unknown || a.cans <= 0) out.set(k, { ratePaise: null, perCanPaise: null });
    else
      out.set(k, {
        ratePaise: a.basis === "can" ? Math.round(a.cost / a.cans) : a.litres > 0 ? Math.round(a.cost / a.litres) : null,
        perCanPaise: Math.round(a.cost / a.cans),
      });
  }
  return out;
}

export async function fgLots(ex: Ex = db): Promise<FgLot[]> {
  const [out, rates] = await Promise.all([
    rows<Row>(sql`
      with inflow as (
        select finished_good_id, lot_code, godown_id, sum(quantity)::float8 as qty from erp_fg_entries group by 1, 2, 3
      ),
      outflow as (
        select fg, lot_code, godown_id, sum(qty)::float8 as qty from (
          select item_id as fg, lot_no as lot_code, from_godown_id as godown_id, quantity as qty from erp_transfers where item_type = 'Finish Goods'
          union all
          select finished_good_id, fg_lot_code, godown_id, cans from erp_pack_lines
          union all
          select finished_good_id, lot_code, godown_id, quantity from erp_batch_codes where lot_from = 'fg'
        ) o group by 1, 2, 3
      ),
      latest as (
        select distinct on (finished_good_id, lot_code, godown_id) finished_good_id, lot_code, godown_id, id, entry_date, sku_id, packing_type
          from erp_fg_entries order by finished_good_id, lot_code, godown_id, entry_date desc, posted_at desc, id desc
      )
      select i.finished_good_id as "finishedGoodId", fg.name as product, i.lot_code as "lotCode", i.godown_id as "godownId",
             g.name as godown, (i.qty - coalesce(o.qty, 0))::float8 as stock, l.sku_id as "skuId", p.name as sku,
             l.packing_type as "packingType", l.id as "latestEntryId", l.entry_date::text as "latestDate"
        from inflow i
        join finished_goods fg on fg.id = i.finished_good_id
        join erp_godowns g on g.id = i.godown_id
        left join outflow o on o.fg = i.finished_good_id and o.lot_code = i.lot_code and o.godown_id = i.godown_id
        left join latest l on l.finished_good_id = i.finished_good_id and l.lot_code = i.lot_code and l.godown_id = i.godown_id
        left join products p on p.id = l.sku_id
       order by fg.name, i.lot_code, g.name
    `, ex),
    fgRates(),
  ]);
  return out.map((r) => {
    const rate = rates.get(fgKey(String(r.finishedGoodId), String(r.lotCode)));
    return {
      finishedGoodId: String(r.finishedGoodId),
      product: String(r.product),
      lotCode: String(r.lotCode),
      godownId: String(r.godownId),
      godown: String(r.godown),
      stock: r3(num(r.stock)),
      skuId: r.skuId == null ? null : String(r.skuId),
      sku: r.sku == null ? null : String(r.sku),
      packingType: r.packingType == null ? null : String(r.packingType),
      latestEntryId: String(r.latestEntryId),
      latestDate: String(r.latestDate),
      ratePaise: rate?.ratePaise ?? null,
      perCanPaise: rate?.perCanPaise ?? null,
    };
  });
}

/* ============================================================= packing */

export type PackLot = {
  skuId: string;
  sku: string;
  batchNo: string;
  godownId: string;
  godown: string;
  /** Boxes. */
  stock: number;
  latestEntryId: string;
  latestDate: string;
  postedAt: string;
  /** Σ packing costing of the batch ÷ its cans (spec §9.2). */
  perCanPaise: number | null;
  /** Value of one box of this batch. */
  perBoxPaise: number | null;
  amountPaise: number | null;
};

/** The costing of every packing batch: FG lot rates for its cans plus its boxes, paid once. */
export async function packBatchCosting(): Promise<Map<string, { amountPaise: number | null; cans: number; boxes: number; lines: Map<string, number | null> }>> {
  const [lines, rates] = await Promise.all([
    rows<Row>(sql`
      select l.id, l.batch_no as "batchNo", l.finished_good_id as fg, l.fg_lot_code as lot, l.cans, l.boxes,
             pk.empty_boxes_required as "emptyBoxes", pk.box_rate_paise::float8 as "boxRate"
        from erp_pack_lines l left join erp_product_packing pk on pk.product_id = l.sku_id
    `),
    fgRates(),
  ]);
  const by = new Map<string, Row[]>();
  for (const l of lines) {
    const a = by.get(String(l.batchNo)) ?? [];
    a.push(l);
    by.set(String(l.batchNo), a);
  }
  const out = new Map<string, { amountPaise: number | null; cans: number; boxes: number; lines: Map<string, number | null> }>();
  for (const [batch, ls] of by) {
    const first = ls[0];
    const boxes = num(first.boxes);
    const { boxAmountPaise } = boxFigures(boxes, num(first.emptyBoxes), first.boxRate == null ? null : Number(first.boxRate));
    const costs = packCosting(
      ls.map((l) => ({ id: String(l.id), cans: num(l.cans), fgRatePaise: rates.get(fgKey(String(l.fg), String(l.lot)))?.perCanPaise ?? null })),
      boxAmountPaise,
    );
    const vals = [...costs.values()];
    const amount = vals.some((v) => v == null) ? null : vals.reduce<number>((a, v) => a + (v ?? 0), 0);
    out.set(batch, { amountPaise: amount, cans: ls.reduce((a, l) => a + num(l.cans), 0), boxes, lines: costs });
  }
  return out;
}

export async function packLots(ex: Ex = db): Promise<PackLot[]> {
  const [out, costing] = await Promise.all([
    rows<Row>(sql`
      with inflow as (
        select sku_id, batch_no, godown_id, sum(boxes)::float8 as qty from erp_pack_entries group by 1, 2, 3
      ),
      outflow as (
        select batch_no, godown_id, sum(qty)::float8 as qty from (
          select lot_no as batch_no, from_godown_id as godown_id, quantity as qty from erp_transfers where item_type = 'FG Packing'
          union all
          select lot_code, godown_id, quantity from erp_batch_codes where lot_from = 'pack'
        ) o group by 1, 2
      ),
      latest as (
        select distinct on (batch_no, godown_id) batch_no, godown_id, id, entry_date, posted_at
          from erp_pack_entries order by batch_no, godown_id, entry_date desc, posted_at desc, id desc
      )
      select i.sku_id as "skuId", p.name as sku, i.batch_no as "batchNo", i.godown_id as "godownId", g.name as godown,
             (i.qty - coalesce(o.qty, 0))::float8 as stock, l.id as "latestEntryId", l.entry_date::text as "latestDate",
             l.posted_at as "postedAt"
        from inflow i
        join products p on p.id = i.sku_id
        join erp_godowns g on g.id = i.godown_id
        left join outflow o on o.batch_no = i.batch_no and o.godown_id = i.godown_id
        left join latest l on l.batch_no = i.batch_no and l.godown_id = i.godown_id
       order by p.name, i.batch_no, g.name
    `, ex),
    packBatchCosting(),
  ]);
  return out.map((r) => {
    const c = costing.get(String(r.batchNo));
    const amount = c?.amountPaise ?? null;
    return {
      skuId: String(r.skuId),
      sku: String(r.sku),
      batchNo: String(r.batchNo),
      godownId: String(r.godownId),
      godown: String(r.godown),
      stock: r3(num(r.stock)),
      latestEntryId: String(r.latestEntryId),
      latestDate: String(r.latestDate),
      postedAt: String(r.postedAt),
      perCanPaise: amount == null || !c?.cans ? null : Math.round(amount / c.cans),
      perBoxPaise: amount == null || !c?.boxes ? null : Math.round(amount / c.boxes),
      amountPaise: amount,
    };
  });
}

/* ============================================================== levels */

/**
 * What a raw-material level counts as available (spec §10.2), by material type:
 * lot stock at the godown, less cans already filled or boxes already packed;
 * drums company-wide. Other types read lot stock (spec §14 A-16).
 */
export async function rmLevelAvailable(): Promise<(materialType: string, rawMaterialId: string, godownId: string) => number> {
  const [lots, cans, boxes, drums, drumsSold] = await Promise.all([
    rmLots(),
    rows<{ item: string; godown: string; n: number }>(
      sql`select can_use_id as item, godown_id as godown, sum(cans)::float8 as n from erp_fg_fills where packing_type = 'Can' and can_use_id is not null group by 1, 2`,
    ),
    rows<{ item: string; godown: string; n: number }>(sql`
      select m.id as item, l.godown_id as godown, sum(l.boxes * coalesce(pk.empty_boxes_required, 0))::float8 as n
        from (select distinct on (batch_no) batch_no, sku_id, boxes, godown_id from erp_pack_lines order by batch_no, created_at) l
        join erp_product_packing pk on pk.product_id = l.sku_id
        join erp_raw_materials m on lower(m.name) = lower(pk.box_type)
       group by 1, 2
    `),
    rows<{ n: number }>(sql`select coalesce(sum(drums), 0)::float8 as n from erp_purchases`),
    rows<{ n: number }>(sql`
      select coalesce(sum(o.qty_cans), 0)::float8 as n
        from erp_order_details d join erp_orders o on o.id = d.order_id
        join erp_product_packing pk on pk.product_id = o.sku_id
       where pk.box_type = 'Empty Drum'
    `),
  ]);
  const stock = new Map<string, number>();
  for (const l of lots) stock.set(`${l.rawMaterialId}|${l.godownId}`, (stock.get(`${l.rawMaterialId}|${l.godownId}`) ?? 0) + l.stock);
  const used = (list: { item: string; godown: string; n: number }[]) => new Map(list.map((x) => [`${x.item}|${x.godown}`, Number(x.n)]));
  const canUse = used(cans);
  const boxUse = used(boxes);
  /* Drums are company-wide in the source: every drum bought less every drum sold (A-16). */
  const drumsIn = Number(drums[0]?.n ?? 0) - Number(drumsSold[0]?.n ?? 0);
  return (type, item, godown) => {
    const k = `${item}|${godown}`;
    const s = stock.get(k) ?? 0;
    if (type === "Can") return r3(s - (canUse.get(k) ?? 0));
    if (type === "Box") return r3(s - (boxUse.get(k) ?? 0));
    if (type === "Drum") return r3(drumsIn);
    return r3(s);
  };
}

/**
 * What a finished-goods level counts as available: a loose SKU reads FG stock
 * (cans), a boxed SKU reads packing stock (boxes), at the godown.
 */
export async function fgLevelAvailable(): Promise<(skuId: string, boxed: boolean, godownId: string) => number> {
  const [fg, pack] = await Promise.all([fgLots(), packLots()]);
  const loose = new Map<string, number>();
  for (const l of fg) if (l.skuId) loose.set(`${l.skuId}|${l.godownId}`, (loose.get(`${l.skuId}|${l.godownId}`) ?? 0) + l.stock);
  const boxed = new Map<string, number>();
  for (const l of pack) boxed.set(`${l.skuId}|${l.godownId}`, (boxed.get(`${l.skuId}|${l.godownId}`) ?? 0) + l.stock);
  return (sku, isBoxed, godown) => r3((isBoxed ? boxed : loose).get(`${sku}|${godown}`) ?? 0);
}

/** One SFG lot's current stock at one godown. */
export async function sfgLotStock(lotCode: string, godownId: string, ex: Ex = db): Promise<number> {
  return (await sfgLots(ex)).find((l) => l.lotCode === lotCode && l.godownId === godownId)?.stock ?? 0;
}

/** One FG lot's current stock (cans) at one godown. */
export async function fgLotStock(finishedGoodId: string, lotCode: string, godownId: string, ex: Ex = db): Promise<number> {
  return (await fgLots(ex)).find((l) => l.finishedGoodId === finishedGoodId && l.lotCode === lotCode && l.godownId === godownId)?.stock ?? 0;
}

/** One packing batch's current stock (boxes) at one godown. */
export async function packLotStock(batchNo: string, godownId: string, ex: Ex = db): Promise<number> {
  return (await packLots(ex)).find((l) => l.batchNo === batchNo && l.godownId === godownId)?.stock ?? 0;
}
