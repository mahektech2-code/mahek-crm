import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { customers, erpOrders } from "@/db/schema";
import type { ErpContext } from "./access";
import { billingSheets, type BillingLine, type BillingParty, type BillingSheet } from "./billing-view";
import { orderLines, type OrderLine } from "./screens/sales";

/** Past this a pop-up of invoices is not something anybody copies from by hand. */
export const BILLING_VIEW_MAX_LINES = 500;

/**
 * The invoices a selection of order lines makes. One order is one complete bill,
 * so a ticked line brings the rest of its order with it; a cancelled line is not
 * on any bill. Rates and amounts follow the same powers as the list's columns.
 */
export async function billingViewFor(ctx: ErpContext, lineIds: string[]): Promise<BillingSheet[]> {
  const ticked = await db.selectDistinct({ no: erpOrders.orderNo }).from(erpOrders).where(inArray(erpOrders.id, lineIds));
  if (!ticked.length) return [];
  const live = (await orderLines({ orderNos: ticked.map((t) => t.no) })).filter((l) => l.o.status !== "Cancel");
  /* `CustomerRow` carries no address: only an invoice asks for one. */
  const partyIds = [...new Set(live.flatMap((l) => [l.billing.id, l.delivery.id]))];
  const addresses = partyIds.length ? await db.select({ id: customers.id, address: customers.address }).from(customers).where(inArray(customers.id, partyIds)) : [];
  const addressOf = new Map(addresses.map((a) => [a.id, a.address]));
  const party = (c: OrderLine["billing"]): BillingParty => ({ id: c.id, name: c.name, address: addressOf.get(c.id) ?? null, city: c.city, state: c.p?.state ?? null, gstin: c.gstin, phone: c.phone });
  const lines: BillingLine[] = live.map((l) => ({
    orderNo: l.o.orderNo,
    orderDate: l.o.orderDate,
    billing: party(l.billing),
    delivery: party(l.delivery),
    description: l.sku.name,
    type: l.type,
    qtyCans: l.o.qtyCans,
    litresPerCan: l.sku.litresPerCan,
    boxes: l.boxed ? l.boxes : null,
    ratePaise: l.o.ratePaise,
    discountBp: l.o.discountBp,
    transportCostPaise: l.o.transportCostPaise,
    gstBp: l.gstBp,
    invoiceNo: l.o.tallyBillNo,
    invoiceDate: l.o.invoiceDate,
    transporter: l.o.transporter ?? l.delivery.p?.transporter ?? null,
    creditDays: l.billing.creditDays,
  }));
  return billingSheets(lines, { rates: ctx.powers.has("viewSalesRate"), amounts: ctx.powers.has("viewSalesAmounts") });
}
