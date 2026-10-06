import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpProductPacking, erpRawMaterials, products } from "@/db/schema";
import { readTab } from "@/lib/sheets";
import { partySheetId } from "@/lib/services/party-sync-service";
import { BOX_TYPES } from "./refs";
import { erpId } from "./server";
import { planPackingImport, PACKING_MATERIAL_TYPES, type PackingPlan } from "./packing-plan";

/* ---------------------------------------------------------------------------
 * Reads "My Products" and "Raw Materials" from the Mahek Plus Master workbook
 * — the same workbook the Sales Party sync reads — and writes what
 * `planPackingImport` says. The rules are all in the plan; this file is the
 * reading, the one transaction and the report.
 * ------------------------------------------------------------------------- */

export const PRODUCTS_TAB = "My Products";
export const MATERIALS_TAB = "Raw Materials";

export type PackingImportReport = Omit<PackingPlan, "materials" | "packing"> & {
  materialsCreated: string[];
  packingSet: { sku: string; productIdOnSheet: string; canUse: string | null; boxType: string | null; emptyBoxesRequired: number }[];
  /** SKUs written with a Can Use. */
  withCanUse: number;
  applied: boolean;
};

export async function importPackingFromMahekPlus(opts: { dryRun: boolean; userId?: string | null }): Promise<PackingImportReport> {
  const sheet = partySheetId();
  const [productTab, materialTab, existingMaterials, skus, packed] = await Promise.all([
    readTab(sheet, PRODUCTS_TAB),
    readTab(sheet, MATERIALS_TAB),
    db.select({ id: erpRawMaterials.id, name: erpRawMaterials.name, materialType: erpRawMaterials.materialType }).from(erpRawMaterials),
    db.select({ id: products.id, name: products.name, externalCode: products.externalCode, externalIds: products.externalIds }).from(products),
    db.select({ id: erpProductPacking.productId }).from(erpProductPacking),
  ]);
  for (const [tab, t, need] of [
    [PRODUCTS_TAB, productTab, ["Product ID", "Can Use"]],
    [MATERIALS_TAB, materialTab, ["Raw Item", "Material type"]],
  ] as const) {
    const missing = need.filter((h) => !t.headers.includes(h));
    if (missing.length) throw new Error(`The ${tab} tab has no ${missing.join(" or ")} column — has it been renamed?`);
  }

  const plan = planPackingImport({
    products: productTab.rows,
    materials: materialTab.rows,
    existingMaterials,
    skus,
    packedProductIds: new Set(packed.map((p) => p.id)),
    boxTypes: BOX_TYPES,
  });
  const { materials, packing, ...rest } = plan;

  if (!opts.dryRun && (materials.length || packing.length)) {
    await db.transaction(async (tx) => {
      /* Serials are max + 1 under a lock, the same as the ERP's own form. */
      await tx.execute(sql`lock table erp_raw_materials in share row exclusive mode`);
      const [{ next }] = (await tx.execute(
        sql`select coalesce(max(serial_no), 0) + 1 as next from erp_raw_materials`,
      )) as unknown as { next: number }[];
      let serial = Number(next);
      const now = new Date();
      if (materials.length)
        await tx.insert(erpRawMaterials).values(
          materials.map((m) => ({
            id: erpId("erprm"),
            serialNo: serial++,
            ...m,
            createdById: opts.userId ?? null,
            updatedById: opts.userId ?? null,
            createdAt: now,
            updatedAt: now,
          })),
        );
      const ids = new Map(
        (
          await tx
            .select({ id: erpRawMaterials.id, name: erpRawMaterials.name })
            .from(erpRawMaterials)
            .where(inArray(erpRawMaterials.materialType, [...PACKING_MATERIAL_TYPES]))
        ).map((m) => [m.name.trim().replace(/\s+/g, " ").toLowerCase(), m.id]),
      );
      if (packing.length)
        await tx
          .insert(erpProductPacking)
          .values(
            packing.map((p) => ({
              productId: p.productId,
              canUseMaterialId: p.canUse ? (ids.get(p.canUse.trim().replace(/\s+/g, " ").toLowerCase()) ?? null) : null,
              emptyBoxesRequired: p.emptyBoxesRequired,
              boxType: p.boxType,
              boxRatePaise: p.boxRatePaise,
              updatedAt: now,
              updatedById: opts.userId ?? null,
            })),
          )
          /* Somebody saved "Edit packing" between the read and now: theirs stands. */
          .onConflictDoNothing({ target: erpProductPacking.productId });
    });
  }

  return {
    ...rest,
    materialsCreated: materials.map((m) => m.name),
    packingSet: packing.map((p) => ({
      sku: p.sku,
      productIdOnSheet: p.productIdOnSheet,
      canUse: p.canUse,
      boxType: p.boxType,
      emptyBoxesRequired: p.emptyBoxesRequired,
    })),
    withCanUse: packing.filter((p) => p.canUse).length,
    applied: !opts.dryRun,
  };
}

/** One line for a job log or a toast. */
export function packingImportSummary(r: PackingImportReport): string {
  const verb = r.applied ? "" : "would be ";
  return [
    `${r.materialsCreated.length} packing raw materials ${verb}added (${r.materialsExisting} already there)`,
    `${r.packingSet.length} SKUs' packing ${verb}set, ${r.withCanUse} with a Can Use`,
    `${r.kept.length} already set in the ERP and left alone`,
    `${r.noSku.length} Product IDs match no SKU`,
    `${r.unknownCan.length} Can Use names not found`,
    `${r.conflicting.length} duplicate Product IDs disagreeing with the row used`,
  ].join(" · ");
}
