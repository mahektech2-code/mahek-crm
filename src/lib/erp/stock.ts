import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/* ---------------------------------------------------------------------------
 * Stock, read off the inventory ledgers (spec §6.1). ONE statement of
 * "current stock lot wise" per stage, read by every screen, form, validation
 * and dashboard tile that asks — so a list, the form that consumes from it and
 * the tile that counts it can never disagree about a lot.
 *
 * Current stock (lot, godown) = Σ inflow entries − Σ outflows. Inflows are the
 * log's entries (purchases with a rate, transfers in). Outflows are read from
 * the documents that consume stock — transfers out and SFG consumption join
 * here in phase 3 — never written as entries.
 * ------------------------------------------------------------------------- */

export type RmLot = {
  rawMaterialId: string;
  item: string;
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
export async function rmLots(): Promise<RmLot[]> {
  const rows = (await db.execute(sql`
    with inflow as (
      select raw_material_id, lot_no, godown_id, sum(quantity)::float8 as qty
        from erp_rm_entries group by 1, 2, 3
    ),
    outflow as (
      select lot_no, godown_id, sum(qty)::float8 as qty from (
        select null::text as lot_no, null::text as godown_id, 0::numeric as qty where false
      ) o group by 1, 2
    ),
    latest as (
      select distinct on (lot_no, godown_id) lot_no, godown_id, id, entry_date
        from erp_rm_entries order by lot_no, godown_id, entry_date desc, posted_at desc, id desc
    ),
    rate as (
      select distinct on (lot_no) lot_no, rate_paise, unit, density from erp_purchases order by lot_no, created_at desc
    )
    select i.raw_material_id as "rawMaterialId", m.name as item, m.unit as "rmUnit", i.lot_no as "lotNo",
           i.godown_id as "godownId", g.name as godown,
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
  `)) as unknown as (Omit<RmLot, "unit"> & { rmUnit: string })[];
  return rows.map((r) => ({
    rawMaterialId: r.rawMaterialId,
    item: r.item,
    unit: stockUnit(r.rmUnit),
    lotNo: r.lotNo,
    godownId: r.godownId,
    godown: r.godown,
    stock: Math.round(Number(r.stock) * 1000) / 1000,
    latestEntryId: r.latestEntryId,
    latestDate: r.latestDate,
    ratePaise: r.ratePaise == null ? null : Number(r.ratePaise),
  }));
}

/** One lot's current stock at one godown — the figure every consuming form validates against. */
export async function rmLotStock(lotNo: string, godownId: string): Promise<number> {
  const lots = await rmLots();
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
