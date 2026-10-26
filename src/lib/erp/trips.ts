import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import { erpTransportAllocations, erpTransportEvents, erpTransportPayments, erpTransports, erpTrips } from "@/db/schema";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { addDays, phaseOf, type Phase } from "./engines/logistics";
import { allocateByLitres, needsReconciling, tripCostStatus, type PaymentFacts, type TransportCostStatus } from "./engines/transport-cost";
import { erpAudit, erpId, nextNumber } from "./server";
import { today } from "./screens/common";

/* ---------------------------------------------------------------------------
 * VEHICLE TRIPS AND THE TRANSPORT PAYMENT (Order-to-Delivery PRD steps 10–11).
 *
 * A bill's record (`erp_transports`) is one consignment to one party. A TRIP is
 * the tempo or truck: it carries several bills, for several customers, at once.
 * Dispatch opens or joins a trip from the vehicle number it records
 * (`assignTripsAtDispatch`); Logistics can regroup bills afterwards.
 *
 * A transport payment is recorded ONCE against a trip and shared out over the
 * bills it covers by dispatched litres — `engines/transport-cost.ts`, the same
 * function the payment dialog previews with. Logistics records the confirmed
 * payment; it does not make it, and nothing here says it did.
 * ------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Pick<typeof db, "execute" | "insert" | "update">;

const vehicleKey = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, "").toUpperCase();
const clean = (v: string | null | undefined, max = 120) => (v ?? "").trim().slice(0, max) || null;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function tripEvent(tx: Exec, transportIds: string[], note: string, userId: string | null) {
  if (!transportIds.length) return;
  await tx.insert(erpTransportEvents).values(transportIds.map((transportId) => ({ id: erpId("etev"), transportId, kind: "trip", stage: null, note, shared: false, byId: userId })));
}

/**
 * DISPATCH NAMES THE VEHICLE, AND THE TRIP FOLLOWS. Each bill record just
 * opened or joined at dispatch takes the vehicle number dispatch recorded, and
 * joins the trip of that vehicle on that day — or opens one. A record with no
 * vehicle number joins no trip: Logistics sees it under "Vehicle missing".
 * Called inside the dispatch transaction, so a dispatch and its trip land together.
 */
export async function assignTripsAtDispatch(
  tx: Tx | typeof db,
  items: { transportId: string; date: string; vehicleNo: string | null; driver: string | null; transporter: string | null }[],
  userId: string | null,
): Promise<void> {
  for (const it of items) {
    const vehicle = clean(it.vehicleNo, 40);
    if (!vehicle) continue;
    const [cur] = (await tx.execute(sql`select trip_id as "tripId" from erp_transports where id = ${it.transportId}`)) as unknown as { tripId: string | null }[];
    if (!cur) continue;
    await tx.execute(sql`update erp_transports set vehicle_no = ${vehicle} where id = ${it.transportId}`);
    if (cur.tripId) continue;
    const [found] = (await tx.execute(sql`
      select id, trip_no as "tripNo" from erp_trips
       where trip_date = ${it.date}::date and upper(regexp_replace(coalesce(vehicle_no, ''), '\\s', '', 'g')) = ${vehicleKey(vehicle)}
       order by trip_no
       limit 1
       for update
    `)) as unknown as { id: string; tripNo: number }[];
    let tripId = found?.id ?? null;
    let tripNo = found?.tripNo ?? 0;
    if (found) {
      await tx.execute(sql`
        update erp_trips set driver = coalesce(driver, ${clean(it.driver)}), transporter = coalesce(transporter, ${clean(it.transporter)}),
               updated_at = now(), updated_by_id = ${userId}
         where id = ${found.id}
      `);
    } else {
      tripId = erpId("etrip");
      tripNo = await nextNumber(tx, "trip");
      await tx.insert(erpTrips).values({ id: tripId, tripNo, tripDate: it.date, vehicleNo: vehicle, driver: clean(it.driver), transporter: clean(it.transporter), createdById: userId, updatedById: userId });
    }
    await tx.execute(sql`update erp_transports set trip_id = ${tripId} where id = ${it.transportId}`);
    await tripEvent(tx, [it.transportId], `On trip ${tripNo} · vehicle ${vehicle}`, userId);
  }
}

/* ================================================================ reads */

export type TripBill = {
  id: string;
  orderNo: number;
  billNo: string | null;
  billDate: string | null;
  party: string;
  deliveryParty: string;
  litres: number | null;
  vehicleNo: string | null;
  lrNo: string | null;
  phase: Phase;
  /** Its live share of a transport payment, if any. */
  sharePaise: number | null;
  shareLitres: number | null;
};

export type TripPayment = {
  id: string;
  amountPaise: number;
  paidOn: string | null;
  paidTo: string | null;
  reference: string | null;
  scope: string | null;
  note: string | null;
  status: "recorded" | "allocated" | "reversed";
  recordedBy: string | null;
  recordedAt: string;
  reversedBy: string | null;
  reversedAt: string | null;
  reverseReason: string | null;
  totalLitres: number;
  /** Paise per litre, unrounded; null where nothing is shared out. */
  costPerLitrePaise: number | null;
  shares: { transportId: string; litres: number; amountPaise: number }[];
  reconcile: boolean;
};

export type TripView = {
  id: string;
  tripNo: number;
  tripDate: string;
  vehicleNo: string | null;
  driver: string | null;
  transporter: string | null;
  note: string | null;
  bills: TripBill[];
  payments: TripPayment[];
  totalLitres: number;
  costStatus: TransportCostStatus;
  /** Some bill on it has no litres, so a payment cannot be shared over it yet. */
  litresMissing: boolean;
};

type Row = Record<string, unknown>;
const s = (v: unknown) => (v == null ? null : String(v));
const n = (v: unknown) => (v == null ? null : Number(v));
const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());

const BILL_COLS = sql`
  t.id, t.order_no as "orderNo", t.bill_no as "billNo", t.bill_date::text as "billDate", t.trip_id as "tripId",
  c.name as party, coalesce(dc.name, c.name) as "deliveryParty", t.litres::float8 as litres,
  t.vehicle_no as "vehicleNo", t.lr_no as "lrNo", t.material_stage as stage,
  a.amount_paise as "sharePaise", a.litres::float8 as "shareLitres"`;

const BILL_FROM = sql`
  from erp_transports t
  join customers c on c.id = t.billing_customer_id
  left join lateral (select min(o.delivery_customer_id) as delivery_id from erp_orders o where o.order_no = t.order_no) od on true
  left join customers dc on dc.id = od.delivery_id
  left join erp_transport_allocations a on a.transport_id = t.id and not a.reversed`;

function bill(r: Row): TripBill {
  const lrNo = s(r.lrNo);
  return {
    id: String(r.id),
    orderNo: Number(r.orderNo),
    billNo: s(r.billNo),
    billDate: s(r.billDate),
    party: String(r.party),
    deliveryParty: String(r.deliveryParty),
    litres: n(r.litres),
    vehicleNo: s(r.vehicleNo),
    lrNo,
    phase: phaseOf({ lrNo, materialStage: String(r.stage) }),
    sharePaise: n(r.sharePaise),
    shareLitres: n(r.shareLitres),
  };
}

/**
 * Every trip of the last `days` (by trip date), and any older one whose cost is
 * not settled yet — a payment owed on a trip from last quarter must not drop
 * off the screen because it is old.
 */
export async function trips(opts: { days?: number; ids?: string[] } = {}): Promise<TripView[]> {
  const since = addDays(today(), -(opts.days ?? 60));
  const where = opts.ids
    ? opts.ids.length
      ? sql`tp.id in ${opts.ids}`
      : sql`false`
    : sql`(tp.trip_date >= ${since}::date
           or exists (select 1 from erp_transports t where t.trip_id = tp.id
                       and not exists (select 1 from erp_transport_allocations a where a.transport_id = t.id and not a.reversed)))`;
  const tripRows = (await db.execute(sql`
    select tp.id, tp.trip_no as "tripNo", tp.trip_date::text as "tripDate", tp.vehicle_no as "vehicleNo", tp.driver, tp.transporter, tp.note
      from erp_trips tp
     where ${where}
     order by tp.trip_date desc, tp.trip_no desc
  `)) as unknown as Row[];
  if (!tripRows.length) return [];
  const ids = tripRows.map((r) => String(r.id));
  const [billRows, payRows, shareRows] = await Promise.all([
    db.execute(sql`select ${BILL_COLS} ${BILL_FROM} where t.trip_id in ${ids} order by t.bill_date, t.order_no`) as unknown as Promise<Row[]>,
    db.execute(sql`
      select p.*, ru.name as "recordedByName", vu.name as "reversedByName"
        from erp_transport_payments p
        left join users ru on ru.id = p.recorded_by_id
        left join users vu on vu.id = p.reversed_by_id
       where p.trip_id in ${ids}
       order by p.recorded_at
    `) as unknown as Promise<Row[]>,
    db.execute(sql`
      select a.payment_id as "paymentId", a.transport_id as "transportId", a.litres::float8 as litres, a.amount_paise as "amountPaise", a.reversed,
             t.litres::float8 as "billLitresNow"
        from erp_transport_allocations a
        join erp_transport_payments p on p.id = a.payment_id
        join erp_transports t on t.id = a.transport_id
       where p.trip_id in ${ids}
    `) as unknown as Promise<Row[]>,
  ]);
  const billsBy = new Map<string, TripBill[]>();
  for (const r of billRows) billsBy.set(String(r.tripId), [...(billsBy.get(String(r.tripId)) ?? []), bill(r)]);
  const sharesBy = new Map<string, Row[]>();
  for (const r of shareRows) sharesBy.set(String(r.paymentId), [...(sharesBy.get(String(r.paymentId)) ?? []), r]);
  const paysBy = new Map<string, { view: TripPayment; facts: PaymentFacts }[]>();
  for (const r of payRows) {
    const status = String(r.status) as TripPayment["status"];
    const mine = (sharesBy.get(String(r.id)) ?? []).filter((x) => (status === "reversed" ? true : !x.reversed));
    const facts: PaymentFacts = {
      status,
      amountPaise: Number(r.amount_paise),
      shares: mine.map((x) => ({ transportId: String(x.transportId), litres: Number(x.litres), amountPaise: Number(x.amountPaise), billLitresNow: n(x.billLitresNow) })),
    };
    const totalLitres = Math.round(facts.shares.reduce((a, x) => a + x.litres, 0) * 100) / 100;
    const view: TripPayment = {
      id: String(r.id),
      amountPaise: facts.amountPaise,
      paidOn: s(r.paid_on) ? String(r.paid_on).slice(0, 10) : null,
      paidTo: s(r.paid_to),
      reference: s(r.reference),
      scope: s(r.scope),
      note: s(r.note),
      status,
      recordedBy: s(r.recordedByName),
      recordedAt: iso(r.recorded_at)!,
      reversedBy: s(r.reversedByName),
      reversedAt: iso(r.reversed_at),
      reverseReason: s(r.reverse_reason),
      totalLitres,
      costPerLitrePaise: totalLitres > 0 ? facts.amountPaise / totalLitres : null,
      shares: facts.shares.map(({ transportId, litres, amountPaise }) => ({ transportId, litres, amountPaise })),
      reconcile: needsReconciling(facts),
    };
    paysBy.set(String(r.trip_id), [...(paysBy.get(String(r.trip_id)) ?? []), { view, facts }]);
  }
  return tripRows.map((r) => {
    const id = String(r.id);
    const bills = billsBy.get(id) ?? [];
    const pays = paysBy.get(id) ?? [];
    return {
      id,
      tripNo: Number(r.tripNo),
      tripDate: String(r.tripDate),
      vehicleNo: s(r.vehicleNo),
      driver: s(r.driver),
      transporter: s(r.transporter),
      note: s(r.note),
      bills,
      payments: pays.map((p) => p.view),
      totalLitres: Math.round(bills.reduce((a, b) => a + (b.litres ?? 0), 0) * 100) / 100,
      costStatus: tripCostStatus(
        pays.map((p) => p.facts),
        bills.map((b) => b.id),
      ),
      litresMissing: bills.some((b) => !b.litres || b.litres <= 0),
    };
  });
}

/** Bills on no trip, dispatched in the last `days`: the ones Logistics still has to put on a vehicle. */
export async function billsWithoutTrip(days = 30): Promise<TripBill[]> {
  const since = addDays(today(), -days);
  const rows = (await db.execute(sql`
    select ${BILL_COLS} ${BILL_FROM}
     where t.trip_id is null and coalesce(t.bill_date, (t.created_at at time zone ${APP_TIMEZONE})::date) >= ${since}::date
     order by t.bill_date desc nulls last, t.order_no desc
  `)) as unknown as Row[];
  return rows.map(bill);
}

/* ================================================================ writes */

export type TripInput = { id?: string | null; tripDate: string; vehicleNo?: string | null; driver?: string | null; transporter?: string | null; note?: string | null; transportIds?: string[] };

/** Bills that hold a live share of a transport payment, among these. */
async function allocatedAmong(tx: Exec, transportIds: string[]): Promise<Set<string>> {
  if (!transportIds.length) return new Set();
  const rows = (await tx.execute(sql`select transport_id as id from erp_transport_allocations where not reversed and transport_id in ${transportIds}`)) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

async function orderNoOf(tx: Exec, transportIds: string[]): Promise<Map<string, number>> {
  if (!transportIds.length) return new Map();
  const rows = (await tx.execute(sql`select id, order_no as "orderNo", trip_id as "tripId" from erp_transports where id in ${transportIds}`)) as unknown as { id: string; orderNo: number }[];
  return new Map(rows.map((r) => [r.id, Number(r.orderNo)]));
}

/** Create a trip, or edit one: the vehicle, driver, transporter, day and note — and, on create, the bills it carries. */
export async function saveTrip(ctx: ErpContext, input: TripInput): Promise<Result<{ id: string; tripNo: number }>> {
  const date = (input.tripDate ?? "").trim();
  if (!DAY.test(date)) return fieldErr("tripDate", "Pick the day of the trip");
  if (date > today()) return fieldErr("tripDate", "A trip cannot be in the future");
  const vehicle = clean(input.vehicleNo, 40);
  const values = { tripDate: date, vehicleNo: vehicle, driver: clean(input.driver), transporter: clean(input.transporter), note: clean(input.note, 500), updatedAt: new Date(), updatedById: ctx.user.id };
  if (input.id) {
    const [cur] = await db.select().from(erpTrips).where(inArray(erpTrips.id, [input.id]));
    if (!cur) return err("That trip no longer exists.", "not_found");
    await db.transaction(async (tx) => {
      await tx.update(erpTrips).set(values).where(inArray(erpTrips.id, [cur.id]));
      /* The vehicle travels with the trip: a bill on it carries its number. */
      if (vehicle && vehicleKey(vehicle) !== vehicleKey(cur.vehicleNo)) await tx.execute(sql`update erp_transports set vehicle_no = ${vehicle} where trip_id = ${cur.id}`);
    });
    await erpAudit(ctx, "erp.trip.edit", "erp_trip", cur.id, cur, values);
    return ok({ id: cur.id, tripNo: cur.tripNo }, `Trip ${cur.tripNo} saved`);
  }
  const ids = [...new Set(input.transportIds ?? [])];
  let made = { id: "", tripNo: 0 };
  const refused = await db.transaction(async (tx) => {
    const held = await allocatedAmong(tx, ids);
    if (held.size) return `${held.size} of those bills already carry a transport payment on another trip; reverse it first`;
    const id = erpId("etrip");
    const tripNo = await nextNumber(tx, "trip");
    await tx.insert(erpTrips).values({ id, tripNo, ...values, createdById: ctx.user.id });
    if (ids.length) {
      await tx.execute(sql`update erp_transports set trip_id = ${id}, vehicle_no = coalesce(${vehicle}, vehicle_no) where id in ${ids}`);
      await tripEvent(tx, ids, `On trip ${tripNo}${vehicle ? ` · vehicle ${vehicle}` : ""}`, ctx.user.id);
    }
    made = { id, tripNo };
    return null;
  });
  if (refused) return err(refused, "rule_violation");
  await erpAudit(ctx, "erp.trip.create", "erp_trip", made.id, null, { ...values, bills: ids });
  return ok(made, `Trip ${made.tripNo} created${ids.length ? ` · ${ids.length} bill${ids.length === 1 ? "" : "s"}` : ""}`);
}

/**
 * Put bills on a trip — from no trip, or moved from another. A bill holding a
 * live share of a transport payment stays where it is until that payment is
 * reversed: moving it would carry another trip's cost onto this one.
 */
export async function addToTrip(ctx: ErpContext, tripId: string, transportIds: string[]): Promise<Result<unknown>> {
  const ids = [...new Set(transportIds)];
  if (!ids.length) return err("Choose the bills to put on the trip.", "validation");
  const [trip] = await db.select().from(erpTrips).where(inArray(erpTrips.id, [tripId]));
  if (!trip) return err("That trip no longer exists.", "not_found");
  const refused = await db.transaction(async (tx) => {
    const nos = await orderNoOf(tx, ids);
    if (nos.size !== ids.length) return "A bill named is not a dispatched bill";
    const held = await allocatedAmong(tx, ids);
    if (held.size) return `Order ${[...held].map((id) => nos.get(id)).join(", ")} already carries a transport payment; reverse it first`;
    await tx.execute(sql`update erp_transports set trip_id = ${trip.id}, vehicle_no = coalesce(${trip.vehicleNo}, vehicle_no) where id in ${ids}`);
    await tripEvent(tx, ids, `Moved to trip ${trip.tripNo}${trip.vehicleNo ? ` · vehicle ${trip.vehicleNo}` : ""}`, ctx.user.id);
    return null;
  });
  if (refused) return err(refused, "rule_violation");
  await erpAudit(ctx, "erp.trip.addBills", "erp_trip", trip.id, null, { bills: ids });
  return okVoid(`${ids.length} bill${ids.length === 1 ? "" : "s"} on trip ${trip.tripNo}`);
}

/** Take a bill off its trip — refused while it carries a live share of the trip's payment. */
export async function removeFromTrip(ctx: ErpContext, transportId: string): Promise<Result<unknown>> {
  const [t] = await db.select({ id: erpTransports.id, tripId: erpTransports.tripId, orderNo: erpTransports.orderNo }).from(erpTransports).where(inArray(erpTransports.id, [transportId]));
  if (!t?.tripId) return err("That bill is on no trip.", "rule_violation");
  if ((await allocatedAmong(db, [t.id])).size) return err(`Order ${t.orderNo} carries a share of this trip's transport payment; reverse the payment first.`, "rule_violation");
  await db.transaction(async (tx) => {
    await tx.update(erpTransports).set({ tripId: null }).where(inArray(erpTransports.id, [t.id]));
    await tripEvent(tx, [t.id], "Taken off its trip", ctx.user.id);
  });
  await erpAudit(ctx, "erp.trip.removeBill", "erp_trip", t.tripId, { bill: t.id }, null);
  return okVoid(`Order ${t.orderNo} taken off the trip`);
}

export type PaymentInput = {
  tripId: string;
  amountPaise: number;
  paidOn?: string | null;
  paidTo?: string | null;
  reference?: string | null;
  scope?: string | null;
  note?: string | null;
  transportIds: string[];
};

/**
 * RECORD A CONFIRMED TRANSPORT PAYMENT AND SHARE IT OUT, in one transaction:
 * the amount once, against the trip, and a share on each chosen bill by its
 * dispatched litres. Refused where a bill is not on this trip, already carries
 * a share, or has no litres — each said by its order number, because the person
 * has to go and correct that bill.
 */
export async function recordTransportPayment(ctx: ErpContext, input: PaymentInput): Promise<Result<{ id: string }>> {
  const amount = Math.round(Number(input.amountPaise));
  if (!Number.isFinite(amount) || amount <= 0) return fieldErr("amount", "Enter the confirmed transport amount");
  const paidOn = (input.paidOn ?? "").trim() || null;
  if (paidOn && !DAY.test(paidOn)) return fieldErr("paidOn", "Pick a real date");
  if (paidOn && paidOn > today()) return fieldErr("paidOn", "The payment date cannot be in the future");
  const ids = [...new Set(input.transportIds ?? [])];
  if (!ids.length) return err("Tick the bills this payment covers.", "validation");
  let paymentId = "";
  let words = "";
  const refused = await db.transaction(async (tx) => {
    const [trip] = (await tx.execute(sql`select id, trip_no as "tripNo" from erp_trips where id = ${input.tripId} for update`)) as unknown as { id: string; tripNo: number }[];
    if (!trip) return "That trip no longer exists";
    const rows = (await tx.execute(sql`
      select id, order_no as "orderNo", trip_id as "tripId", litres::float8 as litres from erp_transports where id in ${ids} for update
    `)) as unknown as { id: string; orderNo: number; tripId: string | null; litres: number | null }[];
    if (rows.length !== ids.length) return "A bill named no longer exists";
    const off = rows.find((r) => r.tripId !== trip.id);
    if (off) return `Order ${off.orderNo} is not on trip ${trip.tripNo}; put it on the trip first`;
    const held = await allocatedAmong(tx, ids);
    if (held.size) return `Order ${rows.filter((r) => held.has(r.id)).map((r) => r.orderNo).join(", ")} already carries a transport payment — the same cost cannot be shared out twice`;
    /* A payment for part of a trip says which part, so the rest is not paid for again by accident. */
    const [{ onTrip }] = (await tx.execute(sql`select count(*)::int as "onTrip" from erp_transports where trip_id = ${trip.id}`)) as unknown as { onTrip: number }[];
    if (rows.length < Number(onTrip) && !clean(input.scope)) return "This payment covers only some of the trip's bills; say which part it covers";
    const noLitres = rows.find((r) => r.litres == null || !(Number(r.litres) > 0));
    if (noLitres) return `Order ${noLitres.orderNo} has no dispatched litres; correct its litres before sharing the cost`;
    const split = allocateByLitres(
      amount,
      rows.map((r) => ({ id: r.id, litres: Number(r.litres) })),
    );
    if (!split.ok) return split.reason;
    paymentId = erpId("etpay");
    await tx.insert(erpTransportPayments).values({
      id: paymentId,
      tripId: trip.id,
      amountPaise: amount,
      paidOn,
      paidTo: clean(input.paidTo),
      reference: clean(input.reference),
      scope: clean(input.scope, 300),
      note: clean(input.note, 500),
      status: "allocated",
      recordedById: ctx.user.id,
    });
    await tx.insert(erpTransportAllocations).values(split.rows.map((r) => ({ id: erpId("etal"), paymentId, transportId: r.id, litres: r.litres, amountPaise: r.amountPaise })));
    await tripEvent(tx, ids, `Transport payment of ₹${(amount / 100).toLocaleString("en-IN")} recorded on trip ${trip.tripNo}, shared by litres`, ctx.user.id);
    words = `₹${(amount / 100).toLocaleString("en-IN")} shared over ${rows.length} bill${rows.length === 1 ? "" : "s"} · ${split.totalLitres.toLocaleString("en-IN")} L`;
    return null;
  });
  if (refused) return err(refused, "rule_violation");
  await erpAudit(ctx, "erp.transportPayment.record", "erp_transport_payment", paymentId, null, { tripId: input.tripId, amountPaise: amount, bills: ids });
  return ok({ id: paymentId }, `Payment recorded · ${words}`);
}

/** Reverse a recorded payment: the row and its shares stay, marked reversed, and the bills are free to be shared again. */
export async function reverseTransportPayment(ctx: ErpContext, paymentId: string, reason: string): Promise<Result<unknown>> {
  const why = (reason ?? "").trim();
  if (why.length < 3) return fieldErr("reason", "Say why the payment is reversed");
  const [p] = await db.select().from(erpTransportPayments).where(inArray(erpTransportPayments.id, [paymentId]));
  if (!p) return err("That payment no longer exists.", "not_found");
  if (p.status === "reversed") return err("That payment is already reversed.", "rule_violation");
  await db.transaction(async (tx) => {
    await tx.update(erpTransportPayments).set({ status: "reversed", reversedById: ctx.user.id, reversedAt: new Date(), reverseReason: why }).where(inArray(erpTransportPayments.id, [p.id]));
    const shares = await tx.update(erpTransportAllocations).set({ reversed: true }).where(inArray(erpTransportAllocations.paymentId, [p.id])).returning({ transportId: erpTransportAllocations.transportId });
    await tripEvent(
      tx,
      shares.map((x) => x.transportId),
      `Transport payment of ₹${(p.amountPaise / 100).toLocaleString("en-IN")} reversed: ${why}`,
      ctx.user.id,
    );
  });
  await erpAudit(ctx, "erp.transportPayment.reverse", "erp_transport_payment", p.id, { status: p.status }, { status: "reversed", reason: why });
  return okVoid("Payment reversed · its bills can be shared again");
}
