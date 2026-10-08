import "server-only";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { calls, customers, erpProductPacking, products } from "@/db/schema";
import { assertCustomerInScope } from "../access-control";
import { fgLots, packLots } from "../erp/stock";
import { openBillsFor } from "./receipt-service";
import type { CallContextSnapshot } from "../call-detail";

/* ---------------------------------------------------------------------------
 * WHAT THE CALL PANEL IS TOLD ABOUT THE ERP, and what the call keeps of it.
 *
 * Three questions are asked on an inbound call that the ERP can already
 * answer: where is their goods, is it in stock, and what do they owe. Every
 * answer here is READ-ONLY — nothing in this file writes to an ERP table,
 * reserves stock or touches a balance — and every read is wrapped so that the
 * ERP being slow, empty or broken costs the telecaller a sentence and never the
 * call: the panel draws "could not be read" and the save goes ahead.
 *
 * The same functions serve the live panel (through `/api/call-context`) and the
 * snapshot written at save, so what the telecaller saw and what the record
 * keeps are one reading. The snapshot is taken by the SERVER from the id the
 * panel names — never from figures the browser sends back — because a record of
 * what the ERP said that the browser can edit is not a record.
 * ------------------------------------------------------------------------- */

export async function scopedCustomer(customerId: string) {
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) throw new Error("not_found");
  await assertCustomerInScope(customer);
  return customer;
}

/* ---------------------------------------------------------------- delivery */

export type DeliveryOrder = NonNullable<CallContextSnapshot["delivery"]> & {
  orderDate: string | null;
  lines: number;
};

/**
 * The orders this customer is on, as the ERP holds them — billed to them or
 * delivered to them, because a distributor's call is as often about the shop
 * the goods went to as about their own bill.
 *
 * ONE ROW PER ORDER NUMBER, not per line: a bill is what a customer quotes, and
 * the ERP writes a line per product. `dispatchedOn` is the day dispatch was
 * RECORDED and `plannedDispatch` the day the line was planned to leave — the
 * two are never merged, because "it left Tuesday" and "it is due to leave
 * Tuesday" are opposite answers to "where is my order". There is NO expected
 * delivery date in the ERP, so none is offered: an invented one would be told
 * to a customer as a promise.
 */
export async function deliveryOrdersFor(
  customerId: string,
  opts: { orderNo?: number; limit?: number } = {},
): Promise<DeliveryOrder[]> {
  await scopedCustomer(customerId);
  const limit = opts.limit ?? 8;
  const only = opts.orderNo != null ? sql`and o.order_no = ${opts.orderNo}` : sql``;
  const rows = await db.execute<{
    orderNo: number;
    orderDate: string | null;
    billNo: string | null;
    transporter: string | null;
    lrNo: string | null;
    plannedDispatch: string | null;
    dispatchedOn: string | null;
    stage: string | null;
    status: string | null;
    lines: number;
  }>(sql`
    select o.order_no as "orderNo",
           min(o.order_date)::text as "orderDate",
           coalesce(max(t.bill_no), max(o.tally_bill_no)) as "billNo",
           coalesce(max(t.transporter), max(o.transporter)) as "transporter",
           max(t.lr_no) as "lrNo",
           min(o.dispatch_on)::text as "plannedDispatch",
           max(d.dispatch_date)::text as "dispatchedOn",
           max(t.material_stage) as "stage",
           string_agg(distinct o.status, ', ') as "status",
           count(*)::int as "lines"
      from erp_orders o
      left join erp_order_details d on d.order_id = o.id
      left join erp_transports t on t.order_no = o.order_no
     where (o.billing_customer_id = ${customerId} or o.delivery_customer_id = ${customerId})
       ${only}
     group by o.order_no
     order by min(o.order_date) desc, o.order_no desc
     limit ${limit}
  `);
  return rows.map((r) => ({
    orderNo: Number(r.orderNo),
    orderDate: r.orderDate,
    billNo: r.billNo,
    transporter: r.transporter,
    lrNo: r.lrNo,
    plannedDispatch: r.plannedDispatch,
    dispatchedOn: r.dispatchedOn,
    stage: r.stage,
    status: r.status,
    lines: Number(r.lines),
  }));
}

/* ------------------------------------------------------------------- stock */

export type StockReading = NonNullable<CallContextSnapshot["stock"]>;

/**
 * What the ERP's stock ledgers say is available for one SKU.
 *
 * The ERP's own rule, restated nowhere: a boxed SKU (empty boxes required) is
 * counted in BOXES from packing stock, a loose one in CANS from finished-goods
 * stock — `fgLevelAvailable`'s own split, read from `fgLots` / `packLots`
 * because those are what it is built from and they carry the godown name. Lot
 * stock is already net of what order allocations took, so this is "available",
 * not "on the shelf".
 *
 * An INDICATION and nothing more. It does not reserve, and it is not a
 * promise: the figure was true when the ledgers were read.
 */
export async function stockForSku(skuId: string): Promise<StockReading> {
  try {
    const [sku] = await db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(eq(products.id, skuId));
    if (!sku) return { unavailable: true };
    const [packing] = await db
      .select({ boxes: erpProductPacking.emptyBoxesRequired })
      .from(erpProductPacking)
      .where(eq(erpProductPacking.productId, skuId));
    const boxed = (packing?.boxes ?? 0) > 0;

    const lots = boxed
      ? (await packLots()).filter((l) => l.skuId === skuId)
      : (await fgLots()).filter((l) => l.skuId === skuId);

    const byGodown = new Map<string, number>();
    for (const l of lots) {
      if (l.stock > 0) byGodown.set(l.godown, (byGodown.get(l.godown) ?? 0) + l.stock);
    }
    const list = [...byGodown.entries()]
      .map(([godown, stock]) => ({ godown, stock: Math.round(stock * 1000) / 1000 }))
      .sort((a, b) => b.stock - a.stock);
    return {
      sku: sku.name,
      unit: boxed ? "boxes" : "cans",
      total: Math.round(list.reduce((s, g) => s + g.stock, 0) * 1000) / 1000,
      byGodown: list,
    };
  } catch {
    /* The ERP failing must never cost anybody a call. */
    return { unavailable: true };
  }
}

/* ----------------------------------------------------------------- payment */

/**
 * The ledger as the telecaller was reading it. The live card on the panel is
 * unchanged and stays the source of truth; this is the copy the record keeps,
 * because by next quarter the balance will have moved and a call that says
 * "asked about money" with no figure beside it is unreadable.
 */
export async function paymentSnapshotFor(
  customerId: string,
): Promise<NonNullable<CallContextSnapshot["payment"]> | null> {
  try {
    const customer = await scopedCustomer(customerId);
    const open = await openBillsFor(customerId);
    return {
      outstandingPaise: Number(customer.outstanding ?? 0),
      billCount: open.length,
      bills: open.slice(0, 5).map((b) => ({
        billNo: b.billNo,
        balancePaise: Number(b.balance),
        dueDate: b.dueDate ?? null,
      })),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ the snapshot */

/**
 * Everything the reason has to snapshot, read at save. Each part is attempted
 * on its own: a failure drops that part and nothing else, and the whole thing
 * is null where the reason has nothing to keep.
 */
export async function snapshotFor(args: {
  customerId: string;
  reason: string | null | undefined;
  reasonDetail: Record<string, string>;
}): Promise<CallContextSnapshot | null> {
  const snap: CallContextSnapshot = {};
  if (args.reason === "payment_outstanding") {
    const p = await paymentSnapshotFor(args.customerId);
    if (p) snap.payment = p;
  }
  if (args.reason === "delivery_transport") {
    const no = Number(args.reasonDetail.erpOrderNo);
    if (Number.isInteger(no) && no > 0) {
      try {
        const [o] = await deliveryOrdersFor(args.customerId, { orderNo: no, limit: 1 });
        if (o) {
          snap.delivery = {
            orderNo: o.orderNo,
            billNo: o.billNo,
            transporter: o.transporter,
            lrNo: o.lrNo,
            plannedDispatch: o.plannedDispatch,
            dispatchedOn: o.dispatchedOn,
            stage: o.stage,
            status: o.status,
          };
        }
      } catch {
        /* not read — see above */
      }
    }
  }
  if (args.reason === "stock_availability" && args.reasonDetail.skuId) {
    snap.stock = await stockForSku(args.reasonDetail.skuId);
  }
  if (!Object.keys(snap).length) return null;
  snap.takenAt = new Date().toISOString();
  return snap;
}

/* ------------------------------------------------------------ who may have rung */

export type CallerSuggestion = {
  role: string | null;
  name: string | null;
  /** Where the suggestion came from, in words the panel prints beside it. */
  source: "record" | "earlier_calls";
  /** How many earlier calls named this person. 0 for the record's own. */
  calls: number;
};

/**
 * WHO IS LIKELY TO HAVE RUNG — a SUGGESTION, never an answer.
 *
 * There is no contact master and this does not pretend to be one. It reads two
 * things that already exist: the person this account lists as its contact
 * (`customers.contact_person`, whoever last answered the phone) and the people
 * earlier inbound calls on this account recorded as having rung, most frequent
 * first. A phone number cannot say who is holding the handset, so the panel
 * offers these as one-tap chips and the telecaller still decides — a silent
 * auto-fill would put "Purchase Person" on the record of a call from the
 * owner, and the role is the one answer that changes what the call is worth.
 */
export async function callerSuggestionsFor(customerId: string): Promise<CallerSuggestion[]> {
  const customer = await scopedCustomer(customerId);
  const rows = await db
    .select({
      role: calls.callerRole,
      name: calls.callerName,
      n: sql<number>`count(*)::int`,
      last: sql<string>`max(${calls.startedAt})`,
    })
    .from(calls)
    .where(
      and(
        eq(calls.customerId, customerId),
        eq(calls.interactionType, "inbound_call"),
        isNotNull(calls.callerRole),
      ),
    )
    .groupBy(calls.callerRole, calls.callerName)
    .orderBy(desc(sql`count(*)`), desc(sql`max(${calls.startedAt})`))
    .limit(4);

  const out: CallerSuggestion[] = rows.map((r) => ({
    role: r.role,
    name: r.name?.trim() || null,
    source: "earlier_calls" as const,
    calls: Number(r.n),
  }));
  const contact = customer.contactPerson?.trim();
  if (contact && !out.some((s) => s.name?.toLowerCase() === contact.toLowerCase())) {
    out.unshift({ role: null, name: contact, source: "record", calls: 0 });
  }
  return out;
}
