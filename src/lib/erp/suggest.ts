import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import { suggestLevel, type LevelSuggestion } from "./engines/production";
import { addDaysIso } from "./engines/sales";
import { today } from "./screens/common";

/* ---------------------------------------------------------------------------
 * AI-7's suggested re-order levels, from what each godown actually used:
 * SFG consumption for chemicals, filling for cans, packing for boxes, and
 * dispatched allocations for finished goods. Nothing is changed until a
 * person applies a suggestion.
 * ------------------------------------------------------------------------- */

type Use = { key: string; used: number; recent: number };

async function uses(q: ReturnType<typeof sql>): Promise<Map<string, Use>> {
  const rows = (await db.execute(q)) as unknown as { key: string; used: number; recent: number }[];
  return new Map(rows.map((r) => [r.key, { key: r.key, used: Number(r.used), recent: Number(r.recent) }]));
}

export async function levelSuggestions(): Promise<{
  enabled: boolean;
  rm: (materialType: string, rawMaterialId: string, godownId: string, unit: string) => LevelSuggestion | null;
  fg: (skuId: string, godownId: string, boxed: boolean) => LevelSuggestion | null;
}> {
  const c = await getConfig();
  const lookback = c["erp.ai.reorder.lookbackDays"];
  const recentDays = Math.min(30, lookback);
  const since = addDaysIso(today(), -lookback);
  const recent = addDaysIso(today(), -recentDays);
  if (!c["erp.ai.reorder.enabled"]) return { enabled: false, rm: () => null, fg: () => null };
  const [chem, cans, boxes, fg] = await Promise.all([
    uses(sql`
      select raw_material_id || '|' || godown_id as key, sum(total_use)::float8 as used,
             sum(case when batch_date >= ${recent} then total_use else 0 end)::float8 as recent
        from erp_sfg_lines where batch_date >= ${since} group by 1`),
    uses(sql`
      select can_use_id || '|' || godown_id as key, sum(cans)::float8 as used,
             sum(case when fill_date >= ${recent} then cans else 0 end)::float8 as recent
        from erp_fg_fills where can_use_id is not null and fill_date >= ${since} group by 1`),
    uses(sql`
      select m.id || '|' || l.godown_id as key, sum(l.boxes * pk.empty_boxes_required)::float8 as used,
             sum(case when l.pack_date >= ${recent} then l.boxes * pk.empty_boxes_required else 0 end)::float8 as recent
        from (select distinct on (batch_no) batch_no, sku_id, boxes, godown_id, pack_date from erp_pack_lines order by batch_no, created_at) l
        join erp_product_packing pk on pk.product_id = l.sku_id
        join erp_raw_materials m on lower(m.name) = lower(pk.box_type)
       where l.pack_date >= ${since} group by 1`),
    uses(sql`
      select o.sku_id || '|' || b.godown_id as key, sum(b.quantity)::float8 as used,
             sum(case when d.dispatch_date >= ${recent} then b.quantity else 0 end)::float8 as recent
        from erp_batch_codes b join erp_orders o on o.id = b.order_id
        join erp_order_details d on d.order_id = o.id and d.verification = 'Verified'
       where d.dispatch_date >= ${since} group by 1`),
  ]);
  const make = (u: Use | undefined, unit: string) =>
    u ? suggestLevel({ used: u.used, lookbackDays: lookback, recentUsed: u.recent, recentDays, minCover: c["erp.ai.reorder.minCoverDays"], maxCover: c["erp.ai.reorder.maxCoverDays"], unit }) : null;
  return {
    enabled: true,
    rm: (type, item, godown, unit) => make((type === "Can" ? cans : type === "Box" ? boxes : chem).get(`${item}|${godown}`), unit),
    fg: (sku, godown, boxed) => make(fg.get(`${sku}|${godown}`), boxed ? "boxes" : "cans"),
  };
}
