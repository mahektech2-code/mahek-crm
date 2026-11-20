import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { MrpStock } from "./engines/mrp";
import { fgLots, packLots, rmLots, sfgLots } from "./stock";

/** What the godown holds now, for the MRP check — read once per page. */
export async function mrpStockAt(godownIds: string[]): Promise<Map<string, MrpStock>> {
  const out = new Map<string, MrpStock>();
  if (!godownIds.length) return out;
  const [packs, fgs, sfgs, rms, qc, recipes] = await Promise.all([
    packLots(db, { rates: false }),
    fgLots(db, { rates: false }),
    sfgLots(db, { rates: false }),
    rmLots(db, { rates: false }),
    db.execute(sql`select lot_code as "lotCode", status from erp_sfg_qc`) as unknown as Promise<{ lotCode: string; status: string }[]>,
    db.execute(sql`select formulation_id as "formulationId", raw_material_id as "materialId", qty_per_batch::float8 as qty from erp_recipes where retired_at is null`) as unknown as Promise<{ formulationId: string; materialId: string; qty: number }[]>,
  ]);
  const qcOf = new Map(qc.map((q) => [q.lotCode, q.status]));
  const recipe = new Map<string, Map<string, number>>();
  for (const r of recipes) {
    const m = recipe.get(r.formulationId) ?? new Map<string, number>();
    m.set(r.materialId, Number(r.qty));
    recipe.set(r.formulationId, m);
  }
  for (const gid of new Set(godownIds)) {
    const s: MrpStock = { packedBoxes: new Map(), looseCans: new Map(), baseLitres: new Map(), batchLitres: new Map(), material: new Map(), materialName: new Map(), materialUnit: new Map(), recipe };
    const add = (m: Map<string, number>, k: string | null, n: number) => k && m.set(k, (m.get(k) ?? 0) + n);
    for (const p of packs) if (p.godownId === gid && p.stock > 0) add(s.packedBoxes, p.skuId, p.stock);
    for (const f of fgs) if (f.godownId === gid && f.stock > 0) add(s.looseCans, f.finishedGoodId, f.stock);
    for (const b of sfgs) {
      if (b.godownId !== gid) continue;
      if (b.batchSize && b.batchSize > 0) s.batchLitres.set(b.formulationId, b.batchSize);
      /* No QC row reads as Pending (`erp_sfg_qc`): only approved base can be filled. */
      if (b.stock > 0 && qcOf.get(b.lotCode) === "Approved") add(s.baseLitres, b.formulationId, b.stock);
    }
    for (const r of rms) {
      s.materialName.set(r.rawMaterialId, r.item);
      s.materialUnit.set(r.rawMaterialId, r.unit);
      if (r.godownId === gid && r.stock > 0) add(s.material, r.rawMaterialId, r.stock);
    }
    out.set(gid, s);
  }
  return out;
}

