import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { bills, customers, erpOrders, orders, type OrderLine as BookLine } from "@/db/schema";
import { APP_TIMEZONE } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { recomputeBuyingCycle, recomputeFollowUpState, recomputeOutstanding } from "@/lib/recompute";
import { billFigures, orderType } from "./engines/sales";

/* ---------------------------------------------------------------------------
 * THE ERP'S ORDERS IN MAHEKONE'S ORDER BOOK.
 *
 * MahekOne already had an order book before the ERP existed — `orders` and
 * `bills`, filled from the Taken Order and Order Details sheets — and every
 * number the rest of the suite shows is read off it: targets, the Call Log's
 * reorder dates, outstanding, the buying cycle, the owner's KPIs. An ERP that
 * kept its orders to itself would be a second order book that none of those
 * could see, so once the ERP is where orders are taken (`erp.orders.live`),
 * every ERP order number is written here as ONE `orders` row and, once it is
 * dispatch-verified, ONE `bills` row.
 *
 * The ERP stays the author of the line-level work — lots, readiness, billing,
 * dispatch — and this is a PROJECTION of it, rewritten whole on every change
 * (`syncBookOrders`), so it can never drift into a second opinion. It keys on
 * `ERP-<order no>` and `ERPBILL-<order no>`, never on the sheet's `SHEET-` /
 * `SHEETPAY-` keys: the sheet projection would otherwise overwrite these rows
 * every thirty minutes.
 *
 * Off (the default), nothing here writes: the ERP runs on its own exactly as it
 * did, and orders keep coming from the sheet. The switch is the cut-over — see
 * its description in the registry.
 * ------------------------------------------------------------------------- */

export async function erpOrdersLive(): Promise<boolean> {
  return (await getConfig())["erp.orders.live"] === true;
}

export const bookOrderRef = (orderNo: number) => `ERP-${orderNo}`;
export const bookBillRef = (orderNo: number) => `ERPBILL-${orderNo}`;

/** Where a consignment's material stage puts the order (spec §12 stages). */
export function bookStatusForStage(stage: string | null): "dispatched" | "in_transit" | "delivered" {
  if (!stage) return "dispatched";
  if (stage === "Close - Received to Party") return "delivered";
  if (stage === "Dispatched" || stage.startsWith("Dispatch from")) return "dispatched";
  return "in_transit";
}

type LineRow = {
  id: string;
  orderNo: number;
  orderDate: string;
  billing: string;
  delivery: string;
  status: string;
  partyStatus: string | null;
  qtyCans: number;
  ratePaise: number | null;
  discountBp: number | null;
  transportCostPaise: number;
  tallyBillNo: string | null;
  dispatchOn: string | null;
  createdById: string | null;
  sku: string;
  litresPerCan: number;
  boxType: string | null;
  gstBp: number | null;
  verification: string | null;
  dispatchDate: string | null;
  stage: string | null;
};

/** The whole-order status an order number's lines add up to. */
export function bookStatus(
  lines: { status: string; partyStatus: string | null; verification: string | null }[],
  stage: string | null,
  decided: { approvedAt: Date | null; status: string } | null,
): "pending_approval" | "confirmed" | "dispatched" | "in_transit" | "delivered" | "cancelled" | "declined" {
  /* Accounts said no. Nothing the godown does afterwards turns that into a sale. */
  if (decided?.status === "declined") return "declined";
  const live = lines.filter((l) => l.status !== "Cancel");
  if (!live.length) return "cancelled";
  if (live.some((l) => l.partyStatus === "Pending") && !decided?.approvedAt) return "pending_approval";
  if (live.every((l) => l.verification === "Verified")) return bookStatusForStage(stage);
  return "confirmed";
}

async function linesOf(orderNos: number[]): Promise<LineRow[]> {
  const rows = (await db.execute(sql`
    select o.id, o.order_no as "orderNo", o.order_date::text as "orderDate",
           o.billing_customer_id as billing, o.delivery_customer_id as delivery,
           o.status, o.party_status as "partyStatus", o.qty_cans as "qtyCans",
           o.rate_paise as "ratePaise", o.discount_bp as "discountBp",
           o.transport_cost_paise as "transportCostPaise", o.tally_bill_no as "tallyBillNo",
           o.dispatch_on::text as "dispatchOn", o.created_by_id as "createdById",
           p.name as sku,
           coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000 as "litresPerCan",
           pk.box_type as "boxType",
           d.gst_bp as "gstBp", d.verification, d.dispatch_date::text as "dispatchDate",
           t.material_stage as stage
      from erp_orders o
      join products p on p.id = o.sku_id
      left join finished_goods fg on fg.id = p.finished_good_id
      left join erp_product_packing pk on pk.product_id = p.id
      left join erp_order_details d on d.order_id = o.id
      left join erp_transports t on t.order_no = o.order_no
     where o.order_no in ${orderNos}
     order by o.order_no, o.created_at
  `)) as unknown as LineRow[];
  /* db.execute hands numbers back as text where Postgres says bigint. */
  return rows.map((r) => ({
    ...r,
    orderNo: Number(r.orderNo),
    qtyCans: Number(r.qtyCans),
    ratePaise: r.ratePaise == null ? null : Number(r.ratePaise),
    discountBp: r.discountBp == null ? null : Number(r.discountBp),
    transportCostPaise: Number(r.transportCostPaise ?? 0),
    litresPerCan: Number(r.litresPerCan ?? 0),
    gstBp: r.gstBp == null ? null : Number(r.gstBp),
  }));
}

/** A line's value in the book: the billed figure with GST, and the figure before it. */
function lineValue(l: LineRow) {
  const f = billFigures({
    type: orderType(l.boxType),
    qtyCans: l.qtyCans,
    litresPerCan: l.litresPerCan,
    ratePaise: l.ratePaise,
    discountBp: l.discountBp,
    transportCostPaise: l.transportCostPaise,
    gstBp: l.gstBp ?? 1800,
  });
  return { gross: f.finalPaise ?? 0, net: f.amountPaise == null ? 0 : f.amountPaise - (f.discountedPaise ?? 0) };
}

/**
 * A bill number nobody else holds. `bills.bill_no` is unique across the table,
 * and a Tally number can already be on a bill the sheet wrote — so it falls
 * back to `<tally>/ERP<n>`, then `ERP-<n>`, exactly the chain the sheet uses.
 */
async function freeBillNo(tally: string | null, orderNo: number, mine: string | null): Promise<string> {
  for (const candidate of [tally, tally ? `${tally}/ERP${orderNo}` : null, `ERP-${orderNo}`]) {
    if (!candidate) continue;
    const [held] = await db
      .select({ id: bills.id })
      .from(bills)
      .where(mine ? and(eq(bills.billNo, candidate), ne(bills.id, mine)) : eq(bills.billNo, candidate))
      .limit(1);
    if (!held) return candidate;
  }
  return `ERP-${orderNo}-${randomUUID().slice(0, 4)}`;
}

async function syncOne(orderNo: number, lines: LineRow[]): Promise<string[]> {
  const ref = bookOrderRef(orderNo);
  const [existing] = await db
    .select({ id: orders.id, status: orders.status, approvedAt: orders.approvedAt, customerId: orders.customerId })
    .from(orders)
    .where(eq(orders.externalRef, ref));
  const [bill] = await db
    .select({ id: bills.id, paid: bills.paidAmount, customerId: bills.customerId })
    .from(bills)
    .where(eq(bills.externalRef, bookBillRef(orderNo)));

  /* Every line gone: the order is kept as cancelled — it was on somebody's
     list — and an unpaid bill goes with the lines that made it. */
  if (!lines.length) {
    if (existing && existing.status !== "cancelled") await db.update(orders).set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() }).where(eq(orders.id, existing.id));
    if (bill && !Number(bill.paid)) await db.delete(bills).where(eq(bills.id, bill.id));
    return [existing?.customerId, bill?.customerId].filter((x): x is string => !!x);
  }

  const head = lines[0];
  const live = lines.filter((l) => l.status !== "Cancel");
  const status = bookStatus(lines, head.stage, existing ?? null);
  const items: BookLine[] = live.map((l) => {
    const v = lineValue(l);
    return { product: l.sku, quantity: l.qtyCans, unitPrice: l.ratePaise ?? 0, amount: v.gross, netAmount: v.net };
  });
  const planned = live.map((l) => l.dispatchOn).filter((d): d is string => !!d).sort();
  const [party] = await db.select({ creditDays: customers.creditDays }).from(customers).where(eq(customers.id, head.billing));
  const values = {
    customerId: head.billing,
    deliveryCustomerId: head.delivery !== head.billing ? head.delivery : null,
    userId: head.createdById,
    source: "erp" as const,
    externalRef: ref,
    orderNo: ref,
    orderedAt: sql`(${head.orderDate}::date + time '10:00') at time zone ${APP_TIMEZONE}`,
    totalAmount: items.reduce((n, i) => n + i.amount, 0),
    netAmountPaise: items.reduce((n, i) => n + (i.netAmount ?? 0), 0),
    lineItems: items,
    creditDays: party?.creditDays ?? null,
    expectedDispatch: planned[0] ?? null,
    status,
    cancelledAt: status === "cancelled" ? new Date() : null,
    updatedAt: new Date(),
  };
  let orderId = existing?.id;
  if (existing) await db.update(orders).set(values).where(eq(orders.id, existing.id));
  else {
    orderId = `ord_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await db.insert(orders).values({ id: orderId, ...values, createdById: head.createdById });
  }

  /* THE BILL, once a line has left. A bill is a real invoice the business
     raised, so it is `stated` — owed until money is recorded against it, and on
     the collections list like any other — unlike a sheet bill, which nobody
     has vouched for either way. */
  const sent = live.filter((l) => l.verification === "Verified");
  if (sent.length) {
    const billNo = await freeBillNo(sent[0].tallyBillNo, orderNo, bill?.id ?? null);
    const billDate = sent.map((l) => l.dispatchDate ?? l.orderDate).sort()[0];
    const amount = sent.reduce((n, l) => n + lineValue(l).gross, 0);
    if (bill) await db.update(bills).set({ customerId: head.billing, billNo, orderId, billDate, amount, updatedAt: new Date() }).where(eq(bills.id, bill.id));
    else
      await db.insert(bills).values({
        id: `bil_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        customerId: head.billing,
        billNo,
        orderId,
        billDate,
        amount,
        paymentPosition: "stated",
        externalRef: bookBillRef(orderNo),
      });
  } else if (bill && !Number(bill.paid)) {
    await db.delete(bills).where(eq(bills.id, bill.id));
  }
  return [head.billing, head.delivery, existing?.customerId, bill?.customerId].filter((x): x is string => !!x);
}

/**
 * Rewrites the book's copy of these ERP order numbers, whole, and rebuilds the
 * caches that read it for every customer they touched. Called after every
 * write that can change an order's lines, status, value or dispatch.
 */
export async function syncBookOrders(orderNos: number[]): Promise<void> {
  if (!orderNos.length || !(await erpOrdersLive())) return;
  const unique = [...new Set(orderNos)];
  const all = await linesOf(unique);
  const touched = new Set<string>();
  for (const n of unique) for (const c of await syncOne(n, all.filter((l) => l.orderNo === n))) touched.add(c);
  for (const c of touched) {
    await recomputeBuyingCycle(c);
    await recomputeOutstanding(c);
    await recomputeFollowUpState(c);
  }
}

/** The order numbers behind a set of ERP order-line ids. */
export async function orderNosOf(lineIds: string[]): Promise<number[]> {
  if (!lineIds.length) return [];
  const rows = await db.select({ n: erpOrders.orderNo }).from(erpOrders).where(inArray(erpOrders.id, lineIds));
  return [...new Set(rows.map((r) => Number(r.n)))];
}

/** Rebuilds every ERP order in the book — the job to run the day the switch is turned on. */
export async function syncAllBookOrders(): Promise<number> {
  if (!(await erpOrdersLive())) return 0;
  const rows = (await db.execute(sql`select distinct order_no as n from erp_orders`)) as unknown as { n: number }[];
  const nos = rows.map((r) => Number(r.n));
  for (let i = 0; i < nos.length; i += 200) await syncBookOrders(nos.slice(i, i + 200));
  return nos.length;
}

/**
 * ACCOUNTS DECIDED AN ERP ORDER. The Pending-customer check was the ERP's own
 * "Approved By Admin" in Mahek Plus; with the ERP live it is the ordinary
 * Accounts approval, and the ERP lines learn the answer here: approved, and
 * they can be billed; declined, and they are cancelled with the reason, so
 * the godown does not allocate stock to a sale that will never happen.
 */
export async function afterBookDecision(orderId: string): Promise<void> {
  const [o] = await db
    .select({ ref: orders.externalRef, source: orders.source, status: orders.status, reason: orders.declineReason })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!o || o.source !== "erp" || !o.ref?.startsWith("ERP-")) return;
  const orderNo = Number(o.ref.slice(4));
  if (!Number.isInteger(orderNo)) return;
  if (o.status === "declined") {
    await db
      .update(erpOrders)
      .set({ partyStatus: "Declined", status: "Cancel", remark: sql`trim(both ' ' from coalesce(${erpOrders.remark}, '') || ' · Declined by Accounts: ' || ${o.reason ?? ""})`, updatedAt: new Date() })
      .where(and(eq(erpOrders.orderNo, orderNo), eq(erpOrders.partyStatus, "Pending")));
  } else {
    await db
      .update(erpOrders)
      .set({ partyStatus: "Approved By Admin", updatedAt: new Date() })
      .where(and(eq(erpOrders.orderNo, orderNo), eq(erpOrders.partyStatus, "Pending")));
  }
}

/**
 * WHO THE CALL LOG HOLDS BACK, from the ERP's own open orders.
 *
 * With the ERP live the Taken Order sheet is no longer where an order lands
 * first, so the hold the sheet used to drive has to come from here: a customer
 * is held while any ERP order line billed to them is still open — not
 * cancelled and not yet dispatch-verified — and released when the last one
 * leaves. A full reconcile, like the sheet's: every customer is written, so a
 * hold can only ever say what the ERP currently says.
 */
export async function recomputeErpOrderHolds(): Promise<{ held: number; newlyHeld: number; released: number; unmatched: number }> {
  const rows = (await db.execute(sql`
    with open as (
      select distinct o.billing_customer_id as id
        from erp_orders o
        left join erp_order_details d on d.order_id = o.id
       where o.status <> 'Cancel'
         and coalesce(d.verification, '') <> 'Verified'
    ),
    changed as (
      update customers c
         set active_in_order_system = (c.id in (select id from open))
       where c.active_in_order_system is distinct from (c.id in (select id from open))
      returning c.active_in_order_system as now
    )
    select (select count(*) from open)::int as held,
           (select count(*) from changed where now)::int as "newlyHeld",
           (select count(*) from changed where not now)::int as released
  `)) as unknown as { held: number; newlyHeld: number; released: number }[];
  const r = rows[0] ?? { held: 0, newlyHeld: 0, released: 0 };
  return { held: Number(r.held), newlyHeld: Number(r.newlyHeld), released: Number(r.released), unmatched: 0 };
}
