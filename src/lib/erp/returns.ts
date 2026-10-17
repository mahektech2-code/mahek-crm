import "server-only";
import { sql } from "drizzle-orm";
import { orderTraceCode } from "./trace-links";
import { db } from "@/db";
import { orderType } from "./engines/sales";
import { customerReturnLabel, purchaseReturnLabel, returnableQty, returnLitres, reworkLabel } from "./engines/returns";
import { erpLink } from "./registry";
import { rmLots, type Ex } from "./stock";
import { unitEvent } from "./units";

/* ---------------------------------------------------------------------------
 * Material returns, the reads every returns screen, the dashboard and the
 * trace share — so the form that raises a return, the list that shows it and
 * the tile that counts it cannot disagree about what is left to return.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
const q = async <T = Row>(ex: Ex, s: ReturnType<typeof sql>) => (await ex.execute(s)) as unknown as T[];
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/* ================================================================ vendor */

export type ReturnableLot = {
  purchaseId: string;
  lotNo: string;
  prNumber: number;
  purchaseDate: string;
  supplierId: string;
  supplier: string;
  rawMaterialId: string;
  item: string;
  quantity: number;
  unit: string;
  density: number | null;
  ratePaise: number | null;
  gstBp: number;
  billNumber: string | null;
  grn: string | null;
  /** In the PURCHASE unit: what live returns already claim. */
  returned: number;
  /** In the purchase unit: the lot less what live returns claim. */
  returnable: number;
  /** In the stock unit (litres or pieces), across every godown. */
  onShelf: number;
  /** Per godown, in the stock unit — where an outward can take it from. */
  byGodown: { godownId: string; godown: string; stock: number }[];
};

/** Live purchase-return quantity per register lot: everything not rejected or cancelled. */
export async function returnedByPurchase(ex: Ex = db): Promise<Map<string, number>> {
  const rows = await q<{ id: string; n: number }>(ex, sql`
    select purchase_id as id, sum(quantity)::float8 as n from erp_purchase_returns where status in ('pending', 'approved') group by 1`);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

/** Every register lot a return could be raised against, with what is left of it. */
export async function returnableLots(ex: Ex = db): Promise<ReturnableLot[]> {
  const [lots, returned, stock] = await Promise.all([
    q<Row>(ex, sql`
      select p.id, p.lot_no as "lotNo", p.pr_number as "prNumber", p.purchase_date::text as "purchaseDate", p.supplier_id as "supplierId",
             s.name as supplier, p.raw_material_id as "rawMaterialId", m.name as item, p.quantity::float8 as quantity, p.unit,
             p.density::float8 as density, p.rate_paise::float8 as rate, p.gst_bp as "gstBp", p.bill_number as "billNumber",
             i.pr_number as grn
        from erp_purchases p
        join erp_suppliers s on s.id = p.supplier_id
        join erp_raw_materials m on m.id = p.raw_material_id
        left join erp_inward i on i.id = p.inward_id
       order by p.purchase_date desc, p.lot_no`),
    returnedByPurchase(ex),
    rmLots(ex),
  ]);
  const byLot = new Map<string, { godownId: string; godown: string; stock: number }[]>();
  for (const l of stock) byLot.set(l.lotNo, [...(byLot.get(l.lotNo) ?? []), { godownId: l.godownId, godown: l.godown, stock: l.stock }]);
  return lots.map((r) => {
    const gs = (byLot.get(String(r.lotNo)) ?? []).filter((g) => g.stock > 0);
    const ret = returned.get(String(r.id)) ?? 0;
    return {
      purchaseId: String(r.id),
      lotNo: String(r.lotNo),
      prNumber: Number(r.prNumber),
      purchaseDate: String(r.purchaseDate),
      supplierId: String(r.supplierId),
      supplier: String(r.supplier),
      rawMaterialId: String(r.rawMaterialId),
      item: String(r.item),
      quantity: Number(r.quantity),
      unit: String(r.unit),
      density: r.density == null ? null : Number(r.density),
      ratePaise: r.rate == null ? null : Number(r.rate),
      gstBp: Number(r.gstBp ?? 0),
      billNumber: r.billNumber == null ? null : String(r.billNumber),
      grn: r.grn == null ? null : `GRN · PR ${r.grn}`,
      returned: ret,
      returnable: returnableQty(Number(r.quantity), ret),
      onShelf: r3(gs.reduce((a, g) => a + g.stock, 0)),
      byGodown: gs,
    };
  });
}

/** The label a lot goes by on a returns form. */
export const lotOption = (l: Pick<ReturnableLot, "lotNo" | "item" | "supplier" | "prNumber">) => `${l.lotNo} · ${l.item} · ${l.supplier} · PR ${l.prNumber}`;

/* ============================================================== customer */

export type ReturnableLine = {
  batchCodeId: string;
  orderId: string;
  orderNo: number;
  orderDate: string;
  customerId: string;
  customer: string;
  skuId: string;
  sku: string;
  boxType: string | null;
  cansPerBox: number;
  millilitres: number;
  finishedGoodId: string | null;
  formulationId: string | null;
  lotFrom: "fg" | "pack";
  lotCode: string;
  godownId: string;
  godown: string;
  /** Sent on this line from this lot, in its allocation unit. */
  sent: number;
  /** Already on a live customer return. */
  returned: number;
  ratePaise: number | null;
  discountBp: number | null;
  gstBp: number;
  billNo: string | null;
  dispatchDate: string | null;
};

/**
 * Every lot that LEFT on a billed, dispatched order line — the only things a
 * customer can send back, because a return is linked to the invoice and the
 * goods outward it reverses.
 */
export async function returnableLines(ex: Ex = db, where = sql`true`): Promise<ReturnableLine[]> {
  const rows = await q<Row>(ex, sql`
    select b.id as "batchCodeId", o.id as "orderId", o.order_no as "orderNo", o.order_date::text as "orderDate",
           o.billing_customer_id as "customerId", c.name as customer, o.sku_id as "skuId", p.name as sku, pk.box_type as "boxType",
           coalesce(p.cans_per_box, 1) as "cansPerBox", coalesce(fg.millilitres, 0) as millilitres,
           coalesce(b.finished_good_id, p.finished_good_id) as "finishedGoodId", fg.formulation_id as "formulationId",
           b.lot_from as "lotFrom", b.lot_code as "lotCode", b.godown_id as "godownId", g.name as godown,
           b.quantity::float8 as sent, o.rate_paise::float8 as rate, o.discount_bp as "discountBp", d.gst_bp as "gstBp",
           o.tally_bill_no as "billNo", d.dispatch_date::text as "dispatchDate",
           coalesce((select sum(r.quantity) from erp_customer_returns r where r.batch_code_id = b.id and r.status = 'open'), 0)::float8 as returned
      from erp_batch_codes b
      join erp_orders o on o.id = b.order_id
      join erp_order_details d on d.order_id = o.id
      join customers c on c.id = o.billing_customer_id
      join products p on p.id = o.sku_id
      left join erp_product_packing pk on pk.product_id = p.id
      left join finished_goods fg on fg.id = coalesce(b.finished_good_id, p.finished_good_id)
      join erp_godowns g on g.id = b.godown_id
     where d.dispatch_status = 'Dispatched' and ${where}
     order by o.order_no desc, b.lot_code`);
  return rows.map((r) => ({
    batchCodeId: String(r.batchCodeId),
    orderId: String(r.orderId),
    orderNo: Number(r.orderNo),
    orderDate: String(r.orderDate),
    customerId: String(r.customerId),
    customer: String(r.customer),
    skuId: String(r.skuId),
    sku: String(r.sku),
    boxType: r.boxType == null ? null : String(r.boxType),
    cansPerBox: Number(r.cansPerBox) || 1,
    millilitres: Number(r.millilitres) || 0,
    finishedGoodId: r.finishedGoodId == null ? null : String(r.finishedGoodId),
    formulationId: r.formulationId == null ? null : String(r.formulationId),
    lotFrom: r.lotFrom === "pack" ? "pack" : "fg",
    lotCode: String(r.lotCode),
    godownId: String(r.godownId),
    godown: String(r.godown),
    sent: Number(r.sent),
    returned: Number(r.returned),
    ratePaise: r.rate == null ? null : Number(r.rate),
    discountBp: r.discountBp == null ? null : Number(r.discountBp),
    gstBp: Number(r.gstBp ?? 1800),
    billNo: r.billNo == null ? null : String(r.billNo),
    dispatchDate: r.dispatchDate == null ? null : String(r.dispatchDate),
  }));
}

export const lineOption = (l: Pick<ReturnableLine, "orderNo" | "customer" | "sku" | "lotCode">) => `${orderTraceCode(l.orderNo)} · ${l.customer} · ${l.sku} · lot ${l.lotCode}`;

/**
 * The quantity a customer return is VALUED on: the rate is per can, or per
 * litre on a drum line (`billFigures`), so a drum line is valued on litres.
 */
export function valuedQty(line: Pick<ReturnableLine, "boxType" | "lotFrom" | "cansPerBox" | "millilitres">, qty: number): number {
  const litres = returnLitres({ qty, lotFrom: line.lotFrom, cansPerBox: line.cansPerBox, millilitres: line.millilitres });
  if (orderType(line.boxType) === "Drum") return litres;
  return line.lotFrom === "pack" ? qty * line.cansPerBox : qty;
}

/* ========================================================= unit register */

/**
 * The box or labelled can register follows a customer return: units left on
 * the order go `returned` when it is received, and leave that state with QC's
 * decision — back to `available` at the godown it was reused into, or
 * `rejected` when it was reworked, scrapped or wasted. A reversal puts them
 * back to `returned`. Units are picked lowest-numbered first, as a transfer
 * picks them; a lot packed before labels has none, and nothing happens.
 */
export async function moveReturnUnits(
  ex: Ex,
  p: { orderId: string; lotFrom: "fg" | "pack"; lotCode: string; qty: number; from: "dispatched" | "returned" | "available" | "rejected"; to: "returned" | "available" | "rejected" | "dispatched"; godownId?: string | null; note: string; byId: string },
): Promise<number> {
  const n = Math.floor(p.qty + 1e-9);
  if (n <= 0) return 0;
  const rows = await q<{ id: string }>(ex, sql`
    select id from erp_units
     where lot_from = ${p.lotFrom} and lot_code = ${p.lotCode} and order_id = ${p.orderId} and status = ${p.from}
     order by seq limit ${n} for update`);
  const event = p.to === "returned" ? "return" : p.to === "available" ? "release" : p.to === "dispatched" ? "cancel" : "reject";
  for (const r of rows) {
    if (p.godownId) await ex.execute(sql`update erp_units set status = ${p.to}, godown_id = ${p.godownId}, status_note = ${p.note}, updated_at = now() where id = ${r.id}`);
    else await ex.execute(sql`update erp_units set status = ${p.to}, status_note = ${p.note}, updated_at = now() where id = ${r.id}`);
    await unitEvent(ex, { unitId: r.id, event, from: p.from, to: p.to, orderId: p.orderId, godownId: p.godownId ?? null, note: p.note, byId: p.byId });
  }
  return rows.length;
}

/* ============================================================= dashboard */

export type ReturnsSummary = {
  vendor: { total: number; qty: number; debitNotePaise: number; pending: number; completed: number };
  customer: {
    total: number;
    litres: number;
    creditNotePaise: number;
    pendingQc: number;
    reworkedLitres: number;
    recoveredLitres: number;
    scrapKg: number;
    scrapSalesPaise: number;
    wasteLitres: number;
    wasteCostPaise: number;
  };
};

/** The management figures (PRD §19), read live off the documents. */
export async function returnsSummary(ex: Ex = db): Promise<ReturnsSummary> {
  const [[v], [c]] = await Promise.all([
    q<Row>(ex, sql`
      select count(*) filter (where r.status <> 'cancelled')::int as total,
             coalesce(sum(r.stock_qty) filter (where r.status <> 'cancelled' and r.status <> 'rejected'), 0)::float8 as qty,
             coalesce((select sum(total_paise) from erp_debit_notes where status = 'issued'), 0)::float8 as dn,
             count(*) filter (where r.status = 'pending' or (r.status = 'approved' and not exists (
               select 1 from erp_return_outwards o where o.purchase_return_id = r.id and o.status = 'confirmed')))::int as pending,
             count(*) filter (where exists (select 1 from erp_return_outwards o where o.purchase_return_id = r.id and o.status = 'confirmed') and r.status = 'approved')::int as completed
        from erp_purchase_returns r`),
    q<Row>(ex, sql`
      select count(*) filter (where r.status <> 'cancelled')::int as total,
             coalesce(sum(r.litres) filter (where r.status = 'open'), 0)::float8 as litres,
             coalesce((select sum(cn.cn_amount) from erp_customer_returns x join complaints cn on cn.id = x.complaint_id where cn.cn_status = 'issued'), 0)::float8 as cn,
             count(*) filter (where r.status = 'open' and r.received_qty is not null and r.received_qty > coalesce((
               select sum(d.quantity) from erp_return_dispositions d where d.customer_return_id = r.id and d.status = 'active'), 0))::int as "pendingQc",
             coalesce((select sum(input_litres) from erp_rework_orders where status <> 'cancelled'), 0)::float8 as reworked,
             coalesce((select sum(litres) from erp_return_dispositions where kind = 'reuse' and status = 'active'), 0)::float8 +
               coalesce((select sum(output_litres) from erp_rework_orders where status = 'completed'), 0)::float8 as recovered,
             coalesce((select sum(scrap_kg) from erp_return_dispositions where kind = 'scrap' and status = 'active'), 0)::float8 as "scrapKg",
             coalesce((select sum(amount_paise) from erp_scrap_sales where status = 'confirmed' and category = 'Chemical Scrap'), 0)::float8 as "scrapSales",
             coalesce((select sum(litres) from erp_waste_disposals where status <> 'cancelled'), 0)::float8 as waste,
             coalesce((select sum(cost_paise) from erp_waste_disposals where status = 'disposed'), 0)::float8 as "wasteCost"
        from erp_customer_returns r`),
  ]);
  return {
    vendor: { total: Number(v.total), qty: r3(Number(v.qty)), debitNotePaise: Number(v.dn), pending: Number(v.pending), completed: Number(v.completed) },
    customer: {
      total: Number(c.total),
      litres: r3(Number(c.litres)),
      creditNotePaise: Number(c.cn),
      pendingQc: Number(c.pendingQc),
      reworkedLitres: r3(Number(c.reworked)),
      recoveredLitres: r3(Number(c.recovered)),
      scrapKg: r3(Number(c.scrapKg)),
      scrapSalesPaise: Number(c.scrapSales),
      wasteLitres: r3(Number(c.waste)),
      wasteCostPaise: Number(c.wasteCost),
    },
  };
}

/** Live debit notes per supplier and PR — what a purchase payout is reduced by. */
export async function debitNotesByPurchase(ex: Ex = db): Promise<Map<string, number>> {
  const rows = await q<{ supplierId: string; pr: number; total: number }>(ex, sql`
    select supplier_id as "supplierId", pr_number as pr, sum(total_paise)::float8 as total from erp_debit_notes where status = 'issued' group by 1, 2`);
  return new Map(rows.map((r) => [`${r.supplierId}|${r.pr}`, Number(r.total)]));
}

/* ================================================================ trace */

/** A lot's or an order's returns, as rows of the batch trace. */
export async function returnRowsForTrace(kind: string, code: string, ex: Ex = db): Promise<{ text: string; sub?: string; href?: string; tone?: "ok" | "warn" | "bad" }[]> {
  const out: { text: string; sub?: string; href?: string; tone?: "ok" | "warn" | "bad" }[] = [];
  if (kind === "rm") {
    const rows = await q<Row>(ex, sql`
      select r.id, r.return_no as no, r.status, r.quantity::float8 as qty, r.unit, s.name as supplier, r.return_date::text as date,
             (select o.status from erp_return_outwards o where o.purchase_return_id = r.id and o.status <> 'cancelled' limit 1) as outward
        from erp_purchase_returns r join erp_suppliers s on s.id = r.supplier_id
       where r.lot_no = ${code} order by r.created_at`);
    for (const r of rows)
      out.push({
        text: `${purchaseReturnLabel(Number(r.no))} · ${nf3(Number(r.qty))} ${r.unit} back to ${r.supplier}`,
        sub: `${r.date} · ${r.status === "cancelled" ? "cancelled" : r.status === "rejected" ? "rejected" : r.outward === "confirmed" ? "returned, stock reduced" : r.status === "approved" ? "debit note issued, goods not yet sent" : "awaiting approval"}`,
        href: erpLink("vendorReturns", { open: String(r.id) }),
        tone: r.outward === "confirmed" ? "warn" : undefined,
      });
  }
  if (kind === "fg" || kind === "pack" || kind === "order") {
    const where = kind === "order" ? sql`o.order_no = ${Number(code)}` : sql`r.lot_code = ${code} and r.lot_from = ${kind}`;
    const rows = await q<Row>(ex, sql`
      select r.id, r.return_no as no, r.status, r.quantity::float8 as qty, r.unit, c.name as customer, r.lot_code as lot, r.return_date::text as date,
             (select string_agg(d.kind || ' ' || d.quantity::text, ', ') from erp_return_dispositions d where d.customer_return_id = r.id and d.status = 'active') as decided,
             (select w.sfg_lot_code from erp_rework_orders w where w.customer_return_id = r.id and w.status = 'completed' limit 1) as rework
        from erp_customer_returns r join customers c on c.id = r.customer_id join erp_orders o on o.id = r.order_id
       where ${where} order by r.created_at`);
    for (const r of rows)
      out.push({
        text: `${customerReturnLabel(Number(r.no))} · ${nf3(Number(r.qty))} ${String(r.unit).toLowerCase()} from ${r.customer} (lot ${r.lot})`,
        sub: `${r.date} · ${r.status === "cancelled" ? "cancelled" : r.decided ? `QC: ${r.decided}` : "in quarantine"}${r.rework ? ` · reworked into SFG lot ${r.rework}` : ""}`,
        href: erpLink("customerReturns", { open: String(r.id) }),
        tone: r.status === "cancelled" ? undefined : "warn",
      });
  }
  if (kind === "sfg") {
    const rows = await q<Row>(ex, sql`
      select w.id, w.rework_no as no, r.return_no as "returnNo", r.lot_code as lot, w.output_litres::float8 as output
        from erp_rework_orders w join erp_customer_returns r on r.id = w.customer_return_id where w.sfg_lot_code = ${code}`);
    for (const r of rows)
      out.push({ text: `Reworked from ${customerReturnLabel(Number(r.returnNo))} (lot ${r.lot})`, sub: `${reworkLabel(Number(r.no))} · ${nf3(Number(r.output ?? 0))} L recovered`, href: erpLink("reworkOrders", { open: String(r.id) }) });
  }
  return out;
}

const nf3 = (n: number) => String(Math.round(n * 1000) / 1000);
