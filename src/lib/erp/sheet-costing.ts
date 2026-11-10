import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { matchKey } from "@/lib/catalogue";
import { matchSheetCosting, type CostLine, type SheetCostRow } from "./engines/sheet-costing";

/**
 * The old order sheet's "Lotcode Costing" onto every ERP line that has no
 * allocated lot — `erp_order_details.sheet_costing_paise` (0317). The rule is in
 * `engines/sheet-costing.ts`; this reads the two sides and writes the answer.
 *
 * READ FROM WHAT IS STORED. `sheet_order_rows` is the staging copy of the
 * retired order tab and keeps the whole row in `raw`; Google is never asked.
 * Its `matched_product_id` was never filled, so the description is resolved
 * here the way the catalogue resolves any legacy name: `matchKey` against every
 * SKU's name, then its aliases.
 *
 * IDEMPOTENT. Writes only a line whose stored figure differs from the sheet's,
 * so a second run writes nothing, and never clears one: a line the sheet no
 * longer matches keeps the cost it was given. `dryRun` reports and writes nothing.
 */
export type SheetCostingReport = {
  dryRun: boolean;
  /** Dispatched lines with no allocated lot. */
  candidates: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  /** Of the matched, how many would change (or did). */
  written: number;
  /** The matched lines' sheet cost, summed — paise. */
  matchedCostPaise: number;
  /** Matched lines by dispatch month, "2026-10" → count. */
  byMonth: Record<string, number>;
  /** A few unmatched and ambiguous lines, for whoever reads the log. */
  examples: string[];
};

const BATCH = 1000;

export async function backfillSheetCosting(opts: { dryRun?: boolean } = {}): Promise<SheetCostingReport> {
  const dryRun = !!opts.dryRun;
  const [lines, rows, names] = await Promise.all([
    db.execute<{ id: string; order_no: number; sku_id: string; qty_cans: number; month: string | null; stored: string | null }>(sql`
      select o.id, o.order_no, o.sku_id, o.qty_cans, to_char(d.dispatch_date, 'YYYY-MM') as month,
             d.sheet_costing_paise::text as stored
        from erp_orders o
        join erp_order_details d on d.order_id = o.id
       where d.dispatch_date is not null
         and not exists (select 1 from erp_batch_codes b where b.order_id = o.id)`),
    db.execute<{ order_number: string | null; description: string | null; cans: number | null; cost: string | null }>(sql`
      select order_number, description, cans, raw->>'Lotcode Costing' as cost from sheet_order_rows`),
    db.execute<{ product_id: string; name: string; alias: boolean }>(sql`
      select id as product_id, name, false as alias from products
      union all
      select product_id, name, true as alias from product_aliases`),
  ]);

  /* A SKU's own name wins over an alias that happens to normalise the same. */
  const productOf = new Map<string, string>();
  for (const n of names) if (!n.alias) productOf.set(matchKey(n.name), n.product_id);
  for (const n of names) if (n.alias && !productOf.has(matchKey(n.name))) productOf.set(matchKey(n.name), n.product_id);

  const sheet: SheetCostRow[] = rows.map((r) => ({
    orderNo: /^\d+$/.test(String(r.order_number ?? "").trim()) ? Number(String(r.order_number).trim()) : null,
    productId: r.description ? (productOf.get(matchKey(r.description)) ?? null) : null,
    cans: r.cans == null ? null : Number(r.cans),
    cost: r.cost,
  }));
  const candidates: CostLine[] = lines.map((l) => ({ id: l.id, orderNo: Number(l.order_no), productId: l.sku_id, cans: Number(l.qty_cans) }));
  const m = matchSheetCosting(candidates, sheet);

  const lineById = new Map(lines.map((l) => [l.id, l]));
  const changes: { id: string; c: number }[] = [];
  const byMonth: Record<string, number> = {};
  let matchedCostPaise = 0;
  for (const [id, paise] of m.costs) {
    const l = lineById.get(id)!;
    matchedCostPaise += paise;
    const month = l.month ?? "—";
    byMonth[month] = (byMonth[month] ?? 0) + 1;
    if (l.stored == null || Number(l.stored) !== paise) changes.push({ id, c: paise });
  }

  if (!dryRun) {
    for (let i = 0; i < changes.length; i += BATCH) {
      const chunk = changes.slice(i, i + BATCH);
      await db.execute(sql`
        update erp_order_details d
           set sheet_costing_paise = v.c
          from jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) as v(id text, c bigint)
         where d.order_id = v.id`);
    }
  }

  const label = (id: string) => {
    const l = lineById.get(id)!;
    return `order ${l.order_no} · ${l.qty_cans} cans · left ${l.month ?? "—"}`;
  };
  return {
    dryRun,
    candidates: candidates.length,
    matched: m.costs.size,
    ambiguous: m.ambiguous.length,
    unmatched: m.unmatched.length,
    written: changes.length,
    matchedCostPaise,
    byMonth,
    examples: [
      ...m.ambiguous.slice(0, 5).map((id) => `  ambiguous: ${label(id)}`),
      ...m.unmatched.slice(0, 10).map((id) => `  unmatched: ${label(id)}`),
    ],
  };
}
