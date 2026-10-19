import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpGodowns, erpPoLines, erpPurchaseOrders, erpQuoteColumns, erpQuoteRows, erpRawMaterials, erpRequisitions, erpSuppliers } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { err, fieldErr, ok, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { departmentForCategory, requirementVisibleTo } from "../departments";
import { erpAudit, erpId, nextNumber, paise, text } from "../server";
import { fd, inr, inrRate } from "../ui";
import {
  LIVE_PO,
  normalisePoNo,
  pickQuotePoCell,
  poLabel,
  poRouteOf,
  poTotals,
  purchaseUnit,
  quoteRatePaise,
  seriesNumberOf,
  type PoRoute,
  type QuotePoCell,
} from "../engines/purchase-flow";
import { godownIdByName, godownOptions, inTx, refuse, today, type Tx } from "./common";
import { heldByStock, refreshPurchaseOrder, requirementViews, type ReqView } from "./purchase-flow";

/* ---------------------------------------------------------------------------
 * A REQUIREMENT GETS ITS PO ONE OF TWO WAYS, chosen by the item's purchase
 * rule (`poRouteOf`), and NEITHER IS APPROVED: the PO arrives ready to receive.
 *
 * - Quotation: the rate is chosen and bought on the Quotation manager, whose
 *   Purchase it makes the PO number. The requirement LINKS that number: the
 *   cell is found, checked against the requirement, and the ERP keeps a PO
 *   for it (source `quotation_manager`, status Sent, the same number).
 * - Direct purchase: no quotation. The requirement CREATES its PO, at the
 *   item's price in Raw materials — nobody types an amount, and an item with
 *   no price is ordered at ₹0.
 *
 * A Buyer-decision item may do either.
 * ------------------------------------------------------------------------- */

/** Who may act on this requirement's PO, and why not. Null: they may. */
function poRefusal(ctx: ErpContext, v: ReqView | undefined): Result<never> | null {
  if (!v) return err("That requirement no longer exists.", "not_found");
  if (!requirementVisibleTo(ctx.department, v.r.department, v.r.createdById === ctx.user.id)) return err("That requirement belongs to another department.", "not_permitted");
  if (v.r.status === "Cancelled") return err("This requirement is cancelled.", "conflict");
  if (v.legacy) return err("This requirement was ordered before POs were kept in the ERP.", "conflict");
  if (v.po) return err(`It is already on ${v.po.name}.`, "conflict");
  if (!v.r.rawMaterialId) return err("Only a raw-material requirement is put on a PO.", "rule_violation");
  const held = heldByStock(v);
  if (held) return held as Result<never>;
  return null;
}

function routeAllows(v: ReqView, want: "link" | "create"): Result<never> | null {
  const route: PoRoute = poRouteOf({ rule: v.rule, method: v.method });
  if (route === "either" || route === want) return null;
  return want === "link"
    ? err("This item is a direct purchase — create its PO here; it is not bought on the Quotation manager.", "rule_violation")
    : err("This item is bought by quotation — buy it on the Quotation manager and link the PO number it made.", "rule_violation");
}

/** Every Quotation manager cell recorded under this PO number, with what each needs to be checked. */
async function quoteCellsForPo(poNo: string, tx: Tx | typeof db = db): Promise<(QuotePoCell & { boughtById: string | null; boughtAtTs: Date | null })[]> {
  const rows = (await tx.execute(sql`
    select c.row_id as "rowId", c.column_id as "columnId", col.raw_material_id as "materialId",
           concat_ws(' · ', nullif(col.pack, ''), nullif(col.name, ''), nullif(col.brand, '')) as material,
           r.party, r.supplier_id as "supplierId", c.value, c.status, r.status as "rowStatus", c.drums, c.po_no as "poNo",
           r.quote_date::text as "quotedOn", u.name as "boughtBy", c.po_by_id as "boughtById", c.po_at as "boughtAtTs"
      from erp_quote_cells c
      join erp_quote_rows r on r.id = c.row_id and r.deleted_at is null
      join erp_quote_columns col on col.id = c.column_id
      left join users u on u.id = c.po_by_id
     where c.po_no is not null and upper(regexp_replace(trim(c.po_no), '\s+', ' ', 'g')) = ${normalisePoNo(poNo)}
  `)) as unknown as (Omit<QuotePoCell, "boughtAt"> & { boughtById: string | null; boughtAtTs: Date | string | null })[];
  return rows.map((r) => {
    const at = r.boughtAtTs ? new Date(r.boughtAtTs) : null;
    return { ...r, drums: r.drums == null ? null : Number(r.drums), boughtAt: at ? at.toISOString() : null, boughtAtTs: at };
  });
}

/** The ERP PO already kept for this Quotation manager number, if any. */
async function poForNumber(poNo: string, tx: Tx | typeof db = db) {
  const [po] = await tx
    .select()
    .from(erpPurchaseOrders)
    .where(sql`upper(${erpPurchaseOrders.qmPoNo}) = ${normalisePoNo(poNo)}`)
    .limit(1);
  return po ?? null;
}

export type LinkPreview = {
  poNo: string;
  vendor: string;
  material: string;
  party: string;
  rate: string | null;
  gst: string;
  drums: number | null;
  quantity: string;
  amount: string | null;
  quotedOn: string;
  boughtBy: string | null;
  boughtAt: string | null;
  /** Another requirement's items already on this PO number. */
  shared: number;
};

/** What a typed PO number fetches from the Quotation manager, checked against the requirement. Writes nothing. */
export async function lookupRequirementPo(ctx: ErpContext, id: string, raw: string): Promise<Result<LinkPreview>> {
  const poNo = normalisePoNo(raw ?? "");
  if (!poNo) return fieldErr("poNo", "Type the PO number");
  const [v] = await requirementViews({ ids: [id] });
  const refused = poRefusal(ctx, v) ?? routeAllows(v!, "link");
  if (refused) return refused;
  const picked = pickQuotePoCell(await quoteCellsForPo(poNo), v!.r.rawMaterialId!, v!.item, raw.trim());
  if (!picked.ok) return fieldErr("poNo", picked.error);
  const existing = await poForNumber(poNo);
  let shared = 0;
  if (existing && !["Cancelled", "Rejected"].includes(existing.status)) {
    if (existing.supplierId !== picked.cell.supplierId) return fieldErr("poNo", `${existing.qmPoNo} is kept for another vendor in the ERP.`);
    if (existing.status === "Closed") return fieldErr("poNo", `${existing.qmPoNo} is closed in the ERP — nothing more is received against it.`);
    const lines = await db.select().from(erpPoLines).where(eq(erpPoLines.poId, existing.id));
    if (lines.some((l) => l.rawMaterialId === v!.r.rawMaterialId)) return fieldErr("poNo", `${existing.qmPoNo} is already linked to another requirement for ${v!.item}.`);
    shared = lines.length;
  }
  const [sup] = await db.select({ name: erpSuppliers.name }).from(erpSuppliers).where(eq(erpSuppliers.id, picked.cell.supplierId!));
  const gstPercent = (await getConfig())["erp.purchase.poGstPercent"];
  const money = ctx.powers.has("viewPurchaseMoney");
  const t = poTotals([{ quantity: v!.r.requiredQty, ratePaise: picked.ratePaise, gstBp: gstPercent * 100 }], 0);
  return ok({
    poNo: picked.cell.poNo ?? poNo,
    vendor: sup?.name ?? picked.cell.party,
    material: picked.cell.material,
    party: picked.cell.party,
    rate: money ? `${inrRate(picked.ratePaise)} a ${v!.r.unit.toLowerCase()}` : null,
    gst: `${gstPercent}%`,
    drums: picked.cell.drums,
    quantity: `${v!.r.requiredQty} ${v!.r.unit}`,
    amount: money ? `${inr(t.totalPaise)} with GST` : null,
    quotedOn: fd(picked.cell.quotedOn),
    boughtBy: picked.cell.boughtBy,
    boughtAt: picked.cell.boughtAt,
    shared,
  });
}

/** Lines already on a PO, and the next free sort order. */
async function nextSort(tx: Tx, poId: string): Promise<number> {
  const [r] = (await tx.execute(sql`select coalesce(max(sort_order), -1) + 1 as n from erp_po_lines where po_id = ${poId}`)) as unknown as { n: number }[];
  return Number(r?.n ?? 0);
}

/** The PO number an ERP PO for a Quotation manager number takes: the same number where the QM made it, else a fresh one. */
async function numberFor(tx: Tx, poNo: string): Promise<number> {
  const n = seriesNumberOf(poNo);
  if (n != null) {
    const [taken] = await tx.select({ id: erpPurchaseOrders.id }).from(erpPurchaseOrders).where(eq(erpPurchaseOrders.poNumber, n)).limit(1);
    if (!taken) return n;
  }
  return nextNumber(tx, "po");
}

async function lockRequirement(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`select id from erp_requisitions where id = ${id} for update`);
  const taken = (await tx.execute(sql`
    select o.po_number as n, o.qm_po_no as qm from erp_po_lines l join erp_purchase_orders o on o.id = l.po_id
     where l.requisition_id = ${id} and o.status in (${sql.join(LIVE_PO.map((s) => sql`${s}`), sql`, `)})
  `)) as unknown as { n: number; qm: string | null }[];
  if (taken.length) refuse(err(`It is already on ${taken[0].qm || poLabel(taken[0].n)}.`, "conflict"));
}

/** Links the requirement to the PO number the Quotation manager made. No approval: the PO is Sent, ready to receive. */
export async function linkRequirementPo(ctx: ErpContext, id: string, raw: string): Promise<Result<unknown>> {
  const poNo = normalisePoNo(raw ?? "");
  if (!poNo) return fieldErr("poNo", "Type the PO number");
  const [v] = await requirementViews({ ids: [id] });
  const refused = poRefusal(ctx, v) ?? routeAllows(v!, "link");
  if (refused) return refused;
  const gstBp = (await getConfig())["erp.purchase.poGstPercent"] * 100;
  let label = "";
  let poId = "";
  const res = await inTx(async (tx) => {
    await lockRequirement(tx, id);
    const picked = pickQuotePoCell(await quoteCellsForPo(poNo, tx), v!.r.rawMaterialId!, v!.item, raw.trim());
    if (!picked.ok) return fieldErr("poNo", picked.error);
    const cell = picked.cell as QuotePoCell & { boughtById: string | null; boughtAtTs: Date | null };
    const [sup] = await tx.select().from(erpSuppliers).where(eq(erpSuppliers.id, cell.supplierId!));
    if (!sup) return fieldErr("poNo", "The party on that row is not one of the Purchase parties.");
    const stamp = cell.boughtAtTs ?? new Date();
    const poDate = today();
    const delivery = v!.r.requiredBy && v!.r.requiredBy > poDate ? v!.r.requiredBy : poDate;
    let po = await poForNumber(poNo, tx);
    if (po) {
      [po] = await tx.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, po.id)).for("update");
      if (po.supplierId !== sup.id && !["Cancelled", "Rejected"].includes(po.status)) return fieldErr("poNo", `${po.qmPoNo} is kept for another vendor in the ERP.`);
      if (po.status === "Closed") return fieldErr("poNo", `${po.qmPoNo} is closed in the ERP — nothing more is received against it.`);
      const lines = await tx.select().from(erpPoLines).where(eq(erpPoLines.poId, po.id));
      if (!["Cancelled", "Rejected"].includes(po.status) && lines.some((l) => l.rawMaterialId === v!.r.rawMaterialId))
        return fieldErr("poNo", `${po.qmPoNo} is already linked to another requirement for ${v!.item}.`);
      if (["Cancelled", "Rejected"].includes(po.status)) await tx.delete(erpPoLines).where(eq(erpPoLines.poId, po.id));
      /* A PO a later line reopens is receiving again; refreshPurchaseOrder settles it from what arrived. */
      await tx
        .update(erpPurchaseOrders)
        .set({ status: "Sent", supplierId: sup.id, closedAt: null, closedById: null, closeReason: null, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(erpPurchaseOrders.id, po.id));
    } else {
      const id2 = erpId("po");
      const number = await numberFor(tx, poNo);
      await tx.insert(erpPurchaseOrders).values({
        id: id2,
        poNumber: number,
        source: "quotation_manager",
        qmPoNo: cell.poNo?.trim() || poNo,
        status: "Sent",
        poDate,
        supplierId: sup.id,
        godownId: v!.r.godownId,
        deliveryDate: delivery,
        paymentTerms: sup.creditDays ? `${sup.creditDays} days credit` : "As agreed",
        freightPaise: 0,
        remarks: null,
        approvedById: cell.boughtById ?? ctx.user.id,
        approvedAt: stamp,
        decisionNote: "No approval needed — bought on the Quotation manager",
        sentAt: stamp,
        sentById: cell.boughtById ?? ctx.user.id,
        sentVia: "Quotation manager",
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
      [po] = await tx.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, id2));
    }
    await tx.insert(erpPoLines).values({
      id: erpId("pol"),
      poId: po.id,
      requisitionId: id,
      rawMaterialId: v!.r.rawMaterialId!,
      quantity: v!.r.requiredQty,
      unit: v!.r.unit,
      ratePaise: picked.ratePaise,
      gstBp,
      sortOrder: await nextSort(tx, po.id),
      quoteRowId: cell.rowId,
      quoteColumnId: cell.columnId,
      drums: cell.drums,
    });
    await tx
      .update(erpRequisitions)
      .set({ supplierId: sup.id, status: "Order Placed", vendorSelectedAt: new Date(), vendorSelectedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(erpRequisitions.id, id));
    await refreshPurchaseOrder(tx, po.id);
    label = po.qmPoNo || poLabel(po.poNumber);
    poId = po.id;
    return ok({ poId: po.id }, `Linked to ${label} · ${sup.name} · waiting for goods`);
  });
  if (res.ok) await erpAudit(ctx, "erp.requisition.linkPo", "erp_requisition", id, null, { poNo: label, poId });
  return res;
}

/** Takes a Quotation manager PO off the requirement, while nothing has been received against it. */
export async function unlinkRequirementPo(ctx: ErpContext, id: string): Promise<Result<unknown>> {
  const [v] = await requirementViews({ ids: [id] });
  if (!v) return err("That requirement no longer exists.", "not_found");
  if (!requirementVisibleTo(ctx.department, v.r.department, v.r.createdById === ctx.user.id)) return err("That requirement belongs to another department.", "not_permitted");
  if (!v.po) return err("It is not on a PO.", "conflict");
  if (v.po.source !== "quotation_manager") return err(`${v.po.name} was created here — cancel it on Purchase orders.`, "rule_violation");
  if (v.po.received > 0) return err(`Goods were received against ${v.po.name} — it cannot be unlinked.`, "conflict");
  const name = v.po.name;
  const res = await inTx(async (tx) => {
    await tx.execute(sql`select id from erp_purchase_orders where id = ${v.po!.id} for update`);
    await tx.delete(erpPoLines).where(eq(erpPoLines.id, v.po!.lineId));
    const [left] = (await tx.execute(sql`select count(*)::int as n from erp_po_lines where po_id = ${v.po!.id}`)) as unknown as { n: number }[];
    if (!Number(left?.n))
      await tx
        .update(erpPurchaseOrders)
        .set({ status: "Cancelled", closeReason: "Unlinked from its requirement", closedAt: new Date(), closedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(erpPurchaseOrders.id, v.po!.id));
    else await refreshPurchaseOrder(tx, v.po!.id);
    await tx.update(erpRequisitions).set({ status: "Pending", supplierId: null, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpRequisitions.id, id));
    return ok(null, `Unlinked from ${name} · link the right PO number`);
  });
  if (res.ok) await erpAudit(ctx, "erp.requisition.unlinkPo", "erp_requisition", id, { po: name }, null);
  return res;
}

/** The item's price in Raw materials, in paise; null where none is set (the PO is then at ₹0). */
export async function itemPricePaise(rawMaterialId: string): Promise<number | null> {
  const [m] = await db.select({ p: erpRawMaterials.pricePaise }).from(erpRawMaterials).where(eq(erpRawMaterials.id, rawMaterialId));
  return m?.p == null ? null : Number(m.p);
}

/**
 * Creates the PO for a direct-purchase requirement. The rate is the item's
 * price in Raw materials and is never read from the request; no price is ₹0.
 * No approval: the PO is Approved, ready to send and receive against.
 */
export async function createRequirementPo(ctx: ErpContext, id: string, values: Record<string, string>): Promise<Result<unknown>> {
  if (!ctx.screens.has("purchaseOrders")) return err("Purchase orders is not on your account.", "not_permitted");
  const [v] = await requirementViews({ ids: [id] });
  const refused = poRefusal(ctx, v) ?? routeAllows(v!, "create");
  if (refused) return refused;
  const [vendor] = await db.select().from(erpSuppliers).where(and(eq(erpSuppliers.name, text(values.vendor) ?? ""), eq(erpSuppliers.active, true)));
  if (!vendor) return fieldErr("vendor", "Pick an active vendor");
  const qty = Number(values.qty);
  if (!Number.isFinite(qty) || qty <= 0) return fieldErr("qty", "Quantity is required");
  const godownId = await godownIdByName(text(values.deliverTo));
  if (!godownId) return fieldErr("deliverTo", "Deliver to is required");
  const deliveryDate = text(values.deliveryDate);
  const poDate = today();
  if (!deliveryDate) return fieldErr("deliveryDate", "Delivery date is required");
  if (deliveryDate < poDate) return fieldErr("deliveryDate", "Delivery cannot be before today");
  const terms = text(values.terms);
  if (!terms) return fieldErr("terms", "Payment terms are required");
  const freight = paise(values.freight) ?? 0;
  if (freight < 0) return fieldErr("freight", "Minus Quantity Not Allowed");
  const rate = (await itemPricePaise(v!.r.rawMaterialId!)) ?? 0;
  const gstBp = (await getConfig())["erp.purchase.poGstPercent"] * 100;
  const poId = erpId("po");
  let number = 0;
  const res = await inTx(async (tx) => {
    await lockRequirement(tx, id);
    number = await nextNumber(tx, "po");
    await tx.insert(erpPurchaseOrders).values({
      id: poId,
      poNumber: number,
      source: "erp",
      status: "Approved",
      poDate,
      supplierId: vendor.id,
      godownId,
      deliveryDate,
      paymentTerms: terms,
      freightPaise: freight,
      remarks: text(values.remarks),
      approvedById: ctx.user.id,
      approvedAt: new Date(),
      decisionNote: "No approval needed — created on the requirement at the item's price",
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });
    await tx.insert(erpPoLines).values({ id: erpId("pol"), poId, requisitionId: id, rawMaterialId: v!.r.rawMaterialId!, quantity: qty, unit: v!.r.unit, ratePaise: rate, gstBp, sortOrder: 0 });
    await tx
      .update(erpRequisitions)
      .set({ method: "direct", supplierId: vendor.id, status: "Order Placed", vendorSelectedAt: new Date(), vendorSelectedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(erpRequisitions.id, id));
    await refreshPurchaseOrder(tx, poId);
    const t = poTotals([{ quantity: qty, ratePaise: rate, gstBp }], freight);
    return ok({ poId }, `${poLabel(number)} created · ${vendor.name} · ${inr(t.totalPaise)}${rate ? "" : " — no price on the item"} · send it to the vendor`);
  });
  if (res.ok) await erpAudit(ctx, "erp.requisition.createPo", "erp_requisition", id, null, { poId, number, vendor: vendor.name, ratePaise: rate, qty });
  return res;
}

/* ===================================================================
 * PURCHASE IT ON THE QUOTATION MANAGER MAKES THE PURCHASE ORDER.
 *
 * The number used to be all it made, and the ERP's PO waited for somebody to
 * type that number into a requirement. Now the purchase dialog also says how
 * much, where it is delivered and by when — and, where a requirement for the
 * item is waiting, which one — and the PO is written in the same save: the
 * same number, source `quotation_manager`, Sent, ready to receive, exactly as
 * linking makes it. With no requirement waiting, one is raised for the
 * purchase (`QM_RAISED_REMARK`), because every PO line answers a requirement.
 * Undoing the purchase takes the PO back while nothing has been received.
 * =================================================================== */

/** What the purchase dialog asks besides the drums. */
export type QuoteOrder = { requisitionId?: string | null; qty: number; godown: string; deliveryDate: string };

/** The remark a requirement raised by a Quotation manager purchase carries, so undoing the purchase cancels it. */
export const QM_RAISED_REMARK = "Raised by a purchase on the Quotation manager";

/** A requirement a Quotation manager purchase may be put against. */
export type OpenRequirement = { id: string; label: string; materialId: string; qty: number; unit: string; godown: string; requiredBy: string | null };

export type PurchaseChoices = {
  godowns: string[];
  defaultGodown: string | null;
  /** Each raw material's purchase unit. */
  units: Record<string, string>;
  openRequirements: OpenRequirement[];
};

/** Why a requirement cannot take a Quotation manager purchase; null where it can. */
function quoteReqRefusal(ctx: ErpContext, v: ReqView | undefined, materialId: string): string | null {
  const r = poRefusal(ctx, v) ?? (v ? routeAllows(v, "link") : null);
  if (r) return r.ok ? null : r.error;
  if (v!.r.rawMaterialId !== materialId) return `That requirement is for ${v!.item}, not this column's material.`;
  return null;
}

/** What the Purchase it dialog offers: godowns, units and the requirements waiting for a PO. */
export async function purchaseChoices(ctx: ErpContext): Promise<PurchaseChoices> {
  const [gds, mats, waiting] = await Promise.all([
    godownOptions(ctx, { lost: false }),
    db.select({ id: erpRawMaterials.id, unit: erpRawMaterials.unit, type: erpRawMaterials.materialType }).from(erpRawMaterials),
    db
      .select({ id: erpRequisitions.id })
      .from(erpRequisitions)
      .where(
        and(
          eq(erpRequisitions.status, "Pending"),
          sql`${erpRequisitions.rawMaterialId} is not null`,
          sql`not exists (select 1 from erp_po_lines l join erp_purchase_orders o on o.id = l.po_id
                where l.requisition_id = ${erpRequisitions.id} and o.status in (${sql.join(LIVE_PO.map((x) => sql`${x}`), sql`, `)}))`,
        ),
      ),
  ]);
  const views = waiting.length ? await requirementViews({ ids: waiting.map((w) => w.id) }) : [];
  const openRequirements = views
    .filter((v) => !quoteReqRefusal(ctx, v, v.r.rawMaterialId ?? ""))
    .map((v) => ({
      id: v.r.id,
      label: `${v.r.reqNo ? `REQ-${v.r.reqNo}` : "Requirement"} · ${v.r.requiredQty} ${v.r.unit} · ${v.godown}${v.r.department ? ` · ${v.r.department}` : ""}`,
      materialId: v.r.rawMaterialId!,
      qty: v.r.requiredQty,
      unit: v.r.unit,
      godown: v.godown,
      requiredBy: v.r.requiredBy,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return {
    godowns: gds.map((g) => g.name),
    defaultGodown: ctx.workingGodown?.name ?? null,
    units: Object.fromEntries(mats.map((m) => [m.id, purchaseUnit(m.unit, m.type)])),
    openRequirements,
  };
}

/**
 * Writes the ERP PO for a cell just bought, in the Quotation manager's own
 * transaction. Refuses (rolling the purchase back) where a PO cannot be
 * written: no Purchase party on the row, no raw material on the column, a
 * rate that is not a number, or an order that does not add up.
 */
export async function orderFromQuote(
  tx: Tx,
  ctx: ErpContext,
  p: { rowId: string; columnId: string; poNo: string; value: string; drums: number | null; order: QuoteOrder },
): Promise<{ poId: string; label: string }> {
  const no = (m: string): never => refuse(err(m, "validation"));
  const [row] = await tx.select().from(erpQuoteRows).where(eq(erpQuoteRows.id, p.rowId));
  const [col] = await tx.select().from(erpQuoteColumns).where(eq(erpQuoteColumns.id, p.columnId));
  if (!row || !col) return no("That cell is no longer on the sheet. Refresh the page.");
  if (!row.supplierId) return no(`"${row.party || "This row"}" is not one of the Purchase parties. Pick the party from the list so the PO has a vendor.`);
  if (!col.rawMaterialId) return no(`The column "${[col.pack, col.name, col.brand].filter(Boolean).join(" ")}" is not linked to a raw material. Link it (right-click the column heading) so the PO knows what is bought.`);
  const ratePaise = quoteRatePaise(p.value);
  if (ratePaise == null) return no(`The rate "${p.value}" is not a number, so it cannot go on a PO.`);
  const [sup] = await tx.select().from(erpSuppliers).where(eq(erpSuppliers.id, row.supplierId));
  const [mat] = await tx.select().from(erpRawMaterials).where(eq(erpRawMaterials.id, col.rawMaterialId));
  if (!sup || !mat) return no("The vendor or the material is no longer in the master.");
  const qty = Number(p.order?.qty);
  if (!Number.isFinite(qty) || qty <= 0) return no("Enter the quantity bought.");
  const [gd] = await tx.select({ id: erpGodowns.id }).from(erpGodowns).where(eq(erpGodowns.name, String(p.order?.godown ?? "")));
  if (!gd) return no("Pick the godown it is delivered to.");
  const poDate = today();
  const delivery = /^\d{4}-\d{2}-\d{2}$/.test(String(p.order?.deliveryDate ?? "")) ? p.order.deliveryDate : "";
  if (!delivery) return no("Enter the delivery date.");
  if (delivery < poDate) return no("Delivery cannot be before today.");
  const unit = purchaseUnit(mat.unit, mat.materialType);
  const gstBp = (await getConfig())["erp.purchase.poGstPercent"] * 100;

  /* The requirement it answers: the one picked, checked again, or one raised now. */
  let reqId = p.order.requisitionId || null;
  if (reqId) {
    const [v] = await requirementViews({ ids: [reqId] });
    const why = quoteReqRefusal(ctx, v, mat.id);
    if (why) return no(why);
    await lockRequirement(tx, reqId);
    await tx
      .update(erpRequisitions)
      .set({ supplierId: sup.id, status: "Order Placed", vendorSelectedAt: new Date(), vendorSelectedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(erpRequisitions.id, reqId));
  } else {
    reqId = erpId("req");
    await tx.insert(erpRequisitions).values({
      id: reqId,
      reqNo: await nextNumber(tx, "requirement"),
      reqDate: poDate,
      requiredBy: delivery,
      department: departmentForCategory(mat.materialType),
      godownId: gd.id,
      materialType: mat.materialType,
      rawMaterialId: mat.id,
      unit,
      requiredQty: qty,
      priority: "Medium",
      remarks: QM_RAISED_REMARK,
      purchaseRule: mat.purchaseMethod,
      method: "quotation",
      supplierId: sup.id,
      vendorSelectedAt: new Date(),
      vendorSelectedById: ctx.user.id,
      status: "Order Placed",
      stockCheckRequired: false,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });
  }

  /* The PO: the one already kept for this number (a live one for the same vendor gains a line), else a new one. */
  let po = await poForNumber(p.poNo, tx);
  if (po && !["Cancelled", "Rejected"].includes(po.status)) {
    [po] = await tx.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, po.id)).for("update");
    if (po.supplierId !== sup.id) return no(`${po.qmPoNo} is kept for another vendor in the ERP.`);
    if (po.status === "Closed") return no(`${po.qmPoNo} is closed in the ERP — nothing more is received against it.`);
    const lines = await tx.select().from(erpPoLines).where(eq(erpPoLines.poId, po.id));
    if (lines.some((l) => l.rawMaterialId === mat.id)) return no(`${po.qmPoNo} already carries ${mat.name}.`);
  } else if (po) {
    await tx.delete(erpPoLines).where(eq(erpPoLines.poId, po.id));
    await tx
      .update(erpPurchaseOrders)
      .set({ status: "Sent", supplierId: sup.id, godownId: gd.id, deliveryDate: delivery, closedAt: null, closedById: null, closeReason: null, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(erpPurchaseOrders.id, po.id));
  } else {
    const id = erpId("po");
    const stamp = new Date();
    await tx.insert(erpPurchaseOrders).values({
      id,
      poNumber: await numberFor(tx, p.poNo),
      source: "quotation_manager",
      qmPoNo: p.poNo,
      status: "Sent",
      poDate,
      supplierId: sup.id,
      godownId: gd.id,
      deliveryDate: delivery,
      paymentTerms: sup.creditDays ? `${sup.creditDays} days credit` : "As agreed",
      freightPaise: 0,
      remarks: null,
      approvedById: ctx.user.id,
      approvedAt: stamp,
      decisionNote: "No approval needed — bought on the Quotation manager",
      sentAt: stamp,
      sentById: ctx.user.id,
      sentVia: "Quotation manager",
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });
    [po] = await tx.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, id));
  }
  await tx.insert(erpPoLines).values({
    id: erpId("pol"),
    poId: po.id,
    requisitionId: reqId,
    rawMaterialId: mat.id,
    quantity: qty,
    unit,
    ratePaise,
    gstBp,
    sortOrder: await nextSort(tx, po.id),
    quoteRowId: p.rowId,
    quoteColumnId: p.columnId,
    drums: p.drums,
  });
  await refreshPurchaseOrder(tx, po.id);
  return { poId: po.id, label: po.qmPoNo || poLabel(po.poNumber) };
}

/** The live ERP PO line a bought cell made, if any. */
async function quotePoLine(tx: Tx, rowId: string, columnId: string) {
  const rows = (await tx.execute(sql`
    select l.id, l.po_id as "poId", l.requisition_id as "reqId", o.qm_po_no as name
      from erp_po_lines l join erp_purchase_orders o on o.id = l.po_id
     where l.quote_row_id = ${rowId} and l.quote_column_id = ${columnId}
       and o.source = 'quotation_manager' and o.status in (${sql.join(LIVE_PO.map((x) => sql`${x}`), sql`, `)})
     limit 1
  `)) as unknown as { id: string; poId: string; reqId: string; name: string | null }[];
  return rows[0] ?? null;
}

/** A bought cell's drums changed: its PO line says so too. */
export async function syncQuotePoDrums(tx: Tx, rowId: string, columnId: string, drums: number | null): Promise<void> {
  const line = await quotePoLine(tx, rowId, columnId);
  if (line) await tx.update(erpPoLines).set({ drums }).where(eq(erpPoLines.id, line.id));
}

/**
 * A purchase undone or cancelled on the sheet takes its ERP PO line back —
 * refused once goods have been received against it. The PO is cancelled when
 * it has no line left; a requirement this purchase raised is cancelled, one it
 * was put against goes back to waiting for a PO.
 */
export async function withdrawQuotePo(tx: Tx, ctx: ErpContext, rowId: string, columnId: string): Promise<string | null> {
  const line = await quotePoLine(tx, rowId, columnId);
  if (!line) return null;
  await tx.execute(sql`select id from erp_purchase_orders where id = ${line.poId} for update`);
  const received = (await receivedFor(tx, line.id)) ?? 0;
  if (received > 0) refuse(err(`Goods were received against ${line.name ?? "this PO"} — the purchase cannot be undone. Close the PO short on Purchase orders instead.`, "conflict"));
  await tx.delete(erpPoLines).where(eq(erpPoLines.id, line.id));
  const [left] = (await tx.execute(sql`select count(*)::int as n from erp_po_lines where po_id = ${line.poId}`)) as unknown as { n: number }[];
  if (!Number(left?.n))
    await tx
      .update(erpPurchaseOrders)
      .set({ status: "Cancelled", closeReason: "Purchase undone on the Quotation manager", closedAt: new Date(), closedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(erpPurchaseOrders.id, line.poId));
  else await refreshPurchaseOrder(tx, line.poId);
  const [r] = await tx.select({ remarks: erpRequisitions.remarks }).from(erpRequisitions).where(eq(erpRequisitions.id, line.reqId));
  if (r?.remarks === QM_RAISED_REMARK)
    await tx
      .update(erpRequisitions)
      .set({ status: "Cancelled", cancelReason: "Purchase undone on the Quotation manager", updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(erpRequisitions.id, line.reqId));
  else await tx.update(erpRequisitions).set({ status: "Pending", supplierId: null, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpRequisitions.id, line.reqId));
  return line.name;
}

async function receivedFor(tx: Tx, lineId: string): Promise<number | null> {
  const [r] = (await tx.execute(sql`
    select coalesce(sum(q), 0)::float8 as q from (
      select quantity as q from erp_inward where po_line_id = ${lineId}
      union all select quantity from erp_purchases where po_line_id = ${lineId} and source = 'manual'
    ) x
  `)) as unknown as { q: number }[];
  return r ? Number(r.q) : null;
}
