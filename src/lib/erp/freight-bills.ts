import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpFreightBillEvents, erpFreightBillLines, erpFreightBills } from "@/db/schema";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { addDays } from "./engines/logistics";
import {
  billProblems,
  editRefusal,
  freightBillName,
  freightBillNo,
  lineEligibility,
  markPaidRefusal,
  PAYMENT_MODES,
  splitBill,
  staleShares,
  undoPaymentRefusal,
  type FreightBillStatus,
  type LineNow,
  type PaymentMode,
  type ShareChange,
} from "./engines/freight-bill";
import { isErpManager, today } from "./screens/common";
import { erpAudit, erpId, nextNumber } from "./server";
import { inr, nf } from "./ui";

/* ---------------------------------------------------------------------------
 * LOGISTICS → TRANSPORT EXPENSES (the Transportation Expense PRD).
 *
 * A transporter's bill is entered against the vehicle that carried the goods
 * and the day it left. Every order line dispatch-verified onto that vehicle
 * that day (`erp_order_details.transport_id` → `erp_transports.vehicle_no`)
 * is offered; only PAID freight is ticked, and the bill is split over the
 * ticked lines by litres the moment it is saved. Pending until somebody marks
 * it paid; a manager can move a paid bill back to pending with a reason.
 *
 * The share an order line carries is read by `detailRows`, so it reaches the
 * line's costing, its margin and the Founder's Margins desk with no typing.
 * The rules are `engines/freight-bill.ts`.
 * ------------------------------------------------------------------------- */

type Exec = Pick<typeof db, "execute" | "insert" | "update">;
type Row = Record<string, unknown>;
const s = (v: unknown) => (v == null ? null : String(v));
const clean = (v: string | null | undefined, max = 200) => (v ?? "").trim().slice(0, max) || null;
const vehicleKey = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, "").toUpperCase();
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const rupees = (p: number) => inr(p);

/* ================================================================ the lines on a vehicle */

/** A dispatched order line, as the bill sees it. */
export type VehicleLine = {
  orderId: string;
  orderNo: number;
  transportId: string | null;
  billNo: string | null;
  customer: string;
  customerId: string;
  product: string;
  productId: string | null;
  litres: number | null;
  freightTerm: string | null;
  vehicleNo: string | null;
  dispatchOn: string | null;
  transporter: string | null;
  /** The live bill this line's freight is already on, other than the one being edited. */
  takenBy: string | null;
  takenById: string | null;
};

const LINE_COLS = sql`
  o.id as "orderId", o.order_no as "orderNo", d.transport_id as "transportId",
  coalesce(t.bill_no, o.tally_bill_no) as "billNo",
  c.name as customer, c.id as "customerId", coalesce(p.name, 'Unknown product') as product, p.id as "productId",
  (o.qty_cans * coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000) as litres,
  coalesce(t.payment_type, c.freight_term) as "freightTerm",
  t.vehicle_no as "vehicleNo", d.dispatch_date::text as "dispatchOn",
  coalesce(t.transporter, o.transporter) as transporter,
  o.status = 'Cancel' or d.transport_id is null as gone,
  tk.bill_id as "takenById", tk.bill_no as "takenNo", tk.lr_no as "takenLr"`;

const LINE_FROM = sql`
  from erp_order_details d
  join erp_orders o on o.id = d.order_id
  left join erp_transports t on t.id = d.transport_id
  join customers c on c.id = o.billing_customer_id
  left join products p on p.id = o.sku_id
  left join finished_goods fg on fg.id = p.finished_good_id
  left join lateral (
    select fb.id as bill_id, fb.bill_no, fb.lr_no from erp_freight_bill_lines bl join erp_freight_bills fb on fb.id = bl.bill_id
     where bl.order_id = o.id and bl.live limit 1
  ) tk on true`;

function line(r: Row, editing: string | null): VehicleLine {
  const takenById = s(r.takenById);
  const mine = takenById != null && takenById === editing;
  return {
    orderId: String(r.orderId),
    orderNo: Number(r.orderNo),
    transportId: s(r.transportId),
    billNo: s(r.billNo),
    customer: String(r.customer),
    customerId: String(r.customerId),
    product: String(r.product),
    productId: s(r.productId),
    litres: r.litres == null ? null : Math.round(Number(r.litres) * 1000) / 1000,
    freightTerm: s(r.freightTerm),
    vehicleNo: s(r.vehicleNo),
    dispatchOn: s(r.dispatchOn),
    transporter: s(r.transporter),
    takenBy: takenById && !mine ? freightBillName(Number(r.takenNo), String(r.takenLr)) : null,
    takenById: takenById && !mine ? takenById : null,
  };
}

/** Every line dispatch-verified onto this vehicle on this day. */
export async function vehicleLines(vehicleNo: string, dispatchOn: string, editingBillId: string | null = null): Promise<VehicleLine[]> {
  if (!DAY.test(dispatchOn) || !vehicleKey(vehicleNo)) return [];
  const rows = (await db.execute(sql`
    select ${LINE_COLS} ${LINE_FROM}
     where d.dispatch_date = ${dispatchOn}::date
       and upper(regexp_replace(coalesce(t.vehicle_no, ''), '\\s', '', 'g')) = ${vehicleKey(vehicleNo)}
     order by c.name, o.order_no
  `)) as unknown as Row[];
  return rows.map((r) => line(r, editingBillId));
}

/** Dispatched lines of these order numbers — "a dispatch that left on another vehicle". */
export async function linesOfOrders(orderNos: number[], editingBillId: string | null = null): Promise<VehicleLine[]> {
  const nos = [...new Set(orderNos.filter((x) => Number.isInteger(x) && x > 0))].slice(0, 50);
  if (!nos.length) return [];
  const rows = (await db.execute(sql`
    select ${LINE_COLS} ${LINE_FROM}
     where o.order_no in ${nos} and d.transport_id is not null
     order by o.order_no
  `)) as unknown as Row[];
  return rows.map((r) => line(r, editingBillId));
}

async function linesOfIds(tx: Exec, orderIds: string[], editingBillId: string | null): Promise<VehicleLine[]> {
  if (!orderIds.length) return [];
  const rows = (await tx.execute(sql`select ${LINE_COLS} ${LINE_FROM} where o.id in ${orderIds}`)) as unknown as Row[];
  return rows.map((r) => line(r, editingBillId));
}

/** What each order line looks like now, for the stale-split check. */
async function linesNow(orderIds: string[]): Promise<Map<string, LineNow>> {
  const rows = orderIds.length ? ((await db.execute(sql`select ${LINE_COLS} ${LINE_FROM} where o.id in ${orderIds}`)) as unknown as Row[]) : [];
  return new Map(rows.map((r) => [String(r.orderId), { orderId: String(r.orderId), litres: r.litres == null ? null : Number(r.litres), freightTerm: s(r.freightTerm), gone: r.gone === true }]));
}

/* ================================================================ vehicles that left */

export type VehicleTrip = {
  vehicleNo: string;
  dispatchOn: string;
  transporter: string | null;
  lines: number;
  customers: number;
  paidLitres: number;
  otherLines: number;
  /** Paid-freight lines not yet on a bill. */
  unbilledLines: number;
  /** Their litres, and how many customers they belong to. */
  unbilledLitres: number;
  unbilledCustomers: number;
};

/**
 * How far back a vehicle trip is offered: the add-bill picker, the trips
 * Pending expense lists as waiting for a bill, and the dashboard's count of
 * them. One number, so the list never names a trip the picker cannot offer.
 */
export const FREIGHT_TRIP_DAYS = 45;

/**
 * Every vehicle that left in the last `days`, with its Paid-freight litres —
 * the vehicle picker on the add-bill form, newest first, and the "no bill yet"
 * figure on the tab.
 */
export async function recentVehicles(days = FREIGHT_TRIP_DAYS): Promise<VehicleTrip[]> {
  const since = addDays(today(), -days);
  const rows = (await db.execute(sql`
    with l as (
      select upper(regexp_replace(t.vehicle_no, '\\s', '', 'g')) as vkey, t.vehicle_no, d.dispatch_date, o.billing_customer_id as cid,
             coalesce(t.transporter, o.transporter) as transporter,
             lower(regexp_replace(coalesce(t.payment_type, c.freight_term, ''), '[\\s-]+', '_', 'g')) = 'paid' as paid,
             (o.qty_cans * coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000) as litres,
             exists (select 1 from erp_freight_bill_lines bl where bl.order_id = o.id and bl.live) as billed
        from erp_order_details d
        join erp_orders o on o.id = d.order_id
        join erp_transports t on t.id = d.transport_id
        join customers c on c.id = o.billing_customer_id
        left join products p on p.id = o.sku_id
        left join finished_goods fg on fg.id = p.finished_good_id
       where d.dispatch_date >= ${since}::date and coalesce(trim(t.vehicle_no), '') <> '' and o.status <> 'Cancel'
    )
    select min(vehicle_no) as "vehicleNo", dispatch_date::text as "dispatchOn", mode() within group (order by transporter) as transporter,
           count(*)::int as lines, count(distinct cid)::int as customers,
           coalesce(sum(litres) filter (where paid), 0)::float8 as "paidLitres",
           count(*) filter (where not paid)::int as "otherLines",
           count(*) filter (where paid and not billed)::int as "unbilledLines",
           coalesce(sum(litres) filter (where paid and not billed), 0)::float8 as "unbilledLitres",
           count(distinct cid) filter (where paid and not billed)::int as "unbilledCustomers"
      from l group by vkey, dispatch_date
     order by dispatch_date desc, min(vehicle_no)
  `)) as unknown as Row[];
  return rows.map((r) => ({
    vehicleNo: String(r.vehicleNo),
    dispatchOn: String(r.dispatchOn),
    transporter: s(r.transporter),
    lines: Number(r.lines),
    customers: Number(r.customers),
    paidLitres: Math.round(Number(r.paidLitres) * 1000) / 1000,
    otherLines: Number(r.otherLines),
    unbilledLines: Number(r.unbilledLines),
    unbilledLitres: Math.round(Number(r.unbilledLitres) * 1000) / 1000,
    unbilledCustomers: Number(r.unbilledCustomers),
  }));
}

/**
 * One sales bill whose Paid-freight lines are on no transport bill yet. The
 * office matches a transporter's bill against OUR bill numbers, so Pending
 * expense lists these one bill to a row rather than one trip to a row.
 * vehicleNo and dispatchOn are the trip the bill went on, which is what Add
 * bill opens on.
 */
export type WaitingBill = {
  /** The sales bill number, or null where the dispatch carries none yet. */
  billNo: string | null;
  billDate: string | null;
  party: string;
  vehicleNo: string;
  dispatchOn: string;
  transporter: string | null;
  lines: number;
  litres: number;
};

/**
 * Sales bills on a vehicle that left in the last days, still waiting for the
 * transporter's bill — newest bill first. Read off the same lines, the same
 * Paid test and the same window as recentVehicles, so a bill listed here is
 * always on a trip the add-bill picker can offer.
 */
export async function waitingBills(days = FREIGHT_TRIP_DAYS): Promise<WaitingBill[]> {
  const since = addDays(today(), -days);
  const rows = (await db.execute(sql`
    with l as (
      select upper(regexp_replace(t.vehicle_no, '\s', '', 'g')) as vkey, t.vehicle_no, d.dispatch_date, t.id as tid,
             nullif(trim(coalesce(t.bill_no, o.tally_bill_no)), '') as bill_no, t.bill_date, c.name as party,
             coalesce(t.transporter, o.transporter) as transporter,
             (o.qty_cans * coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000) as litres
        from erp_order_details d
        join erp_orders o on o.id = d.order_id
        join erp_transports t on t.id = d.transport_id
        join customers c on c.id = o.billing_customer_id
        left join products p on p.id = o.sku_id
        left join finished_goods fg on fg.id = p.finished_good_id
       where d.dispatch_date >= ${since}::date and coalesce(trim(t.vehicle_no), '') <> '' and o.status <> 'Cancel'
         and lower(regexp_replace(coalesce(t.payment_type, c.freight_term, ''), '[\s-]+', '_', 'g')) = 'paid'
         and not exists (select 1 from erp_freight_bill_lines bl where bl.order_id = o.id and bl.live)
    )
    select bill_no as "billNo", max(bill_date)::text as "billDate", mode() within group (order by party) as party,
           min(vehicle_no) as "vehicleNo", dispatch_date::text as "dispatchOn", mode() within group (order by transporter) as transporter,
           count(*)::int as lines, coalesce(sum(litres), 0)::float8 as litres
      from l group by coalesce(bill_no, tid), bill_no, vkey, dispatch_date
     order by max(bill_date) desc nulls last, dispatch_date desc, bill_no desc
  `)) as unknown as Row[];
  return rows.map((r) => ({
    billNo: s(r.billNo),
    billDate: s(r.billDate),
    party: String(r.party),
    vehicleNo: String(r.vehicleNo),
    dispatchOn: String(r.dispatchOn),
    transporter: s(r.transporter),
    lines: Number(r.lines),
    litres: Math.round(Number(r.litres) * 1000) / 1000,
  }));
}

/* ================================================================ bills */

export type FreightShare = {
  orderId: string;
  orderNo: number;
  billNo: string | null;
  customer: string;
  customerId: string;
  product: string;
  litres: number;
  amountPaise: number;
};

export type FreightBillEvent = { kind: string; note: string | null; by: string | null; at: string };

export type FreightBillView = {
  id: string;
  billNo: number;
  name: string;
  lrNo: string;
  billDate: string;
  transporter: string;
  vehicleNo: string;
  dispatchOn: string;
  amountPaise: number;
  remarks: string | null;
  status: FreightBillStatus;
  paidOn: string | null;
  paymentMode: PaymentMode | null;
  paymentRef: string | null;
  paymentRemarks: string | null;
  paidBy: string | null;
  createdBy: string | null;
  createdAt: string;
  litres: number;
  customers: number;
  shares: FreightShare[];
  /** The shares whose order line changed since the split. */
  stale: ShareChange[];
  events: FreightBillEvent[];
};

const BILL_COLS = sql`
  b.id, b.bill_no as "billNo", b.lr_no as "lrNo", b.bill_date::text as "billDate", b.transporter, b.vehicle_no as "vehicleNo",
  b.dispatch_on::text as "dispatchOn", b.amount_paise as "amountPaise", b.remarks, b.status, b.paid_on::text as "paidOn",
  b.payment_mode as "paymentMode", b.payment_ref as "paymentRef", b.payment_remarks as "paymentRemarks",
  pu.name as "paidBy", cu.name as "createdBy", b.created_at as "createdAt"`;

/**
 * Bills, with their live shares and whether the split went stale. Pending
 * bills are all of them, oldest first; paid ones are those paid in the
 * window (by payment date), newest first.
 */
export async function freightBills(opts: { status: "pending" | "paid"; from?: string | null; to?: string | null; ids?: string[] }): Promise<FreightBillView[]> {
  const where = opts.ids
    ? opts.ids.length
      ? sql`b.id in ${opts.ids}`
      : sql`false`
    : opts.status === "pending"
      ? sql`b.status = 'pending'`
      : sql`b.status = 'paid' ${opts.from && DAY.test(opts.from) ? sql`and b.paid_on >= ${opts.from}::date` : sql``} ${opts.to && DAY.test(opts.to) ? sql`and b.paid_on <= ${opts.to}::date` : sql``}`;
  const order = opts.status === "paid" && !opts.ids ? sql`b.paid_on desc, b.bill_no desc` : sql`b.bill_date, b.bill_no`;
  const bills = (await db.execute(sql`
    select ${BILL_COLS} from erp_freight_bills b
      left join users pu on pu.id = b.paid_by_id left join users cu on cu.id = b.created_by_id
     where ${where} order by ${order} limit 2000
  `)) as unknown as Row[];
  if (!bills.length) return [];
  const ids = bills.map((b) => String(b.id));
  const [shareRows, eventRows] = await Promise.all([
    db.execute(sql`
      select bl.bill_id as "billId", bl.order_id as "orderId", o.order_no as "orderNo", coalesce(t.bill_no, o.tally_bill_no) as "billNo",
             c.name as customer, c.id as "customerId", coalesce(p.name, 'Unknown product') as product,
             bl.litres::float8 as litres, bl.amount_paise as "amountPaise"
        from erp_freight_bill_lines bl
        join erp_orders o on o.id = bl.order_id
        join customers c on c.id = o.billing_customer_id
        left join products p on p.id = o.sku_id
        left join erp_transports t on t.id = bl.transport_id
       where bl.bill_id in ${ids} and bl.live
       order by c.name, o.order_no
    `) as unknown as Promise<Row[]>,
    db.execute(sql`
      select e.bill_id as "billId", e.kind, e.note, u.name as by, e.at from erp_freight_bill_events e left join users u on u.id = e.by_id
       where e.bill_id in ${ids} order by e.at
    `) as unknown as Promise<Row[]>,
  ]);
  const sharesOf = new Map<string, FreightShare[]>();
  for (const r of shareRows) {
    const a = sharesOf.get(String(r.billId)) ?? [];
    a.push({ orderId: String(r.orderId), orderNo: Number(r.orderNo), billNo: s(r.billNo), customer: String(r.customer), customerId: String(r.customerId), product: String(r.product), litres: Number(r.litres), amountPaise: Number(r.amountPaise) });
    sharesOf.set(String(r.billId), a);
  }
  const eventsOf = new Map<string, FreightBillEvent[]>();
  for (const r of eventRows) {
    const a = eventsOf.get(String(r.billId)) ?? [];
    a.push({ kind: String(r.kind), note: s(r.note), by: s(r.by), at: new Date(String(r.at)).toISOString() });
    eventsOf.set(String(r.billId), a);
  }
  /* Only a pending bill can go stale: a paid one is a record of what was paid. */
  const pendingOrderIds = bills.filter((b) => b.status === "pending").flatMap((b) => (sharesOf.get(String(b.id)) ?? []).map((x) => x.orderId));
  const now = await linesNow(pendingOrderIds);
  return bills.map((b) => {
    const shares = sharesOf.get(String(b.id)) ?? [];
    const status = String(b.status) as FreightBillStatus;
    return {
      id: String(b.id),
      billNo: Number(b.billNo),
      name: freightBillName(Number(b.billNo), String(b.lrNo)),
      lrNo: String(b.lrNo),
      billDate: String(b.billDate),
      transporter: String(b.transporter),
      vehicleNo: String(b.vehicleNo),
      dispatchOn: String(b.dispatchOn),
      amountPaise: Number(b.amountPaise),
      remarks: s(b.remarks),
      status,
      paidOn: s(b.paidOn),
      paymentMode: (s(b.paymentMode) as PaymentMode | null) ?? null,
      paymentRef: s(b.paymentRef),
      paymentRemarks: s(b.paymentRemarks),
      paidBy: s(b.paidBy),
      createdBy: s(b.createdBy),
      createdAt: new Date(String(b.createdAt)).toISOString(),
      litres: Math.round(shares.reduce((a, x) => a + x.litres, 0) * 1000) / 1000,
      customers: new Set(shares.map((x) => x.customerId)).size,
      shares,
      stale: status === "pending" ? staleShares(shares, now) : [],
      events: eventsOf.get(String(b.id)) ?? [],
    };
  });
}

/** How many Paid-freight order lines left on a vehicle in the last `days` with no bill yet. */
export async function unbilledPaidLines(days = FREIGHT_TRIP_DAYS): Promise<number> {
  const v = await recentVehicles(days);
  return v.reduce((a, x) => a + x.unbilledLines, 0);
}

/* ================================================================ the share an order line carries */

export type LineFreight = { amountPaise: number; billId: string; billNo: number; status: FreightBillStatus };

/** Each order line's live transport share — read by `detailRows`, so it reaches costing and margin. */
export async function freightSharesFor(orderIds: string[]): Promise<Map<string, LineFreight>> {
  if (!orderIds.length) return new Map();
  const rows = (await db.execute(sql`
    select bl.order_id as "orderId", bl.amount_paise as "amountPaise", b.id as "billId", b.bill_no as "billNo", b.status
      from erp_freight_bill_lines bl join erp_freight_bills b on b.id = bl.bill_id
     where bl.live and b.status <> 'deleted' and bl.order_id in ${orderIds}
  `)) as unknown as Row[];
  return new Map(rows.map((r) => [String(r.orderId), { amountPaise: Number(r.amountPaise), billId: String(r.billId), billNo: Number(r.billNo), status: String(r.status) as FreightBillStatus }]));
}

/* ================================================================ writes */

export type FreightBillInput = {
  id?: string | null;
  lrNo: string;
  billDate: string;
  transporter: string;
  vehicleNo: string;
  dispatchOn: string;
  amountPaise: number | null;
  remarks?: string | null;
  orderIds: string[];
};

async function event(tx: Exec, billId: string, kind: string, note: string | null, userId: string) {
  await tx.insert(erpFreightBillEvents).values({ id: erpId("efbe"), billId, kind, note, byId: userId });
}

/**
 * Write a bill's split, in the caller's transaction: the ticked lines are read
 * again under lock, each must still be Paid freight with litres and on no
 * other live bill, and the shares are written by `splitBill`. Any live shares
 * the bill had are marked not live first.
 */
async function writeSplit(tx: Exec, billId: string, amountPaise: number, orderIds: string[]): Promise<string | { litres: number; lines: number }> {
  await tx.execute(sql`select id from erp_orders where id in ${orderIds} order by id for update`);
  const lines = await linesOfIds(tx, orderIds, billId);
  if (lines.length !== orderIds.length) return "A dispatch you ticked no longer exists. Open the bill again.";
  for (const l of lines) {
    if (!l.transportId) return `Order ${l.orderNo} has not been dispatched.`;
    const e = lineEligibility(l);
    if (!e.ok) return `Order ${l.orderNo} (${l.customer}): ${e.why}.`;
  }
  const split = splitBill(amountPaise, lines);
  if (!split.ok) return split.reason;
  await tx.execute(sql`update erp_freight_bill_lines set live = false where bill_id = ${billId} and live`);
  const byId = new Map(lines.map((l) => [l.orderId, l]));
  await tx.insert(erpFreightBillLines).values(
    split.rows.map((r) => ({ id: erpId("efbl"), billId, orderId: r.id, transportId: byId.get(r.id)?.transportId ?? null, litres: r.litres, amountPaise: r.amountPaise })),
  );
  return { litres: split.totalLitres, lines: split.rows.length };
}

/** A race on the partial unique index: the line went onto another bill between the read and the write. */
function takenRace(e: unknown): boolean {
  return String((e as { cause?: { constraint_name?: string } })?.cause?.constraint_name ?? (e as Error)?.message ?? "").includes("erp_freight_bill_lines_live_key");
}

/** Add a bill, or edit a pending one — the split is written in the same transaction. */
export async function saveFreightBill(ctx: ErpContext, input: FreightBillInput): Promise<Result<{ id: string; billNo: number }>> {
  const orderIds = [...new Set((input.orderIds ?? []).filter((x) => typeof x === "string" && x))];
  const b = {
    lrNo: (input.lrNo ?? "").trim().slice(0, 60),
    billDate: (input.billDate ?? "").trim(),
    transporter: (input.transporter ?? "").trim().slice(0, 120),
    vehicleNo: (input.vehicleNo ?? "").trim().toUpperCase().slice(0, 40),
    dispatchOn: (input.dispatchOn ?? "").trim(),
    amountPaise: input.amountPaise == null ? null : Math.round(Number(input.amountPaise)),
    orderIds,
  };
  const problems = billProblems(b, today());
  const first = Object.entries(problems)[0];
  if (first) return fieldErr(first[0], first[1]);
  const remarks = clean(input.remarks, 500);
  const editing = clean(input.id, 80);
  let saved: { id: string; billNo: number } | null = null;
  let words = "";
  try {
    const refused = await db.transaction(async (tx) => {
      if (editing) {
        const [cur] = (await tx.execute(sql`select id, bill_no as "billNo", status from erp_freight_bills where id = ${editing} for update`)) as unknown as { id: string; billNo: number; status: FreightBillStatus }[];
        if (!cur) return "That bill no longer exists.";
        const no = editRefusal(cur.status);
        if (no) return no;
        await tx
          .update(erpFreightBills)
          .set({ lrNo: b.lrNo, billDate: b.billDate, transporter: b.transporter, vehicleNo: b.vehicleNo, dispatchOn: b.dispatchOn, amountPaise: b.amountPaise!, remarks, updatedAt: new Date(), updatedById: ctx.user.id })
          .where(inArray(erpFreightBills.id, [cur.id]));
        saved = { id: cur.id, billNo: cur.billNo };
      } else {
        /* The same LR from the same transporter is the same bill: entered twice, it would be paid twice. */
        const [dup] = (await tx.execute(sql`
          select bill_no as "billNo" from erp_freight_bills
           where status <> 'deleted' and lower(trim(transporter)) = lower(${b.transporter}) and upper(regexp_replace(lr_no, '\\s', '', 'g')) = ${vehicleKey(b.lrNo)}
           limit 1
        `)) as unknown as { billNo: number }[];
        if (dup) return `LR ${b.lrNo} from ${b.transporter} is already entered as ${freightBillNo(dup.billNo)}.`;
        const id = erpId("efb");
        const billNo = await nextNumber(tx, "freightBill");
        await tx.insert(erpFreightBills).values({ id, billNo, lrNo: b.lrNo, billDate: b.billDate, transporter: b.transporter, vehicleNo: b.vehicleNo, dispatchOn: b.dispatchOn, amountPaise: b.amountPaise!, remarks, createdById: ctx.user.id, updatedById: ctx.user.id });
        saved = { id, billNo };
      }
      const split = await writeSplit(tx, saved.id, b.amountPaise!, orderIds);
      if (typeof split === "string") throw new SplitRefused(split);
      words = `${rupees(b.amountPaise!)} split over ${split.lines} order line${split.lines === 1 ? "" : "s"} · ${nf(split.litres)} L`;
      await event(tx, saved.id, editing ? "edited" : "created", words, ctx.user.id);
      return null;
    });
    if (refused) return err(refused, "rule_violation");
  } catch (e) {
    if (e instanceof SplitRefused) return err(e.message, "rule_violation");
    if (takenRace(e)) return err("One of those dispatches was just put on another bill. Open the form again.", "conflict");
    throw e;
  }
  const done = saved as unknown as { id: string; billNo: number };
  await erpAudit(ctx, editing ? "erp.freightBill.edit" : "erp.freightBill.create", "erp_freight_bill", done.id, null, { ...b, remarks });
  return ok(done, `${freightBillNo(done.billNo)} saved · ${words}`);
}

class SplitRefused extends Error {}

/** Split a pending bill again over its lines as they are now — after a dispatch was corrected. Lines that left Paid freight, or were undone, drop out. */
export async function resplitFreightBill(ctx: ErpContext, billId: string): Promise<Result<unknown>> {
  let words = "";
  try {
    const refused = await db.transaction(async (tx) => {
      const [cur] = (await tx.execute(sql`select id, bill_no as "billNo", status, amount_paise as "amountPaise" from erp_freight_bills where id = ${billId} for update`)) as unknown as { id: string; billNo: number; status: FreightBillStatus; amountPaise: number }[];
      if (!cur) return "That bill no longer exists.";
      const no = editRefusal(cur.status);
      if (no) return no;
      const had = (await tx.execute(sql`select order_id as "orderId" from erp_freight_bill_lines where bill_id = ${cur.id} and live`)) as unknown as { orderId: string }[];
      const lines = await linesOfIds(tx, had.map((h) => h.orderId), cur.id);
      const keep = lines.filter((l) => l.transportId && lineEligibility(l).ok).map((l) => l.orderId);
      if (!keep.length) return "None of this bill's dispatches is Paid freight any more. Change its dispatches, or delete it.";
      const split = await writeSplit(tx, cur.id, Number(cur.amountPaise), keep);
      if (typeof split === "string") return split;
      const dropped = had.length - keep.length;
      words = `Split again over ${split.lines} order line${split.lines === 1 ? "" : "s"} · ${nf(split.litres)} L${dropped ? ` · ${dropped} dropped` : ""}`;
      await event(tx, cur.id, "split", words, ctx.user.id);
      return null;
    });
    if (refused) return err(refused, "rule_violation");
  } catch (e) {
    if (takenRace(e)) return err("One of those dispatches was just put on another bill. Open it again.", "conflict");
    throw e;
  }
  await erpAudit(ctx, "erp.freightBill.resplit", "erp_freight_bill", billId, null, { words });
  return okVoid(words);
}

export type PaymentFields = { paidOn: string; mode: string; reference?: string | null; remarks?: string | null };

/** Mark a pending bill paid. It moves to Paid history; the shares on each order stay as they are. */
export async function markFreightBillPaid(ctx: ErpContext, billId: string, p: PaymentFields): Promise<Result<unknown>> {
  const paidOn = (p.paidOn ?? "").trim();
  if (!DAY.test(paidOn)) return fieldErr("paidOn", "Pick the payment date.");
  if (paidOn > today()) return fieldErr("paidOn", "The payment date cannot be in the future.");
  const mode = (p.mode ?? "").trim().toLowerCase() as PaymentMode;
  if (!PAYMENT_MODES.includes(mode)) return fieldErr("mode", "Pick Bank, UPI or Cash.");
  const [cur] = await freightBills({ status: "pending", ids: [billId] });
  if (!cur) return err("That bill no longer exists.", "not_found");
  const no = markPaidRefusal(cur.status, cur.stale.length);
  if (no) return err(no, "rule_violation");
  const moved = (await db.execute(sql`
    update erp_freight_bills set status = 'paid', paid_on = ${paidOn}::date, payment_mode = ${mode}, payment_ref = ${clean(p.reference, 120)},
           payment_remarks = ${clean(p.remarks, 500)}, paid_by_id = ${ctx.user.id}, paid_at = now(), updated_at = now(), updated_by_id = ${ctx.user.id}
     where id = ${billId} and status = 'pending' returning id
  `)) as unknown as { id: string }[];
  if (!moved.length) return err("Somebody changed this bill just now. Open it again.", "conflict");
  await event(db, billId, "paid", `${rupees(cur.amountPaise)} paid on ${paidOn} by ${mode.toUpperCase()}${clean(p.reference) ? ` · ${clean(p.reference)}` : ""}`, ctx.user.id);
  await erpAudit(ctx, "erp.freightBill.pay", "erp_freight_bill", billId, { status: "pending" }, { status: "paid", paidOn, mode, reference: clean(p.reference, 120) });
  return okVoid(`${cur.name} marked paid · moved to Paid history`);
}

/** A manager moves a paid bill back to pending, with a reason. The split stays; the payment is kept in its history. */
export async function undoFreightBillPayment(ctx: ErpContext, billId: string, reason: string): Promise<Result<unknown>> {
  const why = (reason ?? "").trim().slice(0, 500);
  if (why.length < 3) return fieldErr("reason", "Say why the payment is undone.");
  const [cur] = (await db.execute(sql`
    select id, bill_no as "billNo", lr_no as "lrNo", status, paid_on::text as "paidOn", payment_mode as mode, payment_ref as ref from erp_freight_bills where id = ${billId}
  `)) as unknown as { id: string; billNo: number; lrNo: string; status: FreightBillStatus; paidOn: string | null; mode: string | null; ref: string | null }[];
  if (!cur) return err("That bill no longer exists.", "not_found");
  const no = undoPaymentRefusal(cur.status, isErpManager(ctx));
  if (no) return err(no, cur.status === "paid" ? "not_permitted" : "rule_violation");
  const moved = (await db.execute(sql`
    update erp_freight_bills set status = 'pending', paid_on = null, payment_mode = null, payment_ref = null, payment_remarks = null,
           paid_by_id = null, paid_at = null, updated_at = now(), updated_by_id = ${ctx.user.id}
     where id = ${billId} and status = 'paid' returning id
  `)) as unknown as { id: string }[];
  if (!moved.length) return err("Somebody changed this bill just now. Open it again.", "conflict");
  await event(db, billId, "unpaid", `Payment of ${cur.paidOn} (${(cur.mode ?? "").toUpperCase()}${cur.ref ? ` · ${cur.ref}` : ""}) undone: ${why}`, ctx.user.id);
  await erpAudit(ctx, "erp.freightBill.unpay", "erp_freight_bill", billId, { status: "paid", paidOn: cur.paidOn, mode: cur.mode, ref: cur.ref }, { status: "pending", reason: why });
  return okVoid(`${freightBillName(cur.billNo, cur.lrNo)} is back in Pending expense`);
}

/** Delete a pending bill, with a reason: its shares leave every order, the row stays. */
export async function deleteFreightBill(ctx: ErpContext, billId: string, reason: string): Promise<Result<unknown>> {
  const why = (reason ?? "").trim().slice(0, 500);
  if (why.length < 3) return fieldErr("reason", "Say why the bill is deleted.");
  let name = "";
  const refused = await db.transaction(async (tx) => {
    const [cur] = (await tx.execute(sql`select id, bill_no as "billNo", lr_no as "lrNo", status from erp_freight_bills where id = ${billId} for update`)) as unknown as { id: string; billNo: number; lrNo: string; status: FreightBillStatus }[];
    if (!cur) return "That bill no longer exists.";
    const no = editRefusal(cur.status);
    if (no) return no;
    name = freightBillName(cur.billNo, cur.lrNo);
    await tx.execute(sql`update erp_freight_bill_lines set live = false where bill_id = ${cur.id} and live`);
    await tx.execute(sql`update erp_freight_bills set status = 'deleted', delete_reason = ${why}, deleted_by_id = ${ctx.user.id}, deleted_at = now(), updated_at = now(), updated_by_id = ${ctx.user.id} where id = ${cur.id}`);
    await event(tx, cur.id, "deleted", why, ctx.user.id);
    return null;
  });
  if (refused) return err(refused, "rule_violation");
  await erpAudit(ctx, "erp.freightBill.delete", "erp_freight_bill", billId, null, { reason: why });
  return okVoid(`${name} deleted`);
}

/* ================================================================ reports */

export type FreightReportRow = { key: string; label: string; sub: string | null; bills: number; litres: number; pendingPaise: number; paidPaise: number };
export type FreightReport = {
  from: string;
  to: string;
  pendingPaise: number;
  paidPaise: number;
  litres: number;
  bills: number;
  byCustomer: FreightReportRow[];
  byProduct: FreightReportRow[];
  byOrder: FreightReportRow[];
  byTransporter: FreightReportRow[];
  /** Month, bills' total ÷ their litres. */
  monthly: { month: string; amountPaise: number; litres: number }[];
};

/** Every report the PRD names, over bills dated in the period (pending and paid; deleted never). */
export async function freightReport(from: string, to: string): Promise<FreightReport> {
  const f = DAY.test(from) ? from : addDays(today(), -365);
  const t = DAY.test(to) ? to : today();
  const rows = (await db.execute(sql`
    select b.id as "billId", b.status, b.transporter, to_char(b.bill_date, 'YYYY-MM') as month,
           bl.order_id as "orderId", o.order_no as "orderNo", c.id as "customerId", c.name as customer,
           coalesce(p.id, '') as "productId", coalesce(p.name, 'Unknown product') as product,
           bl.litres::float8 as litres, bl.amount_paise as "amountPaise"
      from erp_freight_bills b
      join erp_freight_bill_lines bl on bl.bill_id = b.id and bl.live
      join erp_orders o on o.id = bl.order_id
      join customers c on c.id = o.billing_customer_id
      left join products p on p.id = o.sku_id
     where b.status <> 'deleted' and b.bill_date between ${f}::date and ${t}::date
  `)) as unknown as Row[];
  const group = (key: (r: Row) => string, label: (r: Row) => string, sub: (r: Row) => string | null) => {
    const m = new Map<string, FreightReportRow & { _bills: Set<string> }>();
    for (const r of rows) {
      const k = key(r);
      const g = m.get(k) ?? { key: k, label: label(r), sub: sub(r), bills: 0, litres: 0, pendingPaise: 0, paidPaise: 0, _bills: new Set<string>() };
      g._bills.add(String(r.billId));
      g.litres += Number(r.litres);
      if (r.status === "paid") g.paidPaise += Number(r.amountPaise);
      else g.pendingPaise += Number(r.amountPaise);
      m.set(k, g);
    }
    return [...m.values()]
      .map(({ _bills, ...g }) => ({ ...g, bills: _bills.size, litres: Math.round(g.litres * 1000) / 1000 }))
      .sort((a, b) => b.pendingPaise + b.paidPaise - (a.pendingPaise + a.paidPaise));
  };
  const months = new Map<string, { amountPaise: number; litres: number }>();
  for (const r of rows) {
    const k = String(r.month);
    const v = months.get(k) ?? { amountPaise: 0, litres: 0 };
    v.amountPaise += Number(r.amountPaise);
    v.litres += Number(r.litres);
    months.set(k, v);
  }
  const billIds = new Set(rows.map((r) => String(r.billId)));
  return {
    from: f,
    to: t,
    pendingPaise: rows.filter((r) => r.status !== "paid").reduce((a, r) => a + Number(r.amountPaise), 0),
    paidPaise: rows.filter((r) => r.status === "paid").reduce((a, r) => a + Number(r.amountPaise), 0),
    litres: Math.round(rows.reduce((a, r) => a + Number(r.litres), 0) * 1000) / 1000,
    bills: billIds.size,
    byCustomer: group((r) => String(r.customerId), (r) => String(r.customer), () => null),
    byProduct: group((r) => String(r.productId), (r) => String(r.product), () => null),
    byOrder: group((r) => String(r.orderId), (r) => `Order ${r.orderNo}`, (r) => `${r.customer} · ${r.product}`),
    byTransporter: group((r) => String(r.transporter).trim().toLowerCase(), (r) => String(r.transporter), () => null),
    monthly: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, amountPaise: v.amountPaise, litres: Math.round(v.litres * 1000) / 1000 })),
  };
}

