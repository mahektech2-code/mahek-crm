import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { erpGodowns, erpPoLines, erpPurchaseOrders, erpRawMaterials, erpRequisitions, erpSuppliers } from "@/db/schema";
import { erpId, nextNumber } from "./server";
import { poLabel, purchaseUnit } from "./engines/purchase-flow";

/**
 * FOR TESTS: an approved PO line, placed directly, for a test whose subject is
 * what happens AFTER goods arrive (production, stock, AI readings). No goods
 * are received in MahekOne without a PO, so those tests need one; the flow
 * that raises it is tested on its own in erp-purchase.test.ts.
 *
 * Answers the labels the receipt and register forms pick by.
 */
export async function approvedPoLine(
  supplierName: string,
  itemName: string,
  quantity: number,
  opts: { ratePaise?: number; godown?: string } = {},
): Promise<{ po: string; poLine: string; poId: string }> {
  const p = await approvedPo(supplierName, [{ item: itemName, quantity, ratePaise: opts.ratePaise }], opts);
  return { po: p.po, poLine: p.lines[itemName], poId: p.poId };
}

/** An approved PO with several items; `lines` maps each item to its line label. */
export async function approvedPo(
  supplierName: string,
  items: { item: string; quantity: number; ratePaise?: number }[],
  opts: { godown?: string } = {},
): Promise<{ po: string; poId: string; lines: Record<string, string> }> {
  const [sup] = await db.select().from(erpSuppliers).where(eq(erpSuppliers.name, supplierName));
  const [gd] = await db.select().from(erpGodowns).where(eq(erpGodowns.name, opts.godown ?? "Bhiwandi"));
  if (!sup || !gd) throw new Error(`approvedPo: ${supplierName} / ${opts.godown ?? "Bhiwandi"} not found`);
  return db.transaction(async (tx) => {
    const n = await nextNumber(tx, "po");
    const poId = erpId("po");
    await tx.insert(erpPurchaseOrders).values({
      id: poId,
      poNumber: n,
      poDate: "2026-01-01",
      supplierId: sup.id,
      godownId: gd.id,
      deliveryDate: "2026-01-02",
      paymentTerms: "30 days credit",
      status: "Approved",
      approvedAt: new Date(),
    });
    const lines: Record<string, string> = {};
    let i = 0;
    for (const it of items) {
      const [mat] = await tx.select().from(erpRawMaterials).where(eq(erpRawMaterials.name, it.item));
      if (!mat) throw new Error(`approvedPo: ${it.item} not found`);
      const unit = purchaseUnit(mat.unit, mat.materialType);
      const reqId = erpId("req");
      await tx.insert(erpRequisitions).values({
        id: reqId,
        reqDate: "2026-01-01",
        requiredBy: "2026-01-01",
        department: "Production",
        godownId: gd.id,
        materialType: mat.materialType,
        rawMaterialId: mat.id,
        unit,
        requiredQty: it.quantity,
        priority: "Medium",
        status: "Order Placed",
        purchaseRule: "direct",
        method: "direct",
        supplierId: sup.id,
      });
      await tx.insert(erpPoLines).values({ id: erpId("pol"), poId, requisitionId: reqId, rawMaterialId: mat.id, quantity: it.quantity, unit, ratePaise: it.ratePaise ?? 100, gstBp: 1800, sortOrder: i });
      lines[it.item] = `${++i}. ${mat.name}`;
    }
    return { po: `${poLabel(n)} · ${sup.name}`, poId, lines };
  });
}
