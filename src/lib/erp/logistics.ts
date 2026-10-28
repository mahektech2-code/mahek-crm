import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, erpLrs, erpRefValues, erpTransportEvents, erpTransportMessages, erpTransporterContacts, erpTransporterGodowns, erpTransporters, erpTransports, places } from "@/db/schema";
import { checkGstin } from "@/lib/engines/lead-scan";
import { placeKey, type PlaceKind } from "@/lib/place-parse";
import { cleanGodowns, mirrorsFrom, type Godown, type GodownInput, type PlaceOption, type ResolvedRung } from "./transporter-godowns";
import { getConfig } from "@/lib/config/store";
import { APP_TIMEZONE } from "@/lib/business-date";
import { whatsappNumberFor } from "@/lib/customer-contacts";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import { waNumber } from "@/lib/whatsapp-delivery";
import type { ErpContext } from "./access";
import { bindErpFiles } from "./attachments";
import { lrReadingOn, settleLrReadings } from "./lr-upload-read";
import { syncBookOrders } from "./book";
import {
  addDays,
  attachRefusal,
  CLOSED,
  customerMessage,
  ISSUES,
  lrRowHasAnything,
  lrUploadName,
  phaseOf,
  rankForLr,
  ROAD_STAGES,
  stageStep,
  watiParams,
  type MessageFacts,
  type MessageKind,
  type Phase,
} from "./engines/logistics";
import { erpAudit, erpId } from "./server";
import { today } from "./screens/common";
import { confirmImpact } from "@/lib/impact/registry";
import { transporterMergeKey, transporterRenameKey } from "./transporter-keys";
import { knownTransporterName, rewriteName } from "./transporter-rename";
import type { ImpactConfirmation } from "@/lib/impact/types";

/* ---------------------------------------------------------------------------
 * THE LOGISTICS DESK, wired to the data. The rules are `engines/logistics.ts`;
 * this file reads the consignments, writes every step of the flow with an
 * event behind it, and tells the customer.
 *
 * A consignment is one BILL (`erp_transports`, opened when its first line is
 * dispatch-verified). Before its LR it is worked bill by bill; once an LR is
 * attached the LR is the physical consignment, and the board works it as one
 * — every update moves every bill under it.
 * ------------------------------------------------------------------------- */

export type Consignment = {
  id: string;
  orderNo: number;
  billNo: string | null;
  billDate: string | null;
  partyId: string;
  party: string;
  partyCity: string | null;
  deliveryPartyId: string;
  deliveryParty: string;
  area: string | null;
  godown: string | null;
  salesPerson: string | null;
  transporter: string | null;
  transporterPhone: string | null;
  transporterTrackUrl: string | null;
  paymentType: string | null;
  packages: number | null;
  litres: number | null;
  stage: string;
  phase: Phase;
  transportDueOn: string | null;
  atTransportAt: string | null;
  lrId: string | null;
  lrNo: string | null;
  lrDate: string | null;
  lrFileId: string | null;
  expectedDeliveryOn: string | null;
  nextCallOn: string | null;
  deliveredOn: string | null;
  receivedBy: string | null;
  /** Who pressed "Delivered" — the confirmation the PRD asks to be attributable. */
  deliveredBy: string | null;
  deliveryProof: string | null;
  /** The vehicle trip this bill went on, and the vehicle dispatch recorded (0285). */
  tripId: string | null;
  tripNo: number | null;
  vehicleNo: string | null;
  issue: string | null;
  issueNote: string | null;
  note: string | null;
  trackToken: string | null;
  lastEventAt: string | null;
  lastEventNote: string | null;
  messagesWaiting: number;
  updatedAt: string;
};

type Row = Record<string, unknown>;
const n = (v: unknown) => (v == null ? null : Number(v));
const s = (v: unknown) => (v == null ? null : String(v));

/**
 * Every consignment still being worked, and those delivered in the last
 * `deliveredDays`. One read, ordered newest bill first; the board splits it.
 */
export async function consignments(opts: { deliveredDays?: number; ids?: string[] } = {}): Promise<Consignment[]> {
  const since = addDays(today(), -(opts.deliveredDays ?? 45));
  const idFilter = opts.ids ? (opts.ids.length ? sql`and t.id in ${opts.ids}` : sql`and false`) : sql``;
  const rows = (await db.execute(sql`
    with o as (
      select o.order_no,
             min(o.delivery_customer_id) as delivery_id,
             min(g.name) as godown
        from erp_orders o
        left join erp_godowns g on g.id = o.godown_id
       group by o.order_no
    ), ev as (
      select distinct on (e.transport_id) e.transport_id, e.at, e.note
        from erp_transport_events e
       order by e.transport_id, e.at desc
    ), msg as (
      select unnest(m.transport_ids) as transport_id, count(*)::int as waiting
        from erp_transport_messages m
       where m.status in ('to_send', 'failed')
       group by 1
    )
    select t.id, t.order_no as "orderNo", t.bill_no as "billNo", t.bill_date::text as "billDate",
           t.billing_customer_id as "partyId", c.name as party, c.city as "partyCity",
           coalesce(o.delivery_id, t.billing_customer_id) as "deliveryPartyId",
           coalesce(dc.name, c.name) as "deliveryParty",
           t.area, o.godown, c.sales_person_name as "salesPerson",
           coalesce(t.transporter, l.transporter) as transporter,
           tr.phone as "transporterPhone", tr.tracking_url as "transporterTrackUrl",
           t.payment_type as "paymentType", t.packages, t.litres::float8 as litres,
           t.material_stage as stage, t.transport_due_on::text as "transportDueOn",
           t.at_transport_at as "atTransportAt", t.lr_id as "lrId", t.lr_no as "lrNo",
           l.lr_date::text as "lrDate", l.file_id as "lrFileId",
           t.expected_delivery_on::text as "expectedDeliveryOn", t.reminder_date::text as "nextCallOn",
           t.delivered_on::text as "deliveredOn", t.received_by as "receivedBy",
           du.name as "deliveredBy", t.delivery_proof as "deliveryProof",
           t.trip_id as "tripId", tp.trip_no as "tripNo", coalesce(t.vehicle_no, tp.vehicle_no) as "vehicleNo",
           t.issue, t.issue_note as "issueNote", t.note, t.track_token as "trackToken",
           ev.at as "lastEventAt", ev.note as "lastEventNote",
           coalesce(msg.waiting, 0) as "messagesWaiting", t.updated_at as "updatedAt"
      from erp_transports t
      join customers c on c.id = t.billing_customer_id
      left join o on o.order_no = t.order_no
      left join customers dc on dc.id = o.delivery_id
      left join erp_lrs l on l.id = t.lr_id
      left join users du on du.id = t.delivered_by_id
      left join erp_trips tp on tp.id = t.trip_id
      left join erp_transporters tr on lower(tr.name) = lower(coalesce(t.transporter, l.transporter)) and tr.active
      left join ev on ev.transport_id = t.id
      left join msg on msg.transport_id = t.id
     where ${opts.ids ? sql`true` : sql`(t.material_stage <> ${CLOSED} or coalesce(t.delivered_on, (t.updated_at at time zone ${APP_TIMEZONE})::date) >= ${since}::date)`}
       ${idFilter}
     order by t.bill_date desc nulls last, t.order_no desc
  `)) as unknown as Row[];
  return rows.map((r) => {
    const stage = String(r.stage);
    const lrNo = s(r.lrNo);
    return {
      id: String(r.id),
      orderNo: Number(r.orderNo),
      billNo: s(r.billNo),
      billDate: s(r.billDate),
      partyId: String(r.partyId),
      party: String(r.party),
      partyCity: s(r.partyCity),
      deliveryPartyId: String(r.deliveryPartyId),
      deliveryParty: String(r.deliveryParty),
      area: s(r.area),
      godown: s(r.godown),
      salesPerson: s(r.salesPerson),
      transporter: s(r.transporter),
      transporterPhone: s(r.transporterPhone),
      transporterTrackUrl: s(r.transporterTrackUrl),
      paymentType: s(r.paymentType),
      packages: n(r.packages),
      litres: n(r.litres),
      stage,
      phase: phaseOf({ lrNo, materialStage: stage }),
      transportDueOn: s(r.transportDueOn),
      atTransportAt: r.atTransportAt ? new Date(String(r.atTransportAt)).toISOString() : null,
      lrId: s(r.lrId),
      lrNo,
      lrDate: s(r.lrDate),
      lrFileId: s(r.lrFileId),
      expectedDeliveryOn: s(r.expectedDeliveryOn),
      nextCallOn: s(r.nextCallOn),
      deliveredOn: s(r.deliveredOn),
      receivedBy: s(r.receivedBy),
      deliveredBy: s(r.deliveredBy),
      deliveryProof: s(r.deliveryProof),
      tripId: s(r.tripId),
      tripNo: n(r.tripNo),
      vehicleNo: s(r.vehicleNo),
      issue: s(r.issue),
      issueNote: s(r.issueNote),
      note: s(r.note),
      trackToken: s(r.trackToken),
      lastEventAt: r.lastEventAt ? new Date(String(r.lastEventAt)).toISOString() : null,
      lastEventNote: s(r.lastEventNote),
      messagesWaiting: Number(r.messagesWaiting ?? 0),
      updatedAt: new Date(String(r.updatedAt)).toISOString(),
    };
  });
}

/** Every bill travelling under one LR. */
export async function consignmentsOnLr(lrId: string): Promise<Consignment[]> {
  const ids = (await db.select({ id: erpTransports.id }).from(erpTransports).where(eq(erpTransports.lrId, lrId))).map((r) => r.id);
  return consignments({ ids });
}

export type UploadedLr = {
  id: string;
  /** Null for an LR uploaded with only its photograph. */
  lrNo: string | null;
  lrDate: string | null;
  transporter: string | null;
  destination: string | null;
  packages: number | null;
  freightPaise: number | null;
  freightTerm: string | null;
  fileId: string | null;
  note: string | null;
  status: string;
  uploadedBy: string | null;
  uploadedAt: string;
  bills: number;
};

/** LRs the dispatch team uploaded: those waiting to be attached, and the latest attached ones. */
export async function uploadedLrs(opts: { status?: "unassigned" | "all" } = {}): Promise<UploadedLr[]> {
  const rows = (await db.execute(sql`
    select l.id, l.lr_no as "lrNo", l.lr_date::text as "lrDate", l.transporter, l.destination, l.packages,
           l.freight_paise as "freightPaise", l.freight_term as "freightTerm", l.file_id as "fileId", l.note, l.status,
           u.name as "uploadedBy", l.uploaded_at as "uploadedAt",
           (select count(*)::int from erp_transports t where t.lr_id = l.id) as bills
      from erp_lrs l
      left join users u on u.id = l.uploaded_by_id
     where ${opts.status === "all" ? sql`l.status <> 'void'` : sql`l.status = 'unassigned'`}
     order by l.uploaded_at desc
     limit 300
  `)) as unknown as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    lrNo: s(r.lrNo),
    lrDate: s(r.lrDate),
    transporter: s(r.transporter),
    destination: s(r.destination),
    packages: n(r.packages),
    freightPaise: n(r.freightPaise),
    freightTerm: s(r.freightTerm),
    fileId: s(r.fileId),
    note: s(r.note),
    status: String(r.status),
    uploadedBy: s(r.uploadedBy),
    uploadedAt: new Date(String(r.uploadedAt)).toISOString(),
    bills: Number(r.bills ?? 0),
  }));
}

/** For an LR on the desk, the waiting bills it most likely carries, best first. */
export function suggestBills(lr: UploadedLr, waiting: Consignment[]) {
  return rankForLr(
    lr,
    waiting.map((c) => ({ id: c.id, transporter: c.transporter, packages: c.packages, area: c.area ?? c.partyCity, party: c.deliveryParty, atTransport: c.phase === "lrPending" })),
  );
}

export type OutboxMessage = {
  id: string;
  customerId: string;
  customer: string;
  kind: string;
  phone: string | null;
  body: string;
  status: string;
  why: string | null;
  createdAt: string;
  sentAt: string | null;
  sentBy: string | null;
  createdBy: string | null;
  transportIds: string[];
  lrNo: string | null;
};

export async function messages(opts: { waitingOnly?: boolean; transportId?: string; limit?: number } = {}): Promise<OutboxMessage[]> {
  const rows = (await db.execute(sql`
    select m.id, m.customer_id as "customerId", c.name as customer, m.kind, m.phone, m.body, m.status, m.why,
           m.created_at as "createdAt", m.sent_at as "sentAt", su.name as "sentBy", cu.name as "createdBy",
           m.transport_ids as "transportIds", l.lr_no as "lrNo"
      from erp_transport_messages m
      join customers c on c.id = m.customer_id
      left join users su on su.id = m.sent_by_id
      left join users cu on cu.id = m.created_by_id
      left join erp_lrs l on l.id = m.lr_id
     where true
       ${opts.waitingOnly ? sql`and m.status in ('to_send', 'failed')` : sql``}
       ${opts.transportId ? sql`and ${opts.transportId} = any(m.transport_ids)` : sql``}
     order by m.created_at desc
     limit ${opts.limit ?? 300}
  `)) as unknown as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    customerId: String(r.customerId),
    customer: String(r.customer),
    kind: String(r.kind),
    phone: s(r.phone),
    body: String(r.body),
    status: String(r.status),
    why: s(r.why),
    createdAt: new Date(String(r.createdAt)).toISOString(),
    sentAt: r.sentAt ? new Date(String(r.sentAt)).toISOString() : null,
    sentBy: s(r.sentBy),
    createdBy: s(r.createdBy),
    transportIds: Array.isArray(r.transportIds) ? (r.transportIds as string[]) : [],
    lrNo: s(r.lrNo),
  }));
}

/** A godown as the screens draw it: its town and the people there. */
export type TransporterGodown = { id: string; label: string | null; placeId: string | null; gstin: string | null; address: string | null; lat: number | null; lng: number | null; contacts: { id: string; name: string | null; role: string | null; phones: string[] }[] };

/** A transporter, with its godowns in order and the people at each. */
export type Transporter = typeof erpTransporters.$inferSelect & { godowns: TransporterGodown[] };

/** What the Upload LRs modal lists under "Uploaded lately" — only what a row draws. */
export type RecentLr = Pick<UploadedLr, "id" | "lrNo" | "lrDate" | "transporter" | "destination" | "fileId" | "status" | "uploadedBy" | "bills">;

/** Everything the Upload LRs modal needs, read once by whichever desk opens it. */
export async function lrUploadKit(): Promise<{ transporters: string[]; recent: RecentLr[]; canRead: boolean }> {
  const [recent, dir, canRead] = await Promise.all([uploadedLrs({ status: "all" }), transporters(), lrReadingOn()]);
  return {
    transporters: dir.filter((t) => t.active).map((t) => t.name),
    canRead,
    recent: recent.slice(0, 25).map(({ id, lrNo, lrDate, transporter, destination, fileId, status, uploadedBy, bills }) => ({ id, lrNo, lrDate, transporter, destination, fileId, status, uploadedBy, bills })),
  };
}

export async function transporters(): Promise<Transporter[]> {
  const [rows, gds, people] = await Promise.all([
    db.select().from(erpTransporters).orderBy(desc(erpTransporters.active), sql`lower(${erpTransporters.name})`),
    db.select().from(erpTransporterGodowns).orderBy(erpTransporterGodowns.sortOrder, erpTransporterGodowns.createdAt),
    db.select().from(erpTransporterContacts).orderBy(erpTransporterContacts.sortOrder, erpTransporterContacts.createdAt),
  ]);
  const byGodown = new Map<string, TransporterGodown["contacts"]>();
  for (const c of people) byGodown.set(c.godownId, [...(byGodown.get(c.godownId) ?? []), { id: c.id, name: c.name, role: c.role, phones: c.phones }]);
  const byTransporter = new Map<string, TransporterGodown[]>();
  for (const g of gds)
    byTransporter.set(g.transporterId, [
      ...(byTransporter.get(g.transporterId) ?? []),
      { id: g.id, label: g.label, placeId: g.placeId, gstin: g.gstin, address: g.address, lat: g.lat, lng: g.lng, contacts: byGodown.get(g.id) ?? [] },
    ]);
  return rows.map((r) => ({ ...r, godowns: byTransporter.get(r.id) ?? [] }));
}

/** The whole reviewed place tree, for the godown picker. A few thousand rows of four columns. */
export async function placeOptions(): Promise<PlaceOption[]> {
  const rows = await db.select({ id: places.id, kind: places.kind, name: places.name, parentId: places.parentId }).from(places);
  return rows.map((r) => ({ ...r, kind: r.kind as PlaceKind }));
}

export type TransportEvent = { id: string; kind: string; stage: string | null; note: string | null; shared: boolean; at: string; by: string | null };

export async function eventsFor(transportIds: string[]): Promise<(TransportEvent & { transportId: string })[]> {
  if (!transportIds.length) return [];
  const rows = (await db.execute(sql`
    select e.id, e.transport_id as "transportId", e.kind, e.stage, e.note, e.shared, e.at, u.name as by
      from erp_transport_events e left join users u on u.id = e.by_id
     where e.transport_id in ${transportIds}
     order by e.at desc
  `)) as unknown as Row[];
  return rows.map((r) => ({ id: String(r.id), transportId: String(r.transportId), kind: String(r.kind), stage: s(r.stage), note: s(r.note), shared: Boolean(r.shared), at: new Date(String(r.at)).toISOString(), by: s(r.by) }));
}

/** The lines of a bill, for the consignment page: those that left on it, or — a row from before 0279 no line names — the whole order. */
export async function billLines(orderNo: number, transportId?: string) {
  const rows = (await db.execute(sql`
    select o.id, p.name as sku, o.qty_cans as cans, o.status, pk.box_type as "boxType", p.cans_per_box as "cansPerBox"
      from erp_orders o join products p on p.id = o.sku_id left join erp_product_packing pk on pk.product_id = p.id
      left join erp_order_details d on d.order_id = o.id
     where o.order_no = ${orderNo}
       ${
         transportId
           ? sql`and (d.transport_id = ${transportId}
                  or (d.transport_id is null and not exists (select 1 from erp_order_details d2 where d2.transport_id = ${transportId})))`
           : sql``
       }
     order by o.created_at
  `)) as unknown as Row[];
  return rows.map((r) => ({ id: String(r.id), sku: String(r.sku), cans: Number(r.cans), status: String(r.status), boxType: s(r.boxType), cansPerBox: n(r.cansPerBox) }));
}

/* ======================================================= writing the flow */

async function addEvent(tx: typeof db, ctx: ErpContext, transportIds: string[], kind: string, stage: string | null, note: string | null, shared = true): Promise<string> {
  const first = erpId("etev");
  await tx.insert(erpTransportEvents).values(
    transportIds.map((transportId, i) => ({ id: i === 0 ? first : erpId("etev"), transportId, kind, stage, note, shared, byId: ctx.user.id })),
  );
  return first;
}

async function load(ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(erpTransports).where(inArray(erpTransports.id, ids));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function day(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return DAY.test(t) ? t : null;
}

/**
 * Packages and litres a bill left as, read off its lines — written on every
 * consignment that has none, so the desk opens with a box count to confirm
 * rather than a blank. A figure somebody typed is never overwritten.
 */
export async function fillPackages(): Promise<void> {
  /* A consignment's lines are those placed on it (`transport_id`); a row from
     before 0279 that no line names is read off its whole order number. */
  await db.execute(sql`
    update erp_transports t
       set packages = x.packages, litres = x.litres
      from (
        select t2.id,
               sum(case when coalesce(pk.box_type, '') like 'Empty Box%' and coalesce(p.cans_per_box, 0) > 1
                        then ceil(o.qty_cans::numeric / p.cans_per_box) else o.qty_cans end)::int as packages,
               round(sum(o.qty_cans * coalesce(p.millilitres_per_can, 0))::numeric / 1000, 2) as litres
          from erp_transports t2
          join erp_orders o on o.order_no = t2.order_no and o.status <> 'Cancel'
          left join erp_order_details d on d.order_id = o.id
          join products p on p.id = o.sku_id
          left join erp_product_packing pk on pk.product_id = p.id
         where t2.packages is null
           and (d.transport_id = t2.id
                or (d.transport_id is null and not exists (select 1 from erp_order_details d2 where d2.transport_id = t2.id)))
         group by t2.id
      ) x
     where x.id = t.id and t.packages is null
  `);
  await db.execute(sql`update erp_transports set track_token = substr(md5(random()::text || id), 1, 20) where track_token is null`);
}

/**
 * A bill has just been dispatch-verified: its box count is read off its lines,
 * it gets its tracking link, and its timeline opens. Called after the verify
 * transaction, so it can never fail a dispatch.
 */
export async function afterDispatch(ctx: ErpContext, orderNos: number[]): Promise<void> {
  await afterDispatchFor(ctx.user.id, orderNos);
}

/** `afterDispatch` with no person behind it — the hourly net (`syncDispatchedTransports`) calls it. */
export async function afterDispatchFor(userId: string | null, orderNos: number[]): Promise<void> {
  if (!orderNos.length) return;
  await fillPackages();
  await db.execute(sql`
    insert into erp_transport_events (id, transport_id, kind, stage, note, by_id)
    select 'etev_' || substr(md5(random()::text || t.id), 1, 16), t.id, 'opened', 'Dispatched',
           coalesce('From ' || (select min(g.name) from erp_orders o join erp_godowns g on g.id = o.godown_id where o.order_no = t.order_no), null),
           ${userId}
      from erp_transports t
     where t.order_no in ${orderNos}
       and not exists (select 1 from erp_transport_events e where e.transport_id = t.id)
  `);
}

/** Step 1 — the day the goods should reach the transporter's godown. */
export async function setTransportDue(ctx: ErpContext, ids: string[], due: string): Promise<Result<unknown>> {
  const d = day(due);
  if (!d) return fieldErr("due", "Pick the day it reaches the transporter");
  const ts = (await load(ids)).filter((t) => phaseOf({ lrNo: t.lrNo, materialStage: t.materialStage }) === "toTransport");
  if (!ts.length) return err("None of these is still on its way to the transporter.", "rule_violation");
  await db.transaction(async (tx) => {
    await tx.update(erpTransports).set({ transportDueOn: d, updatedAt: new Date(), updatedById: ctx.user.id }).where(inArray(erpTransports.id, ts.map((t) => t.id)));
    await addEvent(tx as unknown as typeof db, ctx, ts.map((t) => t.id), "due", null, `Expected at the transporter ${d}`, false);
  });
  await erpAudit(ctx, "erp.logistics.due", "erp_transport", ts.map((t) => t.id).join(","), null, { due: d });
  return okVoid(`${ts.length} bill${ts.length === 1 ? "" : "s"} due at the transporter ${d === today() ? "today" : d === addDays(today(), 1) ? "tomorrow" : d}`);
}

/** Step 2 — the transporter has the goods; now the LR is owed. Boxes can be corrected in the same breath. */
export async function markAtTransport(ctx: ErpContext, ids: string[], packages?: Record<string, number | null>): Promise<Result<unknown>> {
  const ts = (await load(ids)).filter((t) => phaseOf({ lrNo: t.lrNo, materialStage: t.materialStage }) === "toTransport");
  if (!ts.length) return err("None of these is still on its way to the transporter.", "rule_violation");
  await db.transaction(async (tx) => {
    for (const t of ts) {
      const p = packages?.[t.id];
      await tx
        .update(erpTransports)
        .set({ materialStage: "At transport", atTransportAt: new Date(), ...(p != null && p >= 0 ? { packages: p } : {}), updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(erpTransports.id, t.id));
    }
    await addEvent(tx as unknown as typeof db, ctx, ts.map((t) => t.id), "at_transport", "At transport", null);
  });
  await erpAudit(ctx, "erp.logistics.atTransport", "erp_transport", ts.map((t) => t.id).join(","), null, { packages });
  await syncBookOrders([...new Set(ts.map((t) => t.orderNo))]);
  return okVoid(`${ts.length} bill${ts.length === 1 ? "" : "s"} at the transporter — waiting for the LR`);
}

export async function setPackages(ctx: ErpContext, id: string, packages: number | null): Promise<Result<unknown>> {
  if (packages != null && (!Number.isInteger(packages) || packages < 0 || packages > 100000)) return fieldErr("packages", "Boxes is a whole number");
  const [t] = await load([id]);
  if (!t) return err("That bill is not in logistics.", "not_found");
  await db.update(erpTransports).set({ packages, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpTransports.id, id));
  await erpAudit(ctx, "erp.logistics.packages", "erp_transport", id, { packages: t.packages }, { packages });
  return okVoid("Boxes saved");
}

/* ------------------------------------------------------------- the LRs */

export type LrInput = {
  lrNo?: string | null;
  lrDate?: string | null;
  transporter?: string | null;
  destination?: string | null;
  packages?: number | null;
  freightRupees?: number | null;
  freightTerm?: string | null;
  fileId?: string | null;
  note?: string | null;
  /** The photo reading that filled this row, if one did (`lr-upload-read.ts`). */
  readingId?: string | null;
};

export const FREIGHT_TERMS = ["Paid", "To pay", "TBB"];

/**
 * Step 3 — the dispatch team uploads the LRs it collected, several at once.
 * No field is required: a row with only a photograph is an LR whose number
 * logistics reads off it on the desk. A row with nothing in it is not an LR and
 * is skipped. Nothing is attached here: which bills an LR carries is
 * logistics' decision, and that is where the number becomes required.
 */
export async function uploadLrs(ctx: ErpContext, items: LrInput[]): Promise<Result<{ ids: string[] }>> {
  if (items.length > 50) return err("Upload up to 50 LRs at a time.", "validation");
  const clean = items
    .map((i, idx) => ({ ...i, idx, lrNo: (i.lrNo ?? "").trim().toUpperCase(), transporter: (i.transporter ?? "").trim() || null }))
    .filter((i) => lrRowHasAnything(i));
  if (!clean.length) return err("Fill in at least one LR — a photo is enough.", "validation");
  const bad = clean.find((i) => i.lrDate && !day(i.lrDate));
  if (bad) return fieldErr(`l${bad.idx + 1}.lrDate`, `Row ${bad.idx + 1}: the date is not a date`);
  const term = clean.find((i) => i.freightTerm && !FREIGHT_TERMS.includes(i.freightTerm));
  if (term) return fieldErr(`l${term.idx + 1}.freightTerm`, `Row ${term.idx + 1}: freight is Paid, To pay or TBB`);
  const key = (i: { transporter: string | null; lrNo: string }) => `${(i.transporter ?? "").toLowerCase()}|${i.lrNo}`;
  const seen = new Set<string>();
  for (const i of clean) {
    if (!i.lrNo) continue;
    if (seen.has(key(i))) return fieldErr(`l${i.idx + 1}.lrNo`, `Row ${i.idx + 1}: LR ${i.lrNo} is in this upload twice`);
    seen.add(key(i));
  }
  const numbered = clean.filter((i) => i.lrNo).map((i) => i.lrNo);
  const existing = numbered.length
    ? ((await db.execute(sql`select lr_no as "lrNo", transporter from erp_lrs where status <> 'void' and upper(lr_no) in ${numbered}`)) as unknown as { lrNo: string; transporter: string | null }[])
    : [];
  const dup = clean.find((i) => i.lrNo && existing.some((e) => key({ transporter: e.transporter, lrNo: e.lrNo.toUpperCase() }) === key(i)));
  if (dup) return fieldErr(`l${dup.idx + 1}.lrNo`, `Row ${dup.idx + 1}: LR ${dup.lrNo}${dup.transporter ? ` of ${dup.transporter}` : ""} is already uploaded`);
  const ids: string[] = [];
  const readings: { readingId: string; lrId: string; final: Record<string, unknown> }[] = [];
  await db.transaction(async (tx) => {
    for (const i of clean) {
      const id = erpId("elr");
      ids.push(id);
      if (i.readingId)
        readings.push({
          readingId: i.readingId,
          lrId: id,
          final: { lrNo: i.lrNo || null, lrDate: day(i.lrDate) ?? null, transporter: i.transporter, destination: (i.destination ?? "").trim() || null, packages: i.packages ?? null, freightTerm: i.freightTerm || null, freightRupees: i.freightRupees ?? null },
        });
      await tx.insert(erpLrs).values({
        id,
        lrNo: i.lrNo || null,
        lrDate: day(i.lrDate) ?? today(),
        transporter: i.transporter,
        destination: (i.destination ?? "").trim() || null,
        packages: i.packages != null && Number.isFinite(i.packages) ? Math.max(0, Math.trunc(i.packages)) : null,
        freightPaise: i.freightRupees != null && Number.isFinite(i.freightRupees) ? Math.round(i.freightRupees * 100) : null,
        freightTerm: i.freightTerm || null,
        fileId: i.fileId || null,
        godownId: ctx.workingGodown?.id ?? null,
        note: (i.note ?? "").trim() || null,
        uploadedById: ctx.user.id,
      });
      await bindErpFiles(tx as unknown as typeof db, [i.fileId], "erp_lr", id, ctx.actor.id);
      if (i.transporter) await tx.insert(erpTransporters).values({ id: erpId("etr"), name: i.transporter, updatedById: ctx.user.id }).onConflictDoNothing();
    }
  });
  /* How the photo readings fared — after the LRs are safe, and never at their cost. */
  await settleLrReadings(ctx, readings).catch((e) => console.error("LR upload: settling photo readings failed:", e instanceof Error ? e.message : e));
  await erpAudit(ctx, "erp.logistics.lrUpload", "erp_lr", ids.join(","), null, { lrs: clean.map((i) => i.lrNo || null) });
  return ok({ ids }, `${ids.length} LR${ids.length === 1 ? "" : "s"} uploaded — logistics will attach ${ids.length === 1 ? "it" : "them"} to the bills`);
}

export async function editLr(ctx: ErpContext, lrId: string, input: LrInput): Promise<Result<unknown>> {
  const [lr] = await db.select().from(erpLrs).where(eq(erpLrs.id, lrId));
  if (!lr || lr.status === "void") return err("That LR is not on the desk.", "not_found");
  const lrNo = (input.lrNo ?? "").trim().toUpperCase() || null;
  /* The bills under an attached LR carry its number, and the customer was told it. */
  if (!lrNo && lr.status === "assigned") return fieldErr("lrNo", "This LR is attached to bills, so it needs its number");
  const transporter = await knownTransporterName(db, input.transporter, ctx.user.id);
  const [dup] = lrNo
    ? ((await db.execute(sql`select id from erp_lrs where status <> 'void' and id <> ${lrId} and upper(lr_no) = ${lrNo} and lower(coalesce(transporter, '')) = ${(transporter ?? "").toLowerCase()}`)) as unknown as { id: string }[])
    : [];
  if (dup) return fieldErr("lrNo", `LR ${lrNo} is already on the desk`);
  const after = {
    lrNo,
    lrDate: day(input.lrDate) ?? lr.lrDate,
    transporter,
    destination: (input.destination ?? "").trim() || null,
    packages: input.packages ?? null,
    freightPaise: input.freightRupees != null ? Math.round(input.freightRupees * 100) : null,
    freightTerm: input.freightTerm || null,
    note: (input.note ?? "").trim() || null,
    ...(input.fileId ? { fileId: input.fileId } : {}),
  };
  await db.transaction(async (tx) => {
    await tx.update(erpLrs).set(after).where(eq(erpLrs.id, lrId));
    if (input.fileId) await bindErpFiles(tx as unknown as typeof db, [input.fileId], "erp_lr", lrId, ctx.actor.id);
    /* The bills under it carry its number as text — every reader of erp_transports reads that. */
    await tx.update(erpTransports).set({ lrNo, ...(transporter ? { transporter } : {}), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpTransports.lrId, lrId));
  });
  await erpAudit(ctx, "erp.logistics.lrEdit", "erp_lr", lrId, lr, after);
  return okVoid(lrNo ? `LR ${lrNo} saved` : "LR saved");
}

/**
 * A wrong upload is voided with its reason, never deleted — and only while it
 * carries nothing. The person saw what voiding it touches (`erp-lr-void`).
 */
export async function voidLr(ctx: ErpContext, lrId: string, reason: string, confirmation?: ImpactConfirmation | null): Promise<Result<unknown>> {
  const why = reason.trim();
  if (why.length < 3) return fieldErr("reason", "Say why this LR is being voided");
  const [lr] = await db.select().from(erpLrs).where(eq(erpLrs.id, lrId));
  if (!lr || lr.status === "void") return err("That LR is not on the desk.", "not_found");
  const [carrying] = await db.select({ id: erpTransports.id }).from(erpTransports).where(eq(erpTransports.lrId, lrId)).limit(1);
  if (carrying) return err("This LR is attached to bills. Take them off it first.", "rule_violation");
  const refusal = await confirmImpact("erp-lr-void", lrId, confirmation);
  if (refusal) return refusal;
  await db.update(erpLrs).set({ status: "void", voidReason: why }).where(eq(erpLrs.id, lrId));
  await erpAudit(ctx, "erp.logistics.lrVoid", "erp_lr", lrId, { status: lr.status }, { status: "void", reason: why });
  return okVoid(`${lrUploadName(lr.lrNo)} voided`);
}

/**
 * Step 4 — BIFURCATION: logistics says which bills an LR carries. The bills
 * go on the road, the next call to the transporter is booked, and the party is
 * told on WhatsApp with the LR number and the tracking link.
 */
export async function attachLr(
  ctx: ErpContext,
  lrId: string,
  transportIds: string[],
  opts: { expectedOn?: string | null; notify?: boolean; nextCallOn?: string | null } = {},
): Promise<Result<{ notified: NotifyOutcome }>> {
  const [lr] = await db.select().from(erpLrs).where(eq(erpLrs.id, lrId));
  if (!lr || lr.status === "void") return err("That LR is not on the desk.", "not_found");
  if (!lr.lrNo) return fieldErr("lrNo", "Type the LR number off the photo first (Edit) — the customer is told it.");
  const lrNo = lr.lrNo;
  const ts = await load([...new Set(transportIds)]);
  if (ts.length !== new Set(transportIds).size) return err("A bill you ticked is no longer in logistics. Refresh and try again.", "conflict");
  const delivery = await deliveryParties(ts.map((t) => t.orderNo));
  const refusal = attachRefusal(
    ts.map((t) => ({ id: t.id, orderNo: t.orderNo, deliveryPartyId: delivery.get(t.orderNo) ?? t.billingCustomerId, lrId: t.lrId, materialStage: t.materialStage })),
    lrId,
  );
  if (refusal) return err(refusal, "rule_violation");
  const expected = day(opts.expectedOn);
  if (opts.expectedOn && !expected) return fieldErr("expectedOn", "Expected delivery is not a date");
  if (expected && expected < (lr.lrDate ?? today())) return fieldErr("expectedOn", "Expected delivery cannot be before the LR date");
  const cfg = await getConfig();
  const nextCall = day(opts.nextCallOn) ?? addDays(today(), cfg["erp.logistics.callEveryDays"]);
  const fresh = ts.filter((t) => t.lrId !== lrId);
  if (!fresh.length) return err("These bills are already under this LR.", "conflict");
  let eventId = "";
  await db.transaction(async (tx) => {
    for (const t of fresh)
      await tx
        .update(erpTransports)
        .set({
          lrId,
          lrNo,
          transporter: lr.transporter ?? t.transporter,
          trackStatus: "Track",
          materialStage: stageStep(t.materialStage) < 2 ? "In Transit" : t.materialStage,
          atTransportAt: t.atTransportAt ?? new Date(),
          ...(expected ? { expectedDeliveryOn: expected } : {}),
          reminderDate: nextCall,
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(erpTransports.id, t.id));
    await tx.update(erpLrs).set({ status: "assigned", assignedById: ctx.user.id, assignedAt: new Date() }).where(eq(erpLrs.id, lrId));
    eventId = await addEvent(tx as unknown as typeof db, ctx, fresh.map((t) => t.id), "lr", "In Transit", `LR ${lrNo}${lr.transporter ? ` · ${lr.transporter}` : ""}`);
  });
  await erpAudit(ctx, "erp.logistics.lrAttach", "erp_lr", lrId, null, { lrNo, bills: fresh.map((t) => t.orderNo) });
  await syncBookOrders([...new Set(fresh.map((t) => t.orderNo))]);
  const notified = opts.notify === false ? NO_NOTIFY : await notifyCustomers(ctx, "lr", fresh.map((t) => t.id), eventId);
  return ok({ notified }, `LR ${lrNo} attached to ${fresh.length} bill${fresh.length === 1 ? "" : "s"}${notifyWords(notified)}`);
}

/** Taking a bill off an LR — the wrong bill was ticked. It goes back to waiting for its LR. */
export async function detachLr(ctx: ErpContext, transportId: string, reason: string): Promise<Result<unknown>> {
  const why = reason.trim();
  if (why.length < 3) return fieldErr("reason", "Say why it comes off this LR");
  const [t] = await load([transportId]);
  if (!t?.lrId) return err("That bill is not under an LR.", "rule_violation");
  if (t.materialStage === CLOSED) return err("A delivered bill keeps its LR.", "rule_violation");
  const lrId = t.lrId;
  await db.transaction(async (tx) => {
    await tx.update(erpTransports).set({ lrId: null, lrNo: null, trackStatus: "Don't Track", materialStage: "At transport", updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpTransports.id, t.id));
    const [still] = await tx.select({ id: erpTransports.id }).from(erpTransports).where(eq(erpTransports.lrId, lrId)).limit(1);
    if (!still) await tx.update(erpLrs).set({ status: "unassigned", assignedById: null, assignedAt: null }).where(eq(erpLrs.id, lrId));
    await addEvent(tx as unknown as typeof db, ctx, [t.id], "lr_removed", "At transport", `Taken off LR ${t.lrNo}: ${why}`, false);
  });
  await erpAudit(ctx, "erp.logistics.lrDetach", "erp_transport", t.id, { lrId, lrNo: t.lrNo }, { reason: why });
  await syncBookOrders([t.orderNo]);
  return okVoid(`Order ${t.orderNo} taken off LR ${t.lrNo}`);
}

/**
 * Step 5 — the transporter was called. A stage that moved is shared with the
 * customer (unless the person says not to); a call that moved nothing books
 * the next call and tells nobody.
 */
export async function updateConsignment(
  ctx: ErpContext,
  transportIds: string[],
  input: { stage?: string | null; note?: string | null; nextCallOn?: string | null; expectedOn?: string | null; notify?: boolean },
): Promise<Result<{ notified: NotifyOutcome }>> {
  const ts = (await load(transportIds)).filter((t) => t.materialStage !== CLOSED);
  if (!ts.length) return err("Nothing here is still on the road.", "rule_violation");
  const stage = input.stage?.trim() || null;
  if (stage && !ROAD_STAGES.includes(stage as never)) return fieldErr("stage", "Pick where the goods are");
  if (stage && ts.some((t) => !t.lrNo)) return err("A bill with no LR is moved by attaching its LR on the LR desk.", "rule_violation");
  const expected = day(input.expectedOn);
  if (input.expectedOn && !expected) return fieldErr("expectedOn", "Expected delivery is not a date");
  const nextIn = day(input.nextCallOn);
  if (input.nextCallOn && !nextIn) return fieldErr("nextCallOn", "The next call is not a date");
  if (nextIn && nextIn < today()) return fieldErr("nextCallOn", "The next call cannot be in the past");
  const note = input.note?.trim() || null;
  const cfg = await getConfig();
  const nextCall = nextIn ?? addDays(today(), cfg["erp.logistics.callEveryDays"]);
  const moved = stage ? ts.filter((t) => t.materialStage !== stage) : [];
  const expectedMoved = expected ? ts.filter((t) => t.expectedDeliveryOn !== expected) : [];
  let eventId = "";
  await db.transaction(async (tx) => {
    await tx
      .update(erpTransports)
      .set({ ...(stage ? { materialStage: stage } : {}), ...(expected ? { expectedDeliveryOn: expected } : {}), reminderDate: nextCall, ...(note ? { note } : {}), updatedAt: new Date(), updatedById: ctx.user.id })
      .where(inArray(erpTransports.id, ts.map((t) => t.id)));
    eventId = await addEvent(
      tx as unknown as typeof db,
      ctx,
      ts.map((t) => t.id),
      moved.length ? "stage" : "call",
      stage ?? ts[0].materialStage,
      [note, expected && expectedMoved.length ? `Expected ${expected}` : null].filter(Boolean).join(" · ") || null,
      moved.length > 0 || expectedMoved.length > 0,
    );
  });
  await erpAudit(ctx, "erp.logistics.update", "erp_transport", ts.map((t) => t.id).join(","), null, { stage, note, nextCall, expected });
  if (moved.length) await syncBookOrders([...new Set(moved.map((t) => t.orderNo))]);
  const tell = (moved.length > 0 || expectedMoved.length > 0) && input.notify !== false;
  const notified = tell ? await notifyCustomers(ctx, "stage", ts.map((t) => t.id), eventId, { note }) : NO_NOTIFY;
  return ok({ notified }, `${moved.length ? "Status updated" : "Call logged"} · next call ${nextCall}${notifyWords(notified)}`);
}

export async function raiseIssue(
  ctx: ErpContext,
  transportIds: string[],
  input: { issue: string; note?: string | null; expectedOn?: string | null; notify?: boolean },
): Promise<Result<{ notified: NotifyOutcome }>> {
  if (!(ISSUES as readonly string[]).includes(input.issue)) return fieldErr("issue", "Pick what went wrong");
  const note = input.note?.trim() || null;
  if (input.issue === "Other" && !note) return fieldErr("note", "Say what the problem is");
  const ts = (await load(transportIds)).filter((t) => t.materialStage !== CLOSED);
  if (!ts.length) return err("Nothing here is still on the road.", "rule_violation");
  const expected = day(input.expectedOn);
  let eventId = "";
  await db.transaction(async (tx) => {
    await tx
      .update(erpTransports)
      .set({ issue: input.issue, issueNote: note, issueAt: new Date(), ...(expected ? { expectedDeliveryOn: expected } : {}), reminderDate: today(), updatedAt: new Date(), updatedById: ctx.user.id })
      .where(inArray(erpTransports.id, ts.map((t) => t.id)));
    eventId = await addEvent(tx as unknown as typeof db, ctx, ts.map((t) => t.id), "issue", ts[0].materialStage, `${input.issue}${note ? `: ${note}` : ""}`, input.notify !== false);
  });
  await erpAudit(ctx, "erp.logistics.issue", "erp_transport", ts.map((t) => t.id).join(","), null, input);
  const notified = input.notify === false ? NO_NOTIFY : await notifyCustomers(ctx, "issue", ts.map((t) => t.id), eventId, { issue: input.issue, issueNote: note });
  return ok({ notified }, `Problem recorded${notifyWords(notified)}`);
}

export async function clearIssue(ctx: ErpContext, transportIds: string[], note: string): Promise<Result<unknown>> {
  const ts = (await load(transportIds)).filter((t) => t.issue);
  if (!ts.length) return err("There is no open problem on these.", "rule_violation");
  const said = note.trim() || null;
  await db.transaction(async (tx) => {
    await tx.update(erpTransports).set({ issue: null, issueNote: null, issueAt: null, updatedAt: new Date(), updatedById: ctx.user.id }).where(inArray(erpTransports.id, ts.map((t) => t.id)));
    await addEvent(tx as unknown as typeof db, ctx, ts.map((t) => t.id), "issue_cleared", ts[0].materialStage, `${ts[0].issue} cleared${said ? `: ${said}` : ""}`, false);
  });
  await erpAudit(ctx, "erp.logistics.issueCleared", "erp_transport", ts.map((t) => t.id).join(","), null, { note: said });
  return okVoid("Problem cleared");
}

/**
 * Step 6 — the party has the goods. Closing needs the day; who signed and a
 * proof or reference are asked, not demanded. Who CONFIRMED it is the person
 * pressing the button, recorded on the bill (PRD step 12) — nothing else ever
 * closes a bill, so an unconfirmed delivery stays open or carries an exception.
 */
export async function markDelivered(
  ctx: ErpContext,
  transportIds: string[],
  input: { date: string; receivedBy?: string | null; proof?: string | null; note?: string | null; notify?: boolean },
): Promise<Result<{ notified: NotifyOutcome }>> {
  const d = day(input.date);
  if (!d) return fieldErr("date", "Pick the day the party received it");
  if (d > today()) return fieldErr("date", "Delivery cannot be in the future");
  const ts = (await load(transportIds)).filter((t) => t.materialStage !== CLOSED);
  if (!ts.length) return err("These are already delivered.", "rule_violation");
  const early = ts.find((t) => t.billDate && d < t.billDate);
  if (early) return fieldErr("date", `Order ${early.orderNo} left on ${early.billDate}; it cannot arrive before that`);
  const receivedBy = input.receivedBy?.trim() || null;
  const proof = input.proof?.trim().slice(0, 200) || null;
  const note = input.note?.trim() || null;
  let eventId = "";
  await db.transaction(async (tx) => {
    await tx
      .update(erpTransports)
      .set({ materialStage: CLOSED, trackStatus: "Don't Track", deliveredOn: d, receivedBy, deliveredById: ctx.user.id, deliveryProof: proof, issue: null, issueNote: null, issueAt: null, reminderDate: null, ...(note ? { note } : {}), updatedAt: new Date(), updatedById: ctx.user.id })
      .where(inArray(erpTransports.id, ts.map((t) => t.id)));
    eventId = await addEvent(tx as unknown as typeof db, ctx, ts.map((t) => t.id), "delivered", CLOSED, [receivedBy ? `Received by ${receivedBy}` : null, proof ? `Proof: ${proof}` : null, note].filter(Boolean).join(" · ") || null);
  });
  await erpAudit(ctx, "erp.logistics.delivered", "erp_transport", ts.map((t) => t.id).join(","), null, { date: d, receivedBy, proof });
  await syncBookOrders([...new Set(ts.map((t) => t.orderNo))]);
  const notified = input.notify === false ? NO_NOTIFY : await notifyCustomers(ctx, "delivered", ts.map((t) => t.id), eventId, { deliveredOn: d, receivedBy });
  return ok({ notified }, `Delivered and closed${notifyWords(notified)}`);
}

/**
 * Closed by mistake: back on the road (or back to waiting for its LR), with
 * the reason. It undoes somebody's confirmed delivery and the order book's
 * "delivered", so it is confirmed against what it touches (`erp-delivery-reopen`).
 */
export async function reopen(ctx: ErpContext, transportId: string, reason: string, confirmation?: ImpactConfirmation | null): Promise<Result<unknown>> {
  const why = reason.trim();
  if (why.length < 3) return fieldErr("reason", "Say why it is being reopened");
  const [t] = await load([transportId]);
  if (!t || t.materialStage !== CLOSED) return err("That bill is not closed.", "rule_violation");
  const refusal = await confirmImpact("erp-delivery-reopen", transportId, confirmation);
  if (refusal) return refusal;
  const stage = t.lrNo ? "Reached Destination Area" : "At transport";
  await db.transaction(async (tx) => {
    await tx.update(erpTransports).set({ materialStage: stage, trackStatus: t.lrNo ? "Track" : "Don't Track", deliveredOn: null, receivedBy: null, deliveredById: null, deliveryProof: null, reminderDate: today(), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpTransports.id, t.id));
    await addEvent(tx as unknown as typeof db, ctx, [t.id], "reopened", stage, why, false);
  });
  await erpAudit(ctx, "erp.logistics.reopen", "erp_transport", t.id, { stage: CLOSED }, { stage, reason: why });
  await syncBookOrders([t.orderNo]);
  return okVoid(`Order ${t.orderNo} reopened`);
}

/* ---------------------------------------------------------- transporters */

export async function saveTransporter(
  ctx: ErpContext,
  input: {
    id?: string | null;
    name: string;
    gstin?: string | null;
    /** What they call the consignment number. A name not on the list yet is added to it. */
    consignmentLabel?: string | null;
    /** The godowns, each with its people, in order — replaced whole. Absent leaves them as they are. */
    godowns?: GodownInput[];
    trackingUrl?: string | null;
    active?: boolean;
    /** A rename rewrites the name on every bill, LR and order carrying it, so it is confirmed (`erp-transporter-rename`). */
    confirmation?: ImpactConfirmation | null;
  },
): Promise<Result<unknown>> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) return fieldErr("name", "Name is required");
  const url = input.trackingUrl?.trim() || null;
  if (url && !/^https?:\/\//.test(url)) return fieldErr("trackingUrl", "The tracking page starts with https://");
  const g = checkGstin(input.gstin);
  if (g && g.check === "invalid") return fieldErr("gstin", "That GST number does not check out — it is 15 characters, like 27ABCDE1234F1Z5");
  const gstin = g?.gstin ?? null;
  const [clash] = (await db.execute(sql`select id from erp_transporters where lower(name) = ${name.toLowerCase()} and id <> ${input.id ?? ""}`)) as unknown as { id: string }[];
  if (clash) return fieldErr("name", `${name} is already in the list — use Merge into… on this transporter to fold the two together`);
  let godowns: Godown[] | null = null;
  if (input.godowns) {
    const c = cleanGodowns(input.godowns, await placeOptions());
    if (!c.ok) return fieldErr(c.field, c.message);
    godowns = c.godowns;
  }
  const consignmentLabel = await consignmentLabelFor(ctx, input.consignmentLabel);
  const values = {
    name,
    gstin,
    consignmentLabel,
    ...(godowns ? mirrorsFrom(godowns) : {}),
    trackingUrl: url,
    active: input.active ?? true,
    updatedAt: new Date(),
    updatedById: ctx.user.id,
  };
  const id = input.id ?? erpId("etr");
  if (input.id) {
    const [before] = await db.select().from(erpTransporters).where(eq(erpTransporters.id, input.id));
    if (!before) return err("That transporter is gone.", "not_found");
    const beforeGodowns = (await transporters()).find((t) => t.id === id)?.godowns ?? [];
    const renamed = before.name !== name;
    if (renamed) {
      const refusal = await confirmImpact("erp-transporter-rename", transporterRenameKey(id, name), input.confirmation);
      if (refusal) return refusal;
    }
    let rewritten: Record<string, number> = {};
    await db.transaction(async (tx) => {
      await tx.update(erpTransporters).set(values).where(eq(erpTransporters.id, id));
      if (godowns) await writeGodowns(tx, id, godowns);
      if (renamed) rewritten = await rewriteName(tx, before.name, name);
    });
    await erpAudit(ctx, "erp.logistics.transporter", "erp_transporter", id, { ...before, godowns: beforeGodowns }, { ...values, godowns, ...(renamed ? { renamedFrom: before.name, rewritten } : {}) });
    if (renamed) {
      const n = Object.values(rewritten).reduce((a, b) => a + b, 0);
      return okVoid(`${before.name} renamed to ${name}${n ? ` on ${n} record${n === 1 ? "" : "s"}` : ""}`);
    }
  } else {
    await db.transaction(async (tx) => {
      await tx.insert(erpTransporters).values({ id, ...values });
      if (godowns) await writeGodowns(tx, id, godowns);
    });
    await erpAudit(ctx, "erp.logistics.transporter", "erp_transporter", id, null, { ...values, godowns });
  }
  return okVoid(`${name} saved`);
}

/**
 * Two rows for one company — "V.R.L." beside "VRL Logistics" — folded into
 * the one being kept: every bill, LR and order carrying the dropped spelling
 * is rewritten to the kept one, the dropped row's godowns and people move
 * across, and the dropped row goes. Confirmed against what it touches
 * (`erp-transporter-merge`), because it cannot be undone by renaming back —
 * after it, nothing remembers which records carried which spelling.
 */
export async function mergeTransporter(ctx: ErpContext, fromId: string, intoId: string, confirmation?: ImpactConfirmation | null): Promise<Result<unknown>> {
  if (!fromId || !intoId || fromId === intoId) return err("Pick a different transporter to merge into.", "validation");
  const [from] = await db.select().from(erpTransporters).where(eq(erpTransporters.id, fromId));
  const [into] = await db.select().from(erpTransporters).where(eq(erpTransporters.id, intoId));
  if (!from || !into) return err("That transporter is gone.", "not_found");
  const refusal = await confirmImpact("erp-transporter-merge", transporterMergeKey(fromId, intoId), confirmation);
  if (refusal) return refusal;
  let rewritten: Record<string, number> = {};
  await db.transaction(async (tx) => {
    rewritten = await rewriteName(tx, from.name, into.name);
    const [{ n }] = (await tx.execute(sql`select coalesce(max(sort_order), -1)::int as n from erp_transporter_godowns where transporter_id = ${intoId}`)) as unknown as { n: number }[];
    await tx.execute(sql`update erp_transporter_godowns set transporter_id = ${intoId}, sort_order = sort_order + ${Number(n) + 1} where transporter_id = ${fromId}`);
    /* What the kept row did not say, the dropped one may have. */
    await tx
      .update(erpTransporters)
      .set({
        gstin: into.gstin ?? from.gstin,
        consignmentLabel: into.consignmentLabel ?? from.consignmentLabel,
        trackingUrl: into.trackingUrl ?? from.trackingUrl,
        active: into.active || from.active,
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      })
      .where(eq(erpTransporters.id, intoId));
    await tx.delete(erpTransporters).where(eq(erpTransporters.id, fromId));
  });
  const kept = (await transporters()).find((t) => t.id === intoId);
  if (kept) await db.update(erpTransporters).set(mirrorsFrom(kept.godowns)).where(eq(erpTransporters.id, intoId));
  await erpAudit(ctx, "erp.logistics.transporterMerge", "erp_transporter", intoId, { merged: from }, { into: into.name, rewritten });
  const total = Object.values(rewritten).reduce((a, b) => a + b, 0);
  return okVoid(`${from.name} merged into ${into.name}${total ? ` — ${total} record${total === 1 ? "" : "s"} now say ${into.name}` : ""}`);
}

/**
 * The name as the list spells it, adding it to the list when it is new — so a
 * "GC No." typed on one transporter is offered to the next one.
 */
async function consignmentLabelFor(ctx: ErpContext, raw: string | null | undefined): Promise<string | null> {
  const label = raw?.trim().replace(/\s+/g, " ") ?? "";
  if (!label) return null;
  const list = await db.select().from(erpRefValues).where(eq(erpRefValues.listKey, "consignmentLabel"));
  const same = list.find((r) => r.value.toLowerCase() === label.toLowerCase());
  if (same) {
    if (!same.active) await db.update(erpRefValues).set({ active: true }).where(eq(erpRefValues.id, same.id));
    return same.value;
  }
  const sortOrder = Math.max(0, ...list.map((r) => r.sortOrder)) + 1;
  await db.insert(erpRefValues).values({ id: erpId("erprv"), listKey: "consignmentLabel", value: label, sortOrder, createdById: ctx.user.id }).onConflictDoNothing();
  return label;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The godowns and their people replaced whole, keeping each row's id where the
 * form sent one back: a godown taken off the form is a godown taken off the list.
 */
async function writeGodowns(tx: Tx, transporterId: string, godowns: Godown[]) {
  /* An id is kept only where it was this transporter's own — a posted id from
     somewhere else gets a fresh one rather than colliding with its owner. */
  const mine = await tx.select({ id: erpTransporterGodowns.id }).from(erpTransporterGodowns).where(eq(erpTransporterGodowns.transporterId, transporterId));
  const ownGodowns = new Set(mine.map((r) => r.id));
  const ownPeople = new Set(
    ownGodowns.size
      ? (await tx.select({ id: erpTransporterContacts.id }).from(erpTransporterContacts).where(inArray(erpTransporterContacts.godownId, [...ownGodowns]))).map((r) => r.id)
      : [],
  );
  await tx.delete(erpTransporterGodowns).where(eq(erpTransporterGodowns.transporterId, transporterId));
  const usedPeople = new Set<string>();
  for (const [gi, g] of godowns.entries()) {
    const godownId = g.id && ownGodowns.has(g.id) ? (ownGodowns.delete(g.id), g.id) : erpId("etg");
    const placeId = await placeFor(tx, g.place);
    await tx.insert(erpTransporterGodowns).values({ id: godownId, transporterId, label: g.label, placeId, gstin: g.gstin, address: g.address, lat: g.lat, lng: g.lng, sortOrder: gi });
    if (g.contacts.length)
      await tx.insert(erpTransporterContacts).values(
        g.contacts.map((c, ci) => ({ id: c.id && ownPeople.has(c.id) && !usedPeople.has(c.id) ? (usedPeople.add(c.id), c.id) : erpId("etc"), godownId, name: c.name, role: c.role, phones: c.phones, sortOrder: ci })),
      );
  }
}

/**
 * The area a godown is filed under, adding the rungs somebody typed because
 * they were not listed. Each is looked for under its parent first — another
 * save may have added it a moment ago — and a race between two inserts is
 * settled by the unique index rather than by a second copy.
 */
async function placeFor(tx: Tx, rungs: ResolvedRung[]): Promise<string | null> {
  let parentId: string | null = null;
  for (const r of rungs) {
    if (r.id) {
      parentId = r.id;
      continue;
    }
    const key = placeKey(r.name);
    const find = async () =>
      ((await tx.execute(sql`select id from places where kind = ${r.kind} and key = ${key} and parent_id is not distinct from ${parentId} limit 1`)) as unknown as { id: string }[])[0]?.id;
    let id = await find();
    if (!id) {
      await tx.execute(sql`insert into places (id, kind, name, key, parent_id, shops) values (${`pl_${randomUUID().slice(0, 12)}`}, ${r.kind}, ${r.name}, ${key}, ${parentId}, 0) on conflict do nothing`);
      id = await find();
    }
    parentId = id ?? null;
  }
  return parentId;
}

/* ===================================================== telling the customer */

export type NotifyOutcome = { sent: number; toSend: number; skipped: number; failed: number; off: boolean };
const NO_NOTIFY: NotifyOutcome = { sent: 0, toSend: 0, skipped: 0, failed: 0, off: false };

function notifyWords(o: NotifyOutcome): string {
  if (o.off) return "";
  const parts = [o.sent ? `${o.sent} WhatsApp sent` : null, o.toSend + o.failed ? `${o.toSend + o.failed} to send by hand` : null, o.skipped ? `${o.skipped} customer${o.skipped === 1 ? "" : "s"} cannot be messaged` : null].filter(Boolean);
  return parts.length ? ` · ${parts.join(", ")}` : "";
}

async function deliveryParties(orderNos: number[]): Promise<Map<number, string>> {
  if (!orderNos.length) return new Map();
  const rows = (await db.execute(sql`select order_no as n, min(delivery_customer_id) as d from erp_orders where order_no in ${orderNos} group by order_no`)) as unknown as { n: number; d: string | null }[];
  return new Map(rows.filter((r) => r.d).map((r) => [Number(r.n), String(r.d)]));
}

/** The address the customer's tracking link is built against. */
async function origin(): Promise<string | null> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  try {
    const { appOrigin } = await import("@/lib/password-reset");
    return await appOrigin();
  } catch {
    return null;
  }
}

/**
 * Writes the customer's WhatsApp for one step of the flow and sends it where
 * it can. One message per party per step: an LR carrying three bills is one
 * message naming three bills. The billing party is told, and the delivery
 * party too where it is somebody else.
 *
 * It goes through Wati only where every condition holds — the founder's switch
 * on, a key, a template named in `erp.logistics.watiTemplate` that is APPROVED
 * and asks for nothing this cannot fill. Anything else waits on the Customer
 * messages tab with the reason, to be sent by hand. A customer marked do not
 * contact, on WhatsApp DND, with no mobile, or carrying a staff member's
 * number is recorded as skipped and says why — never silently dropped.
 */
export async function notifyCustomers(
  ctx: ErpContext,
  kind: MessageKind,
  transportIds: string[],
  eventId: string | null,
  extra: Partial<MessageFacts> = {},
): Promise<NotifyOutcome> {
  const cfg = await getConfig();
  if (!cfg["erp.logistics.notifyCustomers"]) return { ...NO_NOTIFY, off: true };
  const ts = await load(transportIds);
  if (!ts.length) return NO_NOTIFY;
  const delivery = await deliveryParties(ts.map((t) => t.orderNo));
  const lrIds = [...new Set(ts.map((t) => t.lrId).filter((x): x is string => !!x))];
  const lrs = lrIds.length ? await db.select().from(erpLrs).where(inArray(erpLrs.id, lrIds)) : [];
  const recipients = new Map<string, typeof ts>();
  for (const t of ts) {
    for (const cid of new Set([t.billingCustomerId, delivery.get(t.orderNo) ?? t.billingCustomerId])) recipients.set(cid, [...(recipients.get(cid) ?? []), t]);
  }
  const people = await db.select().from(customers).where(inArray(customers.id, [...recipients.keys()]));
  const staff = (await db.execute(sql`select right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) as p from users where coalesce(phone, '') <> ''`)) as unknown as { p: string }[];
  const staffNumbers = new Set(staff.map((x) => x.p));
  const base = await origin();
  const route = await watiRoute(cfg["erp.logistics.watiTemplate"]);
  const out: NotifyOutcome = { ...NO_NOTIFY };

  for (const c of people) {
    const mine = recipients.get(c.id)!;
    const first = mine[0];
    const lr = lrs.find((l) => l.id === first.lrId) ?? null;
    const facts: MessageFacts = {
      party: c.name,
      bills: mine.map((t) => t.billNo ?? `order ${t.orderNo}`),
      lrNo: first.lrNo,
      lrDate: lr?.lrDate ?? null,
      transporter: first.transporter ?? lr?.transporter ?? null,
      packages: mine.every((t) => t.packages != null) ? mine.reduce((a, t) => a + (t.packages ?? 0), 0) : (lr?.packages ?? null),
      stage: first.materialStage,
      expectedOn: first.expectedDeliveryOn,
      trackUrl: base && first.trackToken ? `${base}/track/${first.trackToken}` : null,
      signature: cfg["erp.logistics.signature"] || "Mahek Marketing India",
      ...extra,
    };
    const body = customerMessage(kind, facts);
    const raw = whatsappNumberFor(c, "general");
    const phone = waNumber(raw);
    const skip = c.doNotContact
      ? `${c.name} is marked do not contact.`
      : c.whatsappDnd
        ? `${c.name} is on WhatsApp DND.`
        : c.deletedAt
          ? `${c.name} is in the trash.`
          : !phone
            ? `${raw || "No number"} is not a mobile WhatsApp can reach. Fix it on the customer record.`
            : staffNumbers.has(phone.slice(-10))
              ? "That number belongs to somebody who works at Mahek, not to the customer."
              : null;
    const id = erpId("etmsg");
    const row = { id, customerId: c.id, transportIds: mine.map((t) => t.id), lrId: first.lrId, eventId, kind, phone: phone ?? raw ?? null, body, createdById: ctx.user.id };
    if (skip) {
      await db.insert(erpTransportMessages).values({ ...row, status: "skipped", why: skip });
      out.skipped++;
      continue;
    }
    if (!route.ok) {
      await db.insert(erpTransportMessages).values({ ...row, status: "to_send", why: route.why });
      out.toSend++;
      continue;
    }
    const params = watiParams(kind, facts, body);
    const missing = route.params.filter((p) => !(p in params));
    if (missing.length) {
      await db.insert(erpTransportMessages).values({ ...row, status: "to_send", why: `The Wati template asks for ${missing.join(", ")}, which logistics cannot fill.` });
      out.toSend++;
      continue;
    }
    await db.insert(erpTransportMessages).values({ ...row, status: "to_send", why: "Sending through Wati…" });
    const { sendWatiTemplate } = await import("@/lib/wati");
    const sent = await sendWatiTemplate({ templateName: route.name, phone: phone!, params: route.params.map((name) => ({ name, value: params[name] || "-" })), localMessageId: id, broadcastName: `logistics_${kind}_${today()}` });
    if (sent.ok) {
      await db.update(erpTransportMessages).set({ status: "sent", why: null, providerRef: sent.broadcastId, sentAt: new Date(), sentById: ctx.user.id }).where(eq(erpTransportMessages.id, id));
      out.sent++;
    } else {
      await db.update(erpTransportMessages).set({ status: "failed", why: sent.uncertain ? `Wati did not answer — check Wati before sending again. ${sent.error}` : sent.error }).where(eq(erpTransportMessages.id, id));
      out.failed++;
    }
  }
  return out;
}

type WatiRoute = { ok: true; name: string; params: string[] } | { ok: false; why: string };

async function watiRoute(templateName: string): Promise<WatiRoute> {
  const name = (templateName ?? "").trim();
  if (!name) return { ok: false, why: "No logistics template is named in ERP settings, so this goes by hand." };
  const { whatsappServiceState } = await import("@/lib/services/whatsapp-switch-service");
  if (!(await whatsappServiceState()).active) return { ok: false, why: "WhatsApp through Wati is switched off on the Founder Dashboard." };
  const { listWatiTemplates, isApproved, watiConfig } = await import("@/lib/wati");
  if (!(await watiConfig())) return { ok: false, why: "No Wati key is configured." };
  const list = await listWatiTemplates();
  if (!list.ok) return { ok: false, why: `Wati could not be asked for its templates: ${list.error}` };
  const t = list.templates.find((x) => x.name === name);
  if (!t) return { ok: false, why: `There is no Wati template called ${name}.` };
  if (!isApproved(t)) return { ok: false, why: `The Wati template ${name} is not approved yet.` };
  return { ok: true, name, params: t.params };
}

/** A message somebody sent from their own WhatsApp: marked so, with who. */
export async function markMessageSent(ctx: ErpContext, messageId: string): Promise<Result<unknown>> {
  const [m] = await db.select().from(erpTransportMessages).where(eq(erpTransportMessages.id, messageId));
  if (!m) return err("That message is gone.", "not_found");
  if (!["to_send", "failed"].includes(m.status)) return err("That message is not waiting to be sent.", "conflict");
  await db.update(erpTransportMessages).set({ status: "sent_by_hand", sentAt: new Date(), sentById: ctx.user.id }).where(eq(erpTransportMessages.id, messageId));
  await erpAudit(ctx, "erp.logistics.messageSent", "erp_transport_message", messageId, { status: m.status }, { status: "sent_by_hand" });
  return okVoid("Marked as sent");
}

export async function skipMessage(ctx: ErpContext, messageId: string): Promise<Result<unknown>> {
  const [m] = await db.select().from(erpTransportMessages).where(eq(erpTransportMessages.id, messageId));
  if (!m) return err("That message is gone.", "not_found");
  if (!["to_send", "failed"].includes(m.status)) return err("That message is not waiting to be sent.", "conflict");
  await db.update(erpTransportMessages).set({ status: "skipped", why: `Not sent — decided by ${ctx.user.name}` }).where(eq(erpTransportMessages.id, messageId));
  await erpAudit(ctx, "erp.logistics.messageSkipped", "erp_transport_message", messageId, { status: m.status }, { status: "skipped" });
  return okVoid("Will not be sent");
}

/** A failed or waiting message tried through Wati again, now the reason may have cleared. */
export async function retryMessage(ctx: ErpContext, messageId: string): Promise<Result<unknown>> {
  const [m] = await db.select().from(erpTransportMessages).where(eq(erpTransportMessages.id, messageId));
  if (!m) return err("That message is gone.", "not_found");
  if (!["to_send", "failed"].includes(m.status)) return err("That message is not waiting to be sent.", "conflict");
  const cfg = await getConfig();
  const route = await watiRoute(cfg["erp.logistics.watiTemplate"]);
  if (!route.ok) return err(route.why, "rule_violation");
  if (route.params.some((p) => p !== "message" && p !== "name" && p !== "party")) return err("This template needs the facts of the step; it can only be retried for templates that take {{message}}. Send it by hand.", "rule_violation");
  const phone = waNumber(m.phone);
  if (!phone) return err("The number on this message is not a WhatsApp mobile.", "validation");
  const [c] = await db.select({ name: customers.name }).from(customers).where(eq(customers.id, m.customerId));
  const values: Record<string, string> = { message: m.body.replace(/\s*\n+\s*/g, " ").trim(), name: c?.name ?? "", party: c?.name ?? "" };
  const { sendWatiTemplate } = await import("@/lib/wati");
  const sent = await sendWatiTemplate({ templateName: route.name, phone, params: route.params.map((name) => ({ name, value: values[name] || "-" })), localMessageId: m.id, broadcastName: `logistics_retry_${today()}` });
  if (!sent.ok) {
    await db.update(erpTransportMessages).set({ status: "failed", why: sent.error }).where(eq(erpTransportMessages.id, m.id));
    return err(sent.error, "rule_violation");
  }
  await db.update(erpTransportMessages).set({ status: "sent", why: null, providerRef: sent.broadcastId, sentAt: new Date(), sentById: ctx.user.id }).where(eq(erpTransportMessages.id, m.id));
  return okVoid("Sent through Wati");
}

/**
 * Wati's delivery ticks for a logistics message. Wati echoes our id back as
 * `local_message_id`; the CRM's handler asks this when the id is not one of
 * its own. Status only moves forward.
 */
export async function applyLogisticsWatiEvent(localMessageId: string, kind: "sent" | "delivered" | "read" | "failed", reason?: string | null): Promise<string | null> {
  const [m] = await db.select().from(erpTransportMessages).where(eq(erpTransportMessages.id, localMessageId));
  if (!m) return null;
  const rank: Record<string, number> = { to_send: 0, failed: 0, sent: 1, sent_by_hand: 1, delivered: 2, read: 3, skipped: -1 };
  const now = new Date();
  if (kind === "failed") {
    if (m.status === "delivered" || m.status === "read") return `logistics ${m.status} kept`;
    await db.update(erpTransportMessages).set({ status: "failed", why: reason ?? "WhatsApp reported the message failed." }).where(eq(erpTransportMessages.id, m.id));
    return "logistics -> failed";
  }
  if ((rank[kind] ?? 0) <= (rank[m.status] ?? 0)) return `logistics ${kind} ignored at ${m.status}`;
  await db
    .update(erpTransportMessages)
    .set({ status: kind, ...(kind === "delivered" ? { deliveredAt: now } : {}), ...(kind === "read" ? { readAt: now, deliveredAt: m.deliveredAt ?? now } : {}) })
    .where(eq(erpTransportMessages.id, m.id));
  return `logistics ${m.status} -> ${kind}`;
}

/* ========================================================== the public link */

export type PublicTracking = {
  party: string;
  bills: { billNo: string | null; orderNo: number; billDate: string | null }[];
  lrNo: string | null;
  lrDate: string | null;
  transporter: string | null;
  transporterTrackUrl: string | null;
  packages: number | null;
  stage: string;
  expectedOn: string | null;
  deliveredOn: string | null;
  receivedBy: string | null;
  issue: string | null;
  events: { at: string; kind: string; stage: string | null; note: string | null }[];
};

/**
 * What the customer's tracking link shows: the bill, the LR, where the goods
 * are and the steps shared with them. Nothing internal — no call notes, no
 * prices, no names of staff — because the link travels in a WhatsApp anybody
 * can forward.
 */
export async function publicTracking(token: string): Promise<PublicTracking | null> {
  if (!/^[a-z0-9]{12,40}$/i.test(token)) return null;
  const [t] = await db.select().from(erpTransports).where(eq(erpTransports.trackToken, token));
  if (!t) return null;
  const siblings = t.lrId ? await db.select().from(erpTransports).where(eq(erpTransports.lrId, t.lrId)) : [t];
  const mine = siblings.filter((x) => x.billingCustomerId === t.billingCustomerId);
  const [c] = await db.select({ name: customers.name }).from(customers).where(eq(customers.id, t.billingCustomerId));
  const [lr] = t.lrId ? await db.select().from(erpLrs).where(eq(erpLrs.id, t.lrId)) : [];
  const transporterName = t.transporter ?? lr?.transporter ?? null;
  const [tr] = transporterName ? await db.select().from(erpTransporters).where(sql`lower(${erpTransporters.name}) = ${transporterName.toLowerCase()}`) : [];
  const evs = (await db
    .select({ at: erpTransportEvents.at, kind: erpTransportEvents.kind, stage: erpTransportEvents.stage, note: erpTransportEvents.note })
    .from(erpTransportEvents)
    .where(and(eq(erpTransportEvents.transportId, t.id), eq(erpTransportEvents.shared, true)))
    .orderBy(desc(erpTransportEvents.at))) as { at: Date; kind: string; stage: string | null; note: string | null }[];
  const { trackingLink } = await import("./engines/logistics");
  return {
    party: c?.name ?? "",
    bills: mine.map((x) => ({ billNo: x.billNo, orderNo: x.orderNo, billDate: x.billDate })),
    lrNo: t.lrNo,
    lrDate: lr?.lrDate ?? null,
    transporter: transporterName,
    transporterTrackUrl: trackingLink(tr?.trackingUrl, t.lrNo),
    packages: mine.every((x) => x.packages != null) ? mine.reduce((a, x) => a + (x.packages ?? 0), 0) : null,
    stage: t.materialStage,
    expectedOn: t.expectedDeliveryOn,
    deliveredOn: t.deliveredOn,
    receivedBy: t.receivedBy,
    issue: t.issue,
    /* An issue note or a call note can say things about a transporter that
       are not for a customer; the public page names the step, and the note
       only where the step is a delivery. */
    events: evs.map((e) => ({ at: e.at.toISOString(), kind: e.kind, stage: e.stage, note: e.kind === "delivered" || e.kind === "lr" ? e.note : null })),
  };
}

/** Fresh tokens are 20 hex characters, like the migration's. */
export function newTrackToken(): string {
  return randomBytes(10).toString("hex");
}
