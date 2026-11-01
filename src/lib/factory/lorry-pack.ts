import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { loadingLines, lotsFreeAt, unitsForLoading } from "@/lib/erp/dispatch";
import { stickeredLines } from "@/lib/erp/dispatch-stickers";
import { lorryKeyOf } from "./rules";
import { inList, type FactoryCtx } from "./server";
import type { LoadingPack, PackSticker } from "./lorry-judge";

/* ---------------------------------------------------------------------------
 * WHAT A PHONE NEEDS TO JUDGE A LORRY'S SCANS ON ITS OWN: the lorry's lines as
 * the desk counts them (`loadingLines`, the same read `lorryScan` starts
 * from), every box that could go on or is already on, its stickers, approved
 * overrides, and what each of those boxes' lots has free. `lorry-judge.ts`
 * reads nothing else, so a judgement it gets wrong is a gap in THIS list —
 * which is exactly what shadow mode is there to find.
 * ------------------------------------------------------------------------- */

export async function lorryPack(fc: FactoryCtx, key: string): Promise<LoadingPack | null> {
  if (!fc.dispatch) return null;
  key = String(key ?? "");
  const at = new Date().toISOString();
  const lines = await loadingLines(db, fc.godown.id, (t) => lorryKeyOf(t) === key);
  const ids = lines.map((l) => l.id);
  if (!ids.length) return { key, godownId: fc.godown.id, at, lines: [], units: [], overrides: [], stickers: [], free: [] };
  const skus = [...new Set(lines.map((l) => l.skuId))];
  const products = [...new Set(lines.map((l) => l.productId).filter((p): p is string => !!p))];
  const [stickered, units, overrides, stickers] = await Promise.all([
    stickeredLines(db, ids),
    unitsForLoading(db, fc.godown.id, ids, skus, products),
    db.execute(sql`select unit_id as "unitId", order_id as "lineId" from erp_dispatch_overrides where status = 'Approved' and order_id in ${inList(ids)}`) as unknown as Promise<{ unitId: string; lineId: string }[]>,
    db.execute(sql`select id, status, order_id as "lineId", order_no as "orderNo", unit_id as "unitId" from erp_dispatch_stickers where order_id in ${inList(ids)}`) as unknown as Promise<PackSticker[]>,
  ]);
  const lots = [...new Map(units.filter((u) => u.status === "available").map((u) => [`${u.lotFrom}|${u.lotCode}`, { lotFrom: u.lotFrom, lotCode: u.lotCode }])).values()];
  const free = await lotsFreeAt(db, fc.godown.id, lots);
  return {
    key,
    godownId: fc.godown.id,
    at,
    lines: lines.map((l) => ({
      id: l.id, orderNo: l.orderNo, skuId: l.skuId, skuName: l.skuName, productId: l.productId, productName: l.productName, packLabel: l.packLabel,
      godownId: l.godownId, godownName: l.godownName, boxed: l.boxed, target: l.target, scanned: l.scanned, alloc: l.alloc,
      dispatched: l.dispatched, cancelled: l.cancelled, finishedGoodId: l.finishedGoodId ?? null, dispatchOn: l.dispatchOn, stickered: stickered.has(l.id),
    })),
    units,
    overrides,
    stickers: stickers.map((s) => ({ id: String(s.id), status: String(s.status), lineId: String(s.lineId), orderNo: Number(s.orderNo), unitId: s.unitId == null ? null : String(s.unitId) })),
    free,
  };
}
