import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpGodowns, erpPurchaseOrders, erpRawMaterials, erpRequisitions, erpSuppliers, products } from "@/db/schema";
import { ErpNotPermitted } from "@/lib/erp/access";
import { requirementVisibleTo } from "@/lib/erp/departments";
import { LIVE_PO, poName, requirementLabel } from "@/lib/erp/engines/purchase-flow";
import { nf } from "@/lib/erp/ui";
import { stampDate } from "@/lib/format";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present } from "./erp-common";

/* ---------------------------------------------------------------------------
 * A REQUIREMENT AND ITS PURCHASE ORDER MOVE TOGETHER. Cancelling a PO sends
 * every requirement on it back to waiting; unlinking one takes a line off a PO
 * and can cancel the PO with it; closing one short says its requirements are
 * received when part of them never came. None of that is on the row somebody
 * pressed, and the vendor and the Quotation manager hear nothing of it.
 *
 * A requirement belongs to a department, and the acts refuse one from another
 * department in the same words — so does the modal, or it would be a way to
 * read another department's purchases.
 * ------------------------------------------------------------------------- */

const liveStatuses = sql.join(LIVE_PO.map((s) => sql`${s}`), sql`, `);

/** The screen's own permission, and the department rule the requirement acts apply. */
async function mayTouchRequirement(id: string) {
  const ctx = await erpMayDelete(["requisitions"]);
  const [r] = await db.select({ department: erpRequisitions.department, by: erpRequisitions.createdById }).from(erpRequisitions).where(eq(erpRequisitions.id, id));
  if (r && !requirementVisibleTo(ctx.department, r.department, r.by === ctx.user.id)) throw new ErpNotPermitted("That requirement belongs to another department.");
}

async function requirement(id: string) {
  const [x] = await db
    .select({ r: erpRequisitions, item: sql<string>`coalesce(${erpRawMaterials.name}, ${products.name})`, godown: erpGodowns.name })
    .from(erpRequisitions)
    .innerJoin(erpGodowns, eq(erpGodowns.id, erpRequisitions.godownId))
    .leftJoin(erpRawMaterials, eq(erpRawMaterials.id, erpRequisitions.rawMaterialId))
    .leftJoin(products, eq(products.id, erpRequisitions.productId))
    .where(eq(erpRequisitions.id, id));
  return x ?? null;
}

type LivePo = { poId: string; lineId: string; name: string; source: string; status: string; qty: number; unit: string; received: number; others: number; quoteRowId: string | null; quoteColumnId: string | null };

/** The live PO line a requirement sits on — the newest, as the requirement's own view reads it. */
async function livePoOf(reqId: string): Promise<LivePo | null> {
  const [l] = (await db.execute(sql`
    select o.id as "poId", l.id as "lineId", o.po_number as "poNumber", o.qm_po_no as "qmPoNo", o.source, o.status,
           l.quantity::float8 as qty, l.unit, l.quote_row_id as "quoteRowId", l.quote_column_id as "quoteColumnId",
           (select count(*)::int from erp_po_lines x where x.po_id = o.id and x.id <> l.id) as others,
           (select coalesce(sum(i.quantity), 0)::float8 from erp_inward i where i.po_line_id = l.id)
             + (select coalesce(sum(p.quantity), 0)::float8 from erp_purchases p where p.po_line_id = l.id and p.source = 'manual') as received
      from erp_po_lines l join erp_purchase_orders o on o.id = l.po_id
     where l.requisition_id = ${reqId} and o.status in (${liveStatuses})
     order by o.created_at desc
     limit 1
  `)) as unknown as (Omit<LivePo, "name"> & { poNumber: number; qmPoNo: string | null })[];
  return l ? { ...l, name: poName({ poNumber: Number(l.poNumber), qmPoNo: l.qmPoNo }), received: Number(l.received), others: Number(l.others) } : null;
}

/* ======================================================= cancel a requirement */

export const requirementCancelImpact: ImpactSource = {
  authorize: mayTouchRequirement,

  async report(id) {
    const x = await requirement(id);
    if (!x) return null;
    const r = x.r;
    const label = r.reqNo ? requirementLabel(r.reqNo) : "this requirement";
    const [po, [held]] = await Promise.all([
      livePoOf(id),
      db.execute(sql`
        select (select count(*)::int from erp_stock_counts where requisition_id = ${id} and status = 'open') as counts,
               (select count(*)::int from erp_quotations where requisition_id = ${id}) as quotes
      `) as unknown as Promise<{ counts: number; quotes: number }[]>,
    ]);
    /* In the act's own order, in its own words. */
    const blockers: string[] = [];
    if (r.status === "Cancelled") blockers.push("Already cancelled.");
    else if (po) blockers.push(`It is on ${po.name} — cancel or send back the PO first.`);
    else if (r.status === "Received") blockers.push("It has been received.");
    const counts = Number(held?.counts ?? 0);
    const quotes = Number(held?.quotes ?? 0);
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `requirement ${label} marked cancelled — it leaves the purchase work lists`,
        effect: "changed",
        count: 1,
        note: `${nf(r.requiredQty)} ${r.unit} of ${x.item} for ${x.godown}.`,
      },
      {
        app: "ERP",
        label: `open blind ${many(counts, "count")} opened before buying it`,
        effect: "kept",
        count: counts,
        note: "It stays on Stock accuracy → To count: what the shelf holds is still worth knowing. Cancel it there if it is not.",
      },
      {
        app: "ERP",
        label: `vendor ${many(quotes, "quotation")} on it`,
        effect: "kept",
        count: quotes,
      },
    ];
    return {
      title: `${r.reqNo ? `${label} · ` : ""}${x.item}`,
      verb: "Cancel requirement",
      confirmWord: r.reqNo ? requirementLabel(r.reqNo) : "CANCEL",
      items: present(items),
      blockers,
    };
  },
};

/* ================================================ unlink a requirement's PO */

export const requirementUnlinkImpact: ImpactSource = {
  authorize: mayTouchRequirement,

  async report(id) {
    const x = await requirement(id);
    if (!x) return null;
    const label = x.r.reqNo ? requirementLabel(x.r.reqNo) : "the requirement";
    const po = await livePoOf(id);
    if (!po) return { title: label, verb: "Unlink", confirmWord: "UNLINK", items: [], blockers: ["It is not on a PO."] };
    const blockers: string[] = [];
    if (po.source !== "quotation_manager") blockers.push(`${po.name} was created here — cancel it on Purchase orders.`);
    else if (po.received > 0) blockers.push(`Goods were received against ${po.name} — it cannot be unlinked.`);
    const [cell] = po.quoteRowId && po.quoteColumnId
      ? ((await db.execute(sql`
          select c.status from erp_quote_cells c join erp_quote_rows r on r.id = c.row_id and r.deleted_at is null
           where c.row_id = ${po.quoteRowId} and c.column_id = ${po.quoteColumnId}
        `)) as unknown as { status: string | null }[])
      : [];
    const items: ImpactItem[] = [
      { app: "ERP", label: `line for ${x.item} on ${po.name}`, effect: "deleted", count: 1, note: `${nf(po.qty)} ${po.unit}, nothing received yet.` },
      po.others
        ? { app: "ERP", label: `purchase order ${po.name} rewritten without it`, effect: "changed", count: 1, note: `Its ${nf(po.others)} other ${many(po.others, "line")} stay.` }
        : { app: "ERP", label: `purchase order ${po.name} cancelled — this was its only line`, effect: "changed", count: 1 },
      { app: "ERP", label: `requirement ${label} goes back to waiting for a PO, with no vendor`, effect: "changed", count: 1 },
      {
        app: "ERP",
        label: `rate bought on the Quotation manager under ${po.name}`,
        effect: "kept",
        count: cell?.status === "po" ? 1 : 0,
        note: "It stays bought on the sheet. Link the right PO number here, or undo the purchase there if it is not being bought.",
      },
    ];
    return { title: `${po.name} on ${label}`, verb: "Unlink", confirmWord: po.name, items: present(items), blockers };
  },
};

/* ================================================== cancel or close a PO */

type PoLine = { item: string; qty: number; unit: string; reqNo: number | null; reqStatus: string; received: number };

async function purchaseOrder(id: string) {
  const [x] = await db
    .select({ po: erpPurchaseOrders, vendor: erpSuppliers.name })
    .from(erpPurchaseOrders)
    .innerJoin(erpSuppliers, eq(erpSuppliers.id, erpPurchaseOrders.supplierId))
    .where(eq(erpPurchaseOrders.id, id));
  if (!x) return null;
  const lines = (await db.execute(sql`
    select m.name as item, l.quantity::float8 as qty, l.unit, q.req_no as "reqNo", q.status as "reqStatus",
           (select coalesce(sum(i.quantity), 0)::float8 from erp_inward i where i.po_line_id = l.id)
             + (select coalesce(sum(p.quantity), 0)::float8 from erp_purchases p where p.po_line_id = l.id and p.source = 'manual') as received
      from erp_po_lines l
      join erp_raw_materials m on m.id = l.raw_material_id
      join erp_requisitions q on q.id = l.requisition_id
     where l.po_id = ${id}
     order by l.sort_order
  `)) as unknown as PoLine[];
  return { ...x, name: poName(x.po), lines: lines.map((l) => ({ ...l, qty: Number(l.qty), received: Number(l.received) })) };
}

const reqWords = (l: PoLine) => `${l.reqNo ? `${requirementLabel(Number(l.reqNo))} · ` : ""}${l.item}`;

export const poCancelImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["purchaseOrders"]);
  },

  async report(id) {
    const x = await purchaseOrder(id);
    if (!x) return null;
    const po = x.po;
    const blockers: string[] = [];
    if (!["Pending approval", "Approved", "Sent"].includes(po.status)) blockers.push(`${x.name} is ${po.status}.`);
    else if (x.lines.some((l) => l.received > 0)) blockers.push("Goods were received against it — close it short instead.");
    const back = x.lines.filter((l) => l.reqStatus !== "Cancelled");
    const [bought] = po.qmPoNo
      ? ((await db.execute(sql`
          select count(*)::int as n from erp_quote_cells c join erp_quote_rows r on r.id = c.row_id and r.deleted_at is null
           where c.status = 'po' and upper(trim(c.po_no)) = upper(trim(${po.qmPoNo}))
        `)) as unknown as { n: number }[])
      : [{ n: 0 }];
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `purchase order ${x.name} cancelled`,
        effect: "changed",
        count: 1,
        note: po.sentAt
          ? `It went to ${x.vendor}${po.sentVia && po.sentVia !== "Quotation manager" ? ` by ${po.sentVia}` : ""} on ${stampDate(po.sentAt)}. Nothing tells them it is off — tell them.`
          : `${x.vendor} was never sent it.`,
      },
      {
        app: "ERP",
        label: `${many(back.length, "requirement")} go back to waiting for a PO, keeping their vendor`,
        effect: "changed",
        count: back.length,
        examples: back.slice(0, 5).map(reqWords),
      },
      {
        app: "ERP",
        label: `${many(Number(bought?.n ?? 0), "rate")} still marked bought on the Quotation manager under ${po.qmPoNo ?? x.name}`,
        effect: "kept",
        count: Number(bought?.n ?? 0),
        note: "The sheet is not changed. Undo the purchase there if the rate is not being bought.",
      },
    ];
    return { title: `${x.name} · ${x.vendor}`, verb: "Cancel PO", confirmWord: x.name, items: present(items), blockers };
  },
};

export const poCloseImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["purchaseOrders"]);
  },

  async report(id) {
    const x = await purchaseOrder(id);
    if (!x) return null;
    const blockers = x.po.status === "Partly received" ? [] : ["Only a partly received PO is closed short — cancel one that has received nothing."];
    const short = x.lines.filter((l) => l.received < l.qty - 1e-9);
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `purchase order ${x.name} closed — nothing more is expected from ${x.vendor}`,
        effect: "changed",
        count: 1,
        examples: short.slice(0, 5).map((l) => `${l.item} · ${nf(l.received)} of ${nf(l.qty)} ${l.unit}`),
        note: short.length ? `${short.length} ${many(short.length, "line")} came short; what never arrived is not ordered again by anything.` : undefined,
      },
      {
        app: "ERP",
        label: `${many(x.lines.length, "requirement")} count as received, short or not`,
        effect: "changed",
        count: x.lines.length,
        examples: x.lines.slice(0, 5).map(reqWords),
        note: "Raise a new requirement for whatever is still needed.",
      },
    ];
    return { title: `${x.name} · ${x.vendor}`, verb: "Close short", confirmWord: x.name, items: present(items), blockers };
  },
};
