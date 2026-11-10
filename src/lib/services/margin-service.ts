import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpBatchCodes } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { countLines, detailRows, type LineFilter } from "@/lib/erp/screens/sales";
import { daysBetween } from "@/lib/erp/engines/sales";
import { placeNamesFor } from "@/lib/services/place-filter-service";
import type { MarginLine, MarginRules } from "@/lib/engines/margins";

/* ---------------------------------------------------------------------------
 * THE FOUNDER'S MARGINS — read off the ERP's own billed lines.
 *
 * Every figure comes from `detailRows`, the reading the ERP's Order details
 * register and its Margin column already make: the bill's amount and
 * discount, the cost of the lots the dispatch desk allocated plus the line's
 * extra expenses (`lotCosting`), and the credit notes issued against the bill
 * and goods, taken back to before GST. Nothing here re-derives a margin — the
 * line's `margin` is the ERP's, and this file only splits the extra expenses
 * back out of the costing so the founder can see the two apart.
 *
 * A line is a SALE once it has left: billed and dispatch-verified, dated by
 * its dispatch date. A billed line still at the gate has not been sold yet,
 * and a line with no rate has no amount to take a margin of.
 * ------------------------------------------------------------------------- */

/** More lines than this in one period is refused in words rather than shipped to a browser. */
export const MARGIN_LINE_CAP = 20_000;

export type MarginRead = { lines: MarginLine[]; tooWide: number | null };

export async function marginRules(): Promise<MarginRules> {
  const c = await getConfig();
  return {
    healthyAtOrAbove: c["margins.healthyAtOrAbove"],
    fairAtOrAbove: c["margins.fairAtOrAbove"],
    thinAtOrAbove: c["margins.thinAtOrAbove"],
    floorPercent: c["margins.floorPercent"],
    targetPercent: c["margins.targetPercent"],
    productDropPoints: c["margins.productDropPoints"],
    customerDropPercent: c["margins.customerDropPercent"],
  };
}

function filterFor(from: string, to: string): LineFilter {
  return { billed: true, window: { on: "dispatch", scope: { pd: "custom", window: { from, to }, ids: null, open: null } } };
}

export async function marginLines(from: string, to: string): Promise<MarginRead> {
  const f = filterFor(from, to);
  const n = await countLines(f);
  if (n > MARGIN_LINE_CAP) return { lines: [], tooWide: n };
  const { rows } = await detailRows(f);
  const sold = rows.filter((r) => r.l.dispatched && r.d.dispatchDate && r.amount != null);
  if (!sold.length) return { lines: [], tooWide: null };

  const orderIds = [...new Set(sold.map((r) => r.l.o.id))];
  const skuIds = [...new Set(sold.map((r) => r.l.sku.id))];
  const customerIds = [...new Set(sold.map((r) => r.l.o.billingCustomerId))];
  const [lots, forms, places] = await Promise.all([
    db.select({ orderId: erpBatchCodes.orderId, lotCode: erpBatchCodes.lotCode }).from(erpBatchCodes).where(inArray(erpBatchCodes.orderId, orderIds)),
    db.execute(sql`
      select p.id, coalesce(f.name, ff.name) as formulation
        from products p
        left join product_formulations f on f.id = p.formulation_id
        left join finished_goods fg on fg.id = p.finished_good_id
        left join product_formulations ff on ff.id = fg.formulation_id
       where p.id in (${sql.join(skuIds.map((v) => sql`${v}`), sql`, `)})
    `) as unknown as Promise<{ id: string; formulation: string | null }[]>,
    placeNamesFor(customerIds),
  ]);
  const lotsOf = new Map<string, string[]>();
  for (const b of lots) {
    if (!b.orderId) continue;
    const a = lotsOf.get(b.orderId) ?? [];
    if (!a.includes(b.lotCode)) a.push(b.lotCode);
    lotsOf.set(b.orderId, a);
  }
  const formOf = new Map(forms.map((r) => [r.id, r.formulation]));

  return {
    tooWide: null,
    lines: sold.map((r): MarginLine => {
      const l = r.l;
      const extra = r.d.extraExpensesPaise ?? 0;
      const place = places.get(l.o.billingCustomerId);
      const orderDate = String(l.o.orderDate).slice(0, 10);
      const dispatch = String(r.d.dispatchDate).slice(0, 10);
      return {
        id: l.o.id,
        orderNo: l.o.orderNo,
        date: dispatch,
        customerId: l.o.billingCustomerId,
        customer: l.billing.name,
        salesman: l.billing.salesPerson?.trim() || "No salesman named",
        state: place?.state ?? "Not placed",
        district: place?.district ?? "Not placed",
        city: place?.city ?? (l.billing.city?.trim() || "Not placed"),
        godown: l.godown || "—",
        product: l.sku.name,
        formulation: formOf.get(l.sku.id) ?? "Not classified",
        lots: lotsOf.get(l.o.id) ?? [],
        cans: l.o.qtyCans,
        litres: r.litres,
        ratePaise: l.o.ratePaise,
        amountPaise: r.amount ?? 0,
        discountPaise: r.discounted ?? 0,
        lotCostPaise: r.costing == null ? null : r.costing - extra,
        extraPaise: extra,
        creditNotePaise: r.creditNote ?? 0,
        marginPaise: r.margin,
        days: orderDate && dispatch ? daysBetween(orderDate, dispatch) : null,
      };
    }),
  };
}
