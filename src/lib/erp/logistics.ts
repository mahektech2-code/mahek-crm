import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, erpLrs, erpRefValues, erpTransportEvents, erpTransportMessages, erpTransporterContacts, erpTransporterGodowns, erpTransporters, erpTransports } from "@/db/schema";
import { checkGstin } from "@/lib/engines/lead-scan";
import { cleanGodowns, mirrorsFrom, type Godown, type GodownInput, type ResolvedRung } from "./transporter-godowns";
import { getConfig } from "@/lib/config/store";
import { placeIdsFor, placeOptions } from "@/lib/services/place-write";
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
  cleanCities,
  cleanPlace,
  CLOSED,
  isMahekVehicle,
  isProofKind,
  MAHEK_VEHICLE,
  type ProofKind,
  customerMessage,
  ISSUES,
  lrRowHasAnything,
  lrUploadName,
  phaseOf,
  rankForLr,
  ROAD_STAGES,
  shortDay,
  stageStep,
  watiParams,
  type MessageFacts,
  type MessageKind,
  type Phase,
} from "./engines/logistics";
import { erpAudit, erpId } from "./server";
import { messageOrigin, skipReason, staffNumbers as readStaffNumbers, watiRoute } from "./customer-messaging";
import { today } from "./screens/common";
import { confirmImpact } from "@/lib/impact/registry";
import { transporterMergeKey, transporterRenameKey } from "./transporter-keys";
import { listedTransporterName, rewriteName } from "./transporter-rename";
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
  /** Delivered in our own vehicle (0301): no LR; a customer-signed copy closes it. */
  ownVehicle: boolean;
  /** The driver dispatch recorded, for the call button on a Mahek Vehicle card. */
  driver: string | null;
  signedCopyId: string | null;
  signedCopyFileId: string | null;
  issue: string | null;
  issueNote: string | null;
  note: string | null;
  trackToken: string | null;
  lastEventAt: string | null;
  lastEventNote: string | null;
  /** 0296 — the route: where it left from, the cities reached (oldest first), where it is going, and where to collect it. */
  dispatchedFrom: string | null;
  currentCity: string | null;
  /** Where it is going: what logistics set, else the LR's own destination. */
  destination: string | null;
  lrDestination: string | null;
  pickupPoint: string | null;
  pickupContact: string | null;
  route: RouteStop[];
  messagesWaiting: number;
  updatedAt: string;
};

/** One place on an LR's way: the godown it left from, or a city it reached. */
export type RouteStop = { kind: "dispatched" | "checkpoint"; city: string; at: string };

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
           coalesce(tp.driver, (select min(d.driver) from erp_order_details d where d.transport_id = t.id)) as driver,
           t.signed_copy_id as "signedCopyId", sc.file_id as "signedCopyFileId",
           t.issue, t.issue_note as "issueNote", t.note, t.track_token as "trackToken",
           ev.at as "lastEventAt", ev.note as "lastEventNote",
           t.dispatched_from as "dispatchedFrom", t.current_city as "currentCity",
           coalesce(t.destination, l.destination) as destination, l.destination as "lrDestination",
           t.pickup_point as "pickupPoint", t.pickup_contact as "pickupContact",
           /* The godown it left from is the one recorded now: a corrected godown replaces the old one rather than adding a second start. */
           coalesce((select json_agg(json_build_object('kind', e.kind, 'city', e.city, 'at', e.at) order by e.at)
                       from erp_transport_events e where e.transport_id = t.id and e.city is not null and (e.kind = 'checkpoint' or e.id = (select min(d.id) from erp_transport_events d where d.transport_id = t.id and d.kind = 'dispatched' and d.city = t.dispatched_from))), '[]'::json) as route,
           coalesce(msg.waiting, 0) as "messagesWaiting", t.updated_at as "updatedAt"
      from erp_transports t
      join customers c on c.id = t.billing_customer_id
      left join o on o.order_no = t.order_no
      left join customers dc on dc.id = o.delivery_id
      left join erp_lrs l on l.id = t.lr_id
      left join erp_lrs sc on sc.id = t.signed_copy_id
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
    const transporter = s(r.transporter);
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
      transporter,
      transporterPhone: s(r.transporterPhone),
      transporterTrackUrl: s(r.transporterTrackUrl),
      paymentType: s(r.paymentType),
      packages: n(r.packages),
      litres: n(r.litres),
      stage,
      phase: phaseOf({ lrNo, materialStage: stage, transporter }),
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
      ownVehicle: isMahekVehicle(transporter),
      driver: s(r.driver),
      signedCopyId: s(r.signedCopyId),
      signedCopyFileId: s(r.signedCopyFileId),
      issue: s(r.issue),
      issueNote: s(r.issueNote),
      note: s(r.note),
      trackToken: s(r.trackToken),
      lastEventAt: r.lastEventAt ? new Date(String(r.lastEventAt)).toISOString() : null,
      lastEventNote: s(r.lastEventNote),
      dispatchedFrom: s(r.dispatchedFrom),
      currentCity: s(r.currentCity),
      destination: s(r.destination),
      lrDestination: s(r.lrDestination),
      pickupPoint: s(r.pickupPoint),
      pickupContact: s(r.pickupContact),
      route: ((Array.isArray(r.route) ? r.route : []) as { kind: string; city: string; at: string }[]).map((e) => ({ kind: e.kind === "dispatched" ? "dispatched" : "checkpoint", city: String(e.city), at: new Date(String(e.at)).toISOString() })),
      messagesWaiting: Number(r.messagesWaiting ?? 0),
      updatedAt: new Date(String(r.updatedAt)).toISOString(),
    };
  });
}

/**
 * What the route fields offer while somebody types (0296): each transporter's
 * own godowns and booking offices by town, Mahek's godowns, and the cities
 * already reported or written on an LR in the last six months — so "Pune" is
 * picked rather than spelt four ways. Suggestions only: anything typed is kept.
 */
export type RoutePlace = { value: string; hint: string | null };
export type RouteSuggestions = { godownsByTransporter: Record<string, RoutePlace[]>; ourGodowns: RoutePlace[]; cities: string[] };

export async function routeSuggestions(): Promise<RouteSuggestions> {
  const since = addDays(today(), -180);
  const [tg, ours, cities] = await Promise.all([
    db.execute(sql`
      select lower(tr.name) as transporter, nullif(trim(g.label), '') as label, p.name as town
        from erp_transporter_godowns g
        join erp_transporters tr on tr.id = g.transporter_id and tr.active
        left join places p on p.id = g.place_id
       order by tr.name, g.sort_order
    `),
    db.execute(sql`select name, city from erp_godowns where status = 'active' and not reserved order by name`),
    db.execute(sql`
      select city from (
        select initcap(trim(e.city)) as city, count(*) as n from erp_transport_events e where e.city is not null and e.kind = 'checkpoint' and e.at >= ${since}::date group by 1
        union all
        select initcap(trim(l.destination)), count(*) from erp_lrs l where l.destination is not null and l.uploaded_at >= ${since}::date group by 1
      ) x where city <> '' group by city order by sum(n) desc, city limit 300
    `),
  ]);
  /* A godown is offered by its town — what a transporter says on the phone — with its own name beside it. */
  const godownsByTransporter: Record<string, RoutePlace[]> = {};
  for (const r of tg as unknown as { transporter: string; label: string | null; town: string | null }[]) {
    const value = r.town ?? r.label;
    if (!value) continue;
    (godownsByTransporter[r.transporter] ??= []).push({ value, hint: r.town && r.label ? r.label : null });
  }
  return {
    godownsByTransporter,
    ourGodowns: (ours as unknown as { name: string; city: string | null }[]).map((g) => ({ value: g.name, hint: g.city && g.city !== g.name ? `${g.city} · Mahek` : "Mahek godown" })),
    cities: (cities as unknown as { city: string }[]).map((c) => c.city),
  };
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
  /* ---- 0301: delivery proof ---- */
  kind: ProofKind;
  readLrNo: string | null;
  readKind: string | null;
  /** When the photo was read; null while it waits to be read (or reading is off). */
  readAt: string | null;
  billHint: string | null;
  partyHint: string | null;
  receivedBy: string | null;
  deliveredOn: string | null;
  contentHash: string | null;
  dupClearedAt: string | null;
  /** Where it was uploaded from: the factory phone, or a laptop. */
  fromPhone: boolean;
};

/**
 * Delivery proof on the desk: LRs (and signed copies) waiting to be attached —
 * or, with `all`, the latest attached ones too, which the duplicate check
 * compares against. `kind` narrows to one kind.
 */
export async function uploadedLrs(opts: { status?: "unassigned" | "all"; kind?: ProofKind; recentDays?: number; id?: string } = {}): Promise<UploadedLr[]> {
  const rows = (await db.execute(sql`
    select l.id, l.lr_no as "lrNo", l.lr_date::text as "lrDate", l.transporter, l.destination, l.packages,
           l.freight_paise as "freightPaise", l.freight_term as "freightTerm", l.file_id as "fileId", l.note, l.status,
           u.name as "uploadedBy", l.uploaded_at as "uploadedAt",
           (select count(*)::int from erp_transports t where t.lr_id = l.id or t.signed_copy_id = l.id) as bills,
           l.kind, l.read_lr_no as "readLrNo", l.read_kind as "readKind", l.read_at as "readAt",
           l.bill_hint as "billHint", l.party_hint as "partyHint", l.received_by as "receivedBy", l.delivered_on::text as "deliveredOn",
           a.content_hash as "contentHash", l.dup_cleared_at as "dupClearedAt",
           exists (select 1 from factory_staff f where f.user_id = l.uploaded_by_id) as "fromPhone"
      from erp_lrs l
      left join users u on u.id = l.uploaded_by_id
      left join attachments a on a.id = l.file_id
     where ${opts.status === "all" ? sql`l.status <> 'void'` : sql`l.status = 'unassigned'`}
       ${opts.kind ? sql`and l.kind = ${opts.kind}` : sql``}
       ${opts.id ? sql`and l.id = ${opts.id}` : sql``}
       ${opts.recentDays ? sql`and (l.status = 'unassigned' or l.uploaded_at >= now() - make_interval(days => ${opts.recentDays}::int))` : sql``}
     order by l.uploaded_at desc
     limit ${opts.recentDays ? 1500 : 300}
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
    kind: isProofKind(r.kind) ? r.kind : "lr",
    readLrNo: s(r.readLrNo),
    readKind: s(r.readKind),
    readAt: r.readAt ? new Date(String(r.readAt)).toISOString() : null,
    billHint: s(r.billHint),
    partyHint: s(r.partyHint),
    receivedBy: s(r.receivedBy),
    deliveredOn: s(r.deliveredOn),
    contentHash: s(r.contentHash),
    dupClearedAt: r.dupClearedAt ? new Date(String(r.dupClearedAt)).toISOString() : null,
    fromPhone: r.fromPhone === true,
  }));
}

/** One LR as the desk reads it, attached or not — what the On the road card's Edit opens. */
export async function lrForEdit(id: string): Promise<UploadedLr | null> {
  return (await uploadedLrs({ status: "all", id }))[0] ?? null;
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

/** The whole reviewed place tree, for the godown picker. */
export { placeOptions };

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

async function addEvent(tx: typeof db, ctx: ErpContext, transportIds: string[], kind: string, stage: string | null, note: string | null, shared = true, where: { city?: string | null; at?: Date } = {}): Promise<string> {
  const first = erpId("etev");
  await tx.insert(erpTransportEvents).values(
    transportIds.map((transportId, i) => ({ id: i === 0 ? first : erpId("etev"), transportId, kind, stage, note, shared, byId: ctx.user.id, city: where.city ?? null, ...(where.at ? { at: where.at } : {}) })),
  );
  return first;
}

/** The moment a city was reached, from the day it was reported for: now when it is today, else midday of that day in IST. */
function reachedAt(on: string): Date {
  return on === today() ? new Date() : new Date(`${on}T12:00:00+05:30`);
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
  /* The consignment's first line is written now; the customer's page shows it left. */
  await (await import("./order-tracking")).syncOrderTracking(orderNos, { userId });
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
  /** lr (default) | signed_copy. */
  kind?: ProofKind | null;
  /** A signed copy: who signed, the day on it, and the bill and party stamped on it. */
  receivedBy?: string | null;
  deliveredOn?: string | null;
  billHint?: string | null;
  partyHint?: string | null;
};

export const FREIGHT_TERMS = ["Paid", "To pay", "TBB"];

/**
 * Step 3 — the dispatch team uploads the LRs it collected, several at once.
 * No field is required: a row with only a photograph is an LR whose number
 * logistics reads off it on the desk. A row with nothing in it is not an LR and
 * is skipped. Nothing is attached here: which bills an LR carries is
 * logistics' decision, and that is where the number becomes required.
 */
/** A photo sent again: which file, the copy already holding those bytes, and that copy said in words. */
export type RepeatedUpload = { fileId: string; lrId: string; what: string };

/**
 * "Already on the desk" with nothing after it reads as a failure, and the
 * person sends the same photo again — six times in a row on 2026-10-30. So a
 * repeat says WHICH copy it already is and where that copy went: its number,
 * and the order and customer it is attached to, or that it is waiting on the
 * Documents desk.
 */
async function describeRepeats(dupFile: Map<string, string>): Promise<RepeatedUpload[]> {
  if (!dupFile.size) return [];
  const lrIds = [...new Set(dupFile.values())];
  const rows = (await db.execute(sql`
    select l.id, l.lr_no as "lrNo", l.kind, l.transporter,
           (select string_agg(t.order_no::text || coalesce(' · ' || c.name, ''), ', ' order by t.order_no)
              from erp_transports t left join customers c on c.id = t.billing_customer_id
             where t.lr_id = l.id or t.signed_copy_id = l.id) as "attachedTo"
      from erp_lrs l
     where l.id in ${lrIds}`)) as unknown as { id: string; lrNo: string | null; kind: string; transporter: string | null; attachedTo: string | null }[];
  const said = new Map(
    rows.map((r) => {
      const copy = r.kind === "signed_copy" ? "a signed copy" : r.lrNo ? `LR ${r.lrNo}${r.transporter ? ` of ${r.transporter}` : ""}` : "an LR not read yet";
      return [r.id, `already uploaded as ${copy}, ${r.attachedTo ? `attached to order ${r.attachedTo}` : "waiting on the Documents desk"}`];
    }),
  );
  return [...dupFile].map(([fileId, lrId]) => ({ fileId, lrId, what: said.get(lrId) ?? "already uploaded" }));
}

export async function uploadLrs(ctx: ErpContext, items: LrInput[]): Promise<Result<{ ids: string[]; already: string[]; repeats: RepeatedUpload[] }>> {
  if (items.length > 50) return err("Upload up to 50 LRs at a time.", "validation");
  const bad0 = items.find((i) => i.kind != null && !isProofKind(i.kind));
  if (bad0) return err("Upload an LR or a signed copy.", "validation");
  let clean = items
    .map((i, idx) => ({ ...i, idx, kind: (i.kind ?? "lr") as ProofKind, lrNo: (i.kind === "signed_copy" ? "" : (i.lrNo ?? "").trim().toUpperCase()), transporter: (i.kind === "signed_copy" ? null : (i.transporter ?? "").trim() || null) }))
    .filter((i) => lrRowHasAnything(i));
  /* THE SAME PHOTO TWICE IS STORED ONCE, silently: a photo whose bytes are already on a live copy
     answers with that copy and writes nothing. Two photos of one paper differ in their bytes and
     reach the desk, which flags them for a person. */
  const already: string[] = [];
  let repeats: RepeatedUpload[] = [];
  const files = clean.map((i) => i.fileId).filter((f): f is string => !!f);
  if (files.length) {
    const hits = (await db.execute(sql`
      select a.id as "fileId", (select l.id from erp_lrs l join attachments b on b.id = l.file_id
                                  where l.status <> 'void' and b.content_hash = a.content_hash limit 1) as "lrId"
        from attachments a
       where a.id in ${files} and a.content_hash is not null`)) as unknown as { fileId: string; lrId: string | null }[];
    const dupFile = new Map(hits.filter((h) => h.lrId).map((h) => [h.fileId, h.lrId!]));
    /* And the same bytes twice in one upload: the first one goes. */
    const firstOf = new Map<string, string>();
    const hashes = files.length ? ((await db.execute(sql`select id, content_hash as h from attachments where id in ${files}`)) as unknown as { id: string; h: string | null }[]) : [];
    for (const f of files) {
      const h = hashes.find((x) => x.id === f)?.h;
      if (h && !firstOf.has(h)) firstOf.set(h, f);
    }
    clean = clean.filter((i) => {
      if (!i.fileId) return true;
      const old = dupFile.get(i.fileId);
      if (old) return void already.push(old), false;
      const h = hashes.find((x) => x.id === i.fileId)?.h;
      return !h || firstOf.get(h) === i.fileId;
    });
    repeats = await describeRepeats(dupFile);
    if (!clean.length && already.length)
      return ok({ ids: [], already: [...new Set(already)], repeats }, repeats.length === 1 ? `Nothing new sent — this photo is ${repeats[0].what}` : `Nothing new sent — all ${repeats.length} photos were uploaded before`);
  }
  if (!clean.length) return err("Fill in at least one LR — a photo is enough.", "validation");
  const bad = clean.find((i) => i.lrDate && !day(i.lrDate));
  if (bad) return fieldErr(`l${bad.idx + 1}.lrDate`, `Row ${bad.idx + 1}: the date is not a date`);
  const term = clean.find((i) => i.freightTerm && !FREIGHT_TERMS.includes(i.freightTerm));
  if (term) return fieldErr(`l${term.idx + 1}.freightTerm`, `Row ${term.idx + 1}: freight is Paid, To pay or TBB`);
  /* A transporter is picked from the list, never added by an upload — and saved as the list spells it. */
  for (const i of clean) {
    const listed = await listedTransporterName(db, i.transporter);
    if (!listed.ok) return fieldErr(`l${i.idx + 1}.transporter`, `Row ${i.idx + 1}: ${listed.error}`);
    i.transporter = listed.name;
  }
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
        kind: i.kind,
        receivedBy: (i.receivedBy ?? "").trim() || null,
        deliveredOn: day(i.deliveredOn),
        billHint: (i.billHint ?? "").trim() || null,
        partyHint: (i.partyHint ?? "").trim() || null,
      });
      await bindErpFiles(tx as unknown as typeof db, [i.fileId], "erp_lr", id, ctx.actor.id);
    }
  });
  /* How the photo readings fared — after the LRs are safe, and never at their cost. */
  await settleLrReadings(ctx, readings).catch((e) => console.error("LR upload: settling photo readings failed:", e instanceof Error ? e.message : e));
  await erpAudit(ctx, "erp.logistics.lrUpload", "erp_lr", ids.join(","), null, { lrs: clean.map((i) => i.lrNo || null), kinds: clean.map((i) => i.kind), already });
  const word = clean.every((i) => i.kind === "signed_copy") ? (ids.length === 1 ? "signed copy" : "signed copies") : clean.every((i) => i.kind === "lr") ? (ids.length === 1 ? "LR" : "LRs") : ids.length === 1 ? "copy" : "copies";
  return ok({ ids, already: [...new Set(already)], repeats }, `${ids.length} ${word} uploaded${already.length ? ` · ${already.length} not sent again, uploaded before` : ""} — the office checks ${ids.length === 1 ? "it" : "them"} on the Documents desk`);
}

/**
 * An LR's own fields, on the desk or on the road. Once it is attached the
 * party has usually been told its number, so a correction there is recorded
 * on every open bill under it and — when the person says so — told to the
 * party as a correction rather than left for them to find on the paper.
 */
export async function editLr(ctx: ErpContext, lrId: string, input: LrInput, opts: { notify?: boolean } = {}): Promise<Result<unknown>> {
  const [lr] = await db.select().from(erpLrs).where(eq(erpLrs.id, lrId));
  if (!lr || lr.status === "void") return err("That LR is not on the desk.", "not_found");
  if (lr.kind === "signed_copy") return editSignedCopy(ctx, lr, input);
  const lrNo = (input.lrNo ?? "").trim().toUpperCase() || null;
  /* The bills under an attached LR carry its number, and the customer was told it. */
  if (!lrNo && lr.status === "assigned") return fieldErr("lrNo", "This LR is attached to bills, so it needs its number");
  const listed = await listedTransporterName(db, input.transporter, lr.transporter);
  if (!listed.ok) return fieldErr("transporter", listed.error);
  const transporter = listed.name;
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
  /* What the party was told and is now different: the number, the transporter, the date on the paper. */
  const told = [
    lr.lrNo !== lrNo ? `LR number ${lr.lrNo ?? "—"} → ${lrNo}` : null,
    (lr.transporter ?? "") !== (transporter ?? "") ? `transporter ${lr.transporter ?? "—"} → ${transporter ?? "—"}` : null,
    lr.lrDate !== after.lrDate ? `LR date ${lr.lrDate ? shortDay(lr.lrDate) : "—"} → ${after.lrDate ? shortDay(after.lrDate) : "—"}` : null,
  ].filter((x): x is string => !!x);
  const open = lr.status === "assigned" && told.length ? (await db.select().from(erpTransports).where(eq(erpTransports.lrId, lrId))).filter((t) => t.materialStage !== CLOSED) : [];
  let eventId: string | null = null;
  await db.transaction(async (tx) => {
    await tx.update(erpLrs).set(after).where(eq(erpLrs.id, lrId));
    if (input.fileId) await bindErpFiles(tx as unknown as typeof db, [input.fileId], "erp_lr", lrId, ctx.actor.id);
    /* The bills under it carry its number as text — every reader of erp_transports reads that. */
    await tx.update(erpTransports).set({ lrNo, ...(transporter ? { transporter } : {}), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpTransports.lrId, lrId));
    if (open.length) eventId = await addEvent(tx as unknown as typeof db, ctx, open.map((t) => t.id), "lr_edit", open[0].materialStage, `LR corrected: ${told.join(", ")}`, false);
  });
  await erpAudit(ctx, "erp.logistics.lrEdit", "erp_lr", lrId, lr, after);
  if (open.length) await syncBookOrders([...new Set(open.map((t) => t.orderNo))]);
  const saved = lrNo ? `LR ${lrNo} saved` : "LR saved";
  if (!open.length || !opts.notify) return ok(undefined, saved);
  const notified = await notifyCustomers(ctx, "stage", open.map((t) => t.id), eventId, {
    note: `Correction: the ${told.length === 1 && told[0].startsWith("LR number") ? "LR number we sent earlier was" : "LR details we sent earlier were"} wrong — please use LR ${lrNo}${transporter ? ` with ${transporter}` : ""}.`,
  });
  return ok({ notified }, `${saved}${notifyWords(notified)}`);
}

/** A signed copy's own fields: who signed, the day on it, and what it says it is for. */
async function editSignedCopy(ctx: ErpContext, lr: typeof erpLrs.$inferSelect, input: LrInput): Promise<Result<unknown>> {
  const deliveredOn = input.deliveredOn ? day(input.deliveredOn) : null;
  if (input.deliveredOn && !deliveredOn) return fieldErr("deliveredOn", "The delivery date is not a date");
  if (deliveredOn && deliveredOn > today()) return fieldErr("deliveredOn", "Delivery cannot be in the future");
  const after = {
    receivedBy: (input.receivedBy ?? "").trim().slice(0, 120) || null,
    deliveredOn,
    billHint: (input.billHint ?? "").trim().slice(0, 80) || null,
    partyHint: (input.partyHint ?? "").trim().slice(0, 160) || null,
    note: (input.note ?? "").trim() || null,
    ...(input.fileId ? { fileId: input.fileId } : {}),
  };
  await db.transaction(async (tx) => {
    await tx.update(erpLrs).set(after).where(eq(erpLrs.id, lr.id));
    if (input.fileId) await bindErpFiles(tx as unknown as typeof db, [input.fileId], "erp_lr", lr.id, ctx.actor.id);
    /* Who signed is the delivery's own record once the copy is attached. */
    if (lr.status === "assigned" && after.receivedBy) await tx.update(erpTransports).set({ receivedBy: after.receivedBy, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpTransports.signedCopyId, lr.id));
  });
  await erpAudit(ctx, "erp.logistics.signedCopyEdit", "erp_lr", lr.id, lr, after);
  return okVoid("Signed copy saved");
}

/**
 * Uploaded under the wrong kind — an LR sent as a signed copy, or the other
 * way. A signed copy closing a delivery is part of it and stays put. A signed
 * copy that was ATTACHED AS AN LR is the one case that may move while
 * attached: the bills it was put on were never under an LR at all, so they
 * come off it and go back to waiting for their real one — unless one is
 * already delivered, which keeps it until reopened.
 */
export async function setLrKind(ctx: ErpContext, lrId: string, kind: ProofKind): Promise<Result<unknown>> {
  if (!isProofKind(kind)) return err("An upload is an LR or a signed copy.", "validation");
  const [lr] = await db.select().from(erpLrs).where(eq(erpLrs.id, lrId));
  if (!lr || lr.status === "void") return err("That upload is not on the desk.", "not_found");
  if (lr.kind === kind) return okVoid("No change");
  const carrying = lr.status === "unassigned" ? [] : await db.select().from(erpTransports).where(eq(erpTransports.lrId, lrId));
  if (lr.status !== "unassigned" && !(lr.kind === "lr" && kind === "signed_copy")) return err("It is attached already. Take it off its bills first.", "rule_violation");
  if (carrying.some((t) => t.materialStage === CLOSED)) return err("A delivered bill keeps its LR. Reopen it first.", "rule_violation");
  await db.transaction(async (tx) => {
    if (carrying.length) {
      await tx
        .update(erpTransports)
        .set({ lrId: null, lrNo: null, trackStatus: "Don't Track", materialStage: "At transport", updatedAt: new Date(), updatedById: ctx.user.id })
        .where(inArray(erpTransports.id, carrying.map((t) => t.id)));
      await addEvent(tx as unknown as typeof db, ctx, carrying.map((t) => t.id), "lr_removed", "At transport", `${lr.lrNo ? `LR ${lr.lrNo}` : "The upload"} was a signed copy, not an LR`, false);
    }
    /* A signed copy carries no LR number, so a number typed on it would sit in the unique index for nothing. */
    await tx
      .update(erpLrs)
      .set({ kind, ...(kind === "signed_copy" ? { lrNo: null } : {}), ...(lr.status !== "unassigned" ? { status: "unassigned", assignedById: null, assignedAt: null } : {}) })
      .where(eq(erpLrs.id, lrId));
  });
  await erpAudit(ctx, "erp.logistics.lrKind", "erp_lr", lrId, { kind: lr.kind, status: lr.status }, { kind, bills: carrying.map((t) => t.orderNo) });
  if (carrying.length) await syncBookOrders([...new Set(carrying.map((t) => t.orderNo))]);
  const back = carrying.length ? ` · ${carrying.length === 1 ? "its bill is" : `its ${carrying.length} bills are`} back waiting for an LR` : "";
  return okVoid(kind === "lr" ? "Moved to LRs" : `Moved to signed copies${back}`);
}

/**
 * A cropped or rotated photo replaces the one on the copy. Only the file
 * moves — every field typed or read stays as it is — and only the person's
 * own fresh upload may take its place.
 */
export async function replaceLrFile(ctx: ErpContext, lrId: string, fileId: string): Promise<Result<unknown>> {
  const [lr] = await db.select().from(erpLrs).where(eq(erpLrs.id, lrId));
  if (!lr || lr.status === "void") return err("That upload is not on the desk.", "not_found");
  const [mine] = (await db.execute(sql`select id from attachments where id = ${fileId} and uploaded_by_id = ${ctx.actor.id} and status = 'available' and parent_id is null`)) as unknown as { id: string }[];
  if (!mine) return err("That photo is not one you just saved.", "not_found");
  await db.transaction(async (tx) => {
    await tx.update(erpLrs).set({ fileId }).where(eq(erpLrs.id, lrId));
    await bindErpFiles(tx as unknown as typeof db, [fileId], "erp_lr", lrId, ctx.actor.id);
  });
  await erpAudit(ctx, "erp.logistics.lrPhoto", "erp_lr", lrId, { fileId: lr.fileId }, { fileId });
  return okVoid("Photo saved");
}

/** A person looked at the pair and says they are two different papers: never flagged again. */
export async function clearDuplicate(ctx: ErpContext, lrId: string): Promise<Result<unknown>> {
  const [lr] = await db.select().from(erpLrs).where(eq(erpLrs.id, lrId));
  if (!lr || lr.status === "void") return err("That upload is not on the desk.", "not_found");
  await db.update(erpLrs).set({ dupClearedAt: new Date(), dupClearedById: ctx.user.id }).where(eq(erpLrs.id, lrId));
  await erpAudit(ctx, "erp.logistics.dupCleared", "erp_lr", lrId, null, { cleared: true });
  return okVoid("Kept — both stay on the desk");
}

/**
 * The same paper twice: the later copy is voided with the earlier one named.
 * Refused unless the desk's own rule still sees it as a copy of something —
 * this is the one void that needs no typed confirmation, because it can only
 * ever remove a second copy of a paper that stays on the desk.
 */
export async function discardDuplicate(ctx: ErpContext, lrId: string): Promise<Result<unknown>> {
  const { duplicateFlags } = await import("./engines/delivery-proof");
  const desk = await uploadedLrs({ status: "all", recentDays: 120 });
  const me = desk.find((l) => l.id === lrId);
  if (!me) return err("That upload is not on the desk.", "not_found");
  if (me.status !== "unassigned") return err("It is attached to bills — it is not a spare copy.", "rule_violation");
  const flag = duplicateFlags(desk).get(lrId);
  if (!flag) return err("This does not look like a copy of anything on the desk any more.", "conflict");
  const of = desk.find((l) => l.id === flag.ofId);
  const why = `Duplicate of ${of?.lrNo ? `LR ${of.lrNo}` : of?.billHint ? `the copy for bill ${of.billHint}` : "an earlier upload"}`;
  await db.update(erpLrs).set({ status: "void", voidReason: why }).where(and(eq(erpLrs.id, lrId), eq(erpLrs.status, "unassigned")));
  await erpAudit(ctx, "erp.logistics.dupDiscarded", "erp_lr", lrId, { status: "unassigned" }, { status: "void", reason: why, of: flag.ofId });
  return okVoid("Discarded — the earlier copy stays");
}

/**
 * A wrong LR is voided with its reason, never deleted. Bills still on the road
 * under it come off in the same breath and go back to waiting for their LR —
 * that is the whole point when the wrong paper was attached — but a DELIVERED
 * bill keeps its LR, and a signed copy closing a delivery is part of it, so
 * either refuses. The person saw all of that first (`erp-lr-void`).
 */
export async function voidLr(ctx: ErpContext, lrId: string, reason: string, confirmation?: ImpactConfirmation | null): Promise<Result<unknown>> {
  const why = reason.trim();
  if (why.length < 3) return fieldErr("reason", "Say why this LR is being voided");
  const [lr] = await db.select().from(erpLrs).where(eq(erpLrs.id, lrId));
  if (!lr || lr.status === "void") return err("That LR is not on the desk.", "not_found");
  const carrying = await db.select().from(erpTransports).where(sql`${erpTransports.lrId} = ${lrId} or ${erpTransports.signedCopyId} = ${lrId}`);
  if (carrying.some((t) => t.signedCopyId === lrId)) return err("This signed copy closes a delivery. Reopen the delivery first.", "rule_violation");
  if (carrying.some((t) => t.materialStage === CLOSED)) return err("A delivered bill keeps its LR. Reopen it first.", "rule_violation");
  const refusal = await confirmImpact("erp-lr-void", lrId, confirmation);
  if (refusal) return refusal;
  await db.transaction(async (tx) => {
    if (carrying.length) {
      await tx
        .update(erpTransports)
        .set({ lrId: null, lrNo: null, trackStatus: "Don't Track", materialStage: "At transport", updatedAt: new Date(), updatedById: ctx.user.id })
        .where(inArray(erpTransports.id, carrying.map((t) => t.id)));
      await addEvent(tx as unknown as typeof db, ctx, carrying.map((t) => t.id), "lr_removed", "At transport", `${lr.lrNo ? `LR ${lr.lrNo}` : "The LR"} voided: ${why}`, false);
    }
    await tx.update(erpLrs).set({ status: "void", voidReason: why }).where(eq(erpLrs.id, lrId));
  });
  await erpAudit(ctx, "erp.logistics.lrVoid", "erp_lr", lrId, { status: lr.status }, { status: "void", reason: why, bills: carrying.map((t) => t.orderNo) });
  if (carrying.length) await syncBookOrders([...new Set(carrying.map((t) => t.orderNo))]);
  return okVoid(`${lrUploadName(lr.lrNo)} voided${carrying.length ? ` · ${carrying.length === 1 ? "its bill is" : `its ${carrying.length} bills are`} back waiting for an LR` : ""}`);
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
  if (lr.kind === "signed_copy") return err("This is a signed copy. It closes a Mahek Vehicle delivery — attach it on the Signed copies tab.", "rule_violation");
  if (!lr.lrNo) return fieldErr("lrNo", "Type the LR number off the photo first (Edit) — the customer is told it.");
  const lrNo = lr.lrNo;
  const ts = await load([...new Set(transportIds)]);
  if (ts.length !== new Set(transportIds).size) return err("A bill you ticked is no longer in logistics. Refresh and try again.", "conflict");
  const own = ts.find((t) => isMahekVehicle(t.transporter));
  if (own) return err(`Order ${own.orderNo} goes in a Mahek Vehicle, which carries no LR. Change who delivers it first.`, "rule_violation");
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

/** What one status update can say — the stage, the call, and the route (0296). */
export type ConsignmentUpdate = {
  stage?: string | null;
  note?: string | null;
  nextCallOn?: string | null;
  expectedOn?: string | null;
  notify?: boolean;
  /** The transporter's godown or booking office it left from. Undefined: unchanged; empty: cleared. */
  dispatchedFrom?: string | null;
  /** Cities reached since the last call, each with the day — as many as the transporter listed. */
  cities?: { city?: string | null; on?: string | null }[] | null;
  /** The city it is going to. Undefined: unchanged; empty: back to the LR's own. */
  destination?: string | null;
  /** Ready for pickup: where the party collects it, and whom to ask. */
  pickupPoint?: string | null;
  pickupContact?: string | null;
};

/**
 * Step 5 — the transporter was called. A stage that moved is shared with the
 * customer (unless the person says not to); a call that moved nothing books
 * the next call and tells nobody.
 *
 * The call can also carry the ROUTE (0296): the godown it was dispatched from,
 * every city it has reached since the last call — each its own shared event,
 * dated the day it got there, so a week of updates caught up in one call still
 * reads as a week — where it is going, and, when the party collects it, where
 * and from whom. A new city is news, so it is told like a stage that moved.
 */
export async function updateConsignment(ctx: ErpContext, transportIds: string[], input: ConsignmentUpdate): Promise<Result<{ notified: NotifyOutcome }>> {
  const ts = (await load(transportIds)).filter((t) => t.materialStage !== CLOSED);
  if (!ts.length) return err("Nothing here is still on the road.", "rule_violation");
  const stage = input.stage?.trim() || null;
  if (stage && !ROAD_STAGES.includes(stage as never)) return fieldErr("stage", "Pick where the goods are");
  if (stage && ts.some((t) => !t.lrNo && !isMahekVehicle(t.transporter))) return err("A bill with no LR is moved by attaching its LR on the Documents desk.", "rule_violation");
  const expected = day(input.expectedOn);
  if (input.expectedOn && !expected) return fieldErr("expectedOn", "Expected delivery is not a date");
  const nextIn = day(input.nextCallOn);
  if (input.nextCallOn && !nextIn) return fieldErr("nextCallOn", "The next call is not a date");
  if (nextIn && nextIn < today()) return fieldErr("nextCallOn", "The next call cannot be in the past");
  const note = input.note?.trim() || null;

  /* The route. Each part is touched only when the screen sent it. */
  const leftOn = ts.map((t) => t.billDate).filter((d): d is string => !!d).sort()[0] ?? null;
  const cities = cleanCities(input.cities, today(), leftOn);
  if (!cities.ok) return fieldErr("cities", cities.error);
  const from = input.dispatchedFrom === undefined ? undefined : cleanPlace(input.dispatchedFrom);
  const fromMoved = from !== undefined && ts.some((t) => (t.dispatchedFrom ?? null) !== from);
  const destination = input.destination === undefined ? undefined : cleanPlace(input.destination);
  const destinationMoved = destination !== undefined && ts.some((t) => (t.destination ?? null) !== destination);
  const finalStage = stage ?? ts[0].materialStage;
  const pickup = finalStage === "Ready for Pickup";
  const pickupPoint = pickup ? (input.pickupPoint ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null : undefined;
  const pickupContact = pickup ? (input.pickupContact ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null : undefined;
  if (stage === "Ready for Pickup" && !pickupPoint && ts.some((t) => !t.pickupPoint)) return fieldErr("pickupPoint", "Say where the party collects it — the transporter's office and its area");
  const pickupMoved = pickup && ts.some((t) => (pickupPoint !== undefined && pickupPoint !== null && t.pickupPoint !== pickupPoint) || (pickupContact != null && t.pickupContact !== pickupContact));

  const cfg = await getConfig();
  const nextCall = nextIn ?? addDays(today(), cfg["erp.logistics.callEveryDays"]);
  const moved = stage ? ts.filter((t) => t.materialStage !== stage) : [];
  const expectedMoved = expected ? ts.filter((t) => t.expectedDeliveryOn !== expected) : [];
  const routeNews = cities.cities.length > 0 || fromMoved || pickupMoved;
  const news = moved.length > 0 || expectedMoved.length > 0 || routeNews;
  const ids = ts.map((t) => t.id);
  let eventId = "";
  await db.transaction(async (tx) => {
    const t2 = tx as unknown as typeof db;
    await tx
      .update(erpTransports)
      .set({
        ...(stage ? { materialStage: stage } : {}),
        ...(expected ? { expectedDeliveryOn: expected } : {}),
        ...(from !== undefined ? { dispatchedFrom: from } : {}),
        ...(destination !== undefined ? { destination } : {}),
        ...(pickupPoint ? { pickupPoint } : {}),
        ...(pickupContact !== undefined && (pickupPoint || pickupContact) ? { pickupContact } : {}),
        reminderDate: nextCall,
        ...(note ? { note } : {}),
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      })
      .where(inArray(erpTransports.id, ids));
    if (fromMoved && from) {
      /* It left the godown before it reached any city: dated a minute before the first one reported, else now. */
      const [first] = (await tx.execute(sql`select min(e.at) as at from erp_transport_events e where e.transport_id in ${ids} and e.kind = 'checkpoint'`)) as unknown as { at: unknown }[];
      const earliest = [first?.at ? new Date(String(first.at)) : null, cities.cities[0] ? reachedAt(cities.cities[0].on) : null].filter((d): d is Date => !!d).sort((x, y) => x.getTime() - y.getTime())[0];
      await addEvent(t2, ctx, ids, "dispatched", finalStage, `Dispatched from ${from}`, true, { city: from, at: earliest ? new Date(Math.min(Date.now(), earliest.getTime() - 60_000)) : undefined });
    }
    for (const c of cities.cities) await addEvent(t2, ctx, ids, "checkpoint", finalStage, `Reached ${c.city}`, true, { city: c.city, at: reachedAt(c.on) });
    if (destinationMoved) await addEvent(t2, ctx, ids, "note", finalStage, destination ? `Going to ${destination}` : "Destination set back to the LR's", false);
    eventId = await addEvent(
      t2,
      ctx,
      ids,
      moved.length ? "stage" : "call",
      finalStage,
      [note, expected && expectedMoved.length ? `Expected ${expected}` : null, pickup && pickupPoint ? `Collect from ${pickupPoint}${pickupContact ? ` (${pickupContact})` : ""}` : null].filter(Boolean).join(" · ") || null,
      news,
    );
    /* Where it is now is the newest place any event named — never typed twice. */
    if (fromMoved || cities.cities.length) {
      await tx.execute(sql`
        update erp_transports t
           set current_city = (select e.city from erp_transport_events e where e.transport_id = t.id and e.city is not null order by e.at desc limit 1)
         where t.id in ${ids}
      `);
    }
  });
  await erpAudit(ctx, "erp.logistics.update", "erp_transport", ids.join(","), null, { stage, note, nextCall, expected, dispatchedFrom: from, cities: cities.cities, destination, pickupPoint, pickupContact });
  if (moved.length) await syncBookOrders([...new Set(moved.map((t) => t.orderNo))]);
  const tell = news && input.notify !== false;
  const last = cities.cities.at(-1);
  const notified = tell ? await notifyCustomers(ctx, "stage", ids, eventId, { note, ...(last ? { city: last.city, cityOn: last.on } : {}) }) : NO_NOTIFY;
  const said = moved.length ? "Status updated" : cities.cities.length ? `${cities.cities.length === 1 ? "City" : `${cities.cities.length} cities`} added` : routeNews ? "Route updated" : "Call logged";
  return ok({ notified }, `${said} · next call ${nextCall}${notifyWords(notified)}`);
}

export async function raiseIssue(
  ctx: ErpContext,
  transportIds: string[],
  input: { issue: string; note?: string | null; expectedOn?: string | null; notify?: boolean; customerReason?: string | null },
): Promise<Result<{ notified: NotifyOutcome }>> {
  if (!(ISSUES as readonly string[]).includes(input.issue)) return fieldErr("issue", "Pick what went wrong");
  const { delayReasonForIssue, reasonsFor } = await import("./engines/order-tracking");
  /* What the customer's tracking page calls it. Absent (an older screen): read off the problem. Empty: internal only. */
  const customerReason = input.customerReason === undefined ? delayReasonForIssue(input.issue) : input.customerReason || null;
  if (customerReason && !reasonsFor("delay").some((r) => r.code === customerReason && r.code !== "other")) return fieldErr("customerReason", "Pick what the customer is told");
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
  /* A delay the customer reads as one goes on their tracking page, in the shipped sentence for its reason —
     never the internal note. Its WhatsApp is the issue message below, so the tracking side tells nobody twice. */
  if (customerReason) {
    const { delayFromLogistics } = await import("./order-tracking");
    await delayFromLogistics(ctx, ts.map((t) => ({ id: t.id, orderNo: t.orderNo })), customerReason, { note, expectedOn: expected, notify: false });
  }
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
  await (await import("./order-tracking")).clearDelays(ctx, [...new Set(ts.map((t) => t.orderNo))], said ?? "The delay has been cleared.");
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
  input: { date: string; receivedBy?: string | null; proof?: string | null; note?: string | null; notify?: boolean; signedCopyId?: string | null },
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
  /* A MAHEK VEHICLE DELIVERY CLOSES ONLY WITH THE CUSTOMER-SIGNED COPY, and who signed it. */
  const own = ts.filter((t) => isMahekVehicle(t.transporter));
  let copy: typeof erpLrs.$inferSelect | null = null;
  if (own.length) {
    const want = input.signedCopyId?.trim() || own.find((t) => t.signedCopyId)?.signedCopyId || null;
    if (!want) return fieldErr("signedCopy", "A Mahek Vehicle delivery needs the customer-signed copy. Upload it or pick one waiting on the desk.");
    [copy] = await db.select().from(erpLrs).where(eq(erpLrs.id, want));
    if (!copy || copy.status === "void" || copy.kind !== "signed_copy") return fieldErr("signedCopy", "That signed copy is not on the desk.");
    const elsewhere = copy.status === "assigned" && !own.some((t) => t.signedCopyId === copy!.id);
    if (elsewhere) return fieldErr("signedCopy", "That signed copy already closes another delivery.");
    if (!receivedBy && !copy.receivedBy) return fieldErr("receivedBy", "Say who signed for it — the name on the copy");
  }
  const signer = receivedBy ?? copy?.receivedBy ?? null;
  let eventId = "";
  await db.transaction(async (tx) => {
    await tx
      .update(erpTransports)
      .set({ materialStage: CLOSED, trackStatus: "Don't Track", deliveredOn: d, receivedBy: signer, deliveredById: ctx.user.id, deliveryProof: proof, issue: null, issueNote: null, issueAt: null, reminderDate: null, ...(note ? { note } : {}), updatedAt: new Date(), updatedById: ctx.user.id })
      .where(inArray(erpTransports.id, ts.map((t) => t.id)));
    if (copy && own.length) {
      await tx.update(erpTransports).set({ signedCopyId: copy.id, deliveryProof: proof ?? "Customer-signed copy" }).where(inArray(erpTransports.id, own.map((t) => t.id)));
      await tx.update(erpLrs).set({ status: "assigned", assignedById: ctx.user.id, assignedAt: new Date(), receivedBy: signer, deliveredOn: d }).where(eq(erpLrs.id, copy.id));
    }
    eventId = await addEvent(tx as unknown as typeof db, ctx, ts.map((t) => t.id), "delivered", CLOSED, [signer ? `Received by ${signer}` : null, copy ? "Signed copy" : proof ? `Proof: ${proof}` : null, note].filter(Boolean).join(" · ") || null);
  });
  await erpAudit(ctx, "erp.logistics.delivered", "erp_transport", ts.map((t) => t.id).join(","), null, { date: d, receivedBy: signer, proof, signedCopyId: copy?.id ?? null });
  /* Delivered ends any delay the customer was reading about. */
  await (await import("./order-tracking")).clearDelays(ctx, [...new Set(ts.map((t) => t.orderNo))], "Delivered.");
  await syncBookOrders([...new Set(ts.map((t) => t.orderNo))]);
  const notified = input.notify === false ? NO_NOTIFY : await notifyCustomers(ctx, "delivered", ts.map((t) => t.id), eventId, { deliveredOn: d, receivedBy: signer });
  return ok({ notified }, `Delivered and closed${notifyWords(notified)}`);
}

/**
 * WHO DELIVERS IT CAN CHANGE UNTIL IT IS DELIVERED: a transporter's bill put
 * on our own vehicle, or the other way. Our own vehicle carries no LR, so a
 * bill already under an LR keeps its transporter until the LR comes off it;
 * the order's own lines move with it, so the order book and loading agree.
 */
export async function setDeliveredBy(ctx: ErpContext, transportIds: string[], transporterRaw: string): Promise<Result<unknown>> {
  const ts = (await load([...new Set(transportIds)])).filter((t) => t.materialStage !== CLOSED);
  if (!ts.length) return err("These are already delivered — who delivered them cannot change now.", "rule_violation");
  const toOwn = isMahekVehicle(transporterRaw);
  let transporter = MAHEK_VEHICLE as string;
  if (!toOwn) {
    const listed = await listedTransporterName(db, transporterRaw);
    if (!listed.ok) return fieldErr("transporter", listed.error);
    if (!listed.name) return fieldErr("transporter", "Pick the transporter");
    transporter = listed.name;
  }
  const lr = ts.find((t) => t.lrId);
  if (toOwn && lr) return err(`Order ${lr.orderNo} is under LR ${lr.lrNo}. Take it off the LR first.`, "rule_violation");
  const moving = ts.filter((t) => (t.transporter ?? "").toLowerCase() !== transporter.toLowerCase());
  if (!moving.length) return okVoid("No change");
  await db.transaction(async (tx) => {
    for (const t of moving)
      await tx
        .update(erpTransports)
        .set({ transporter, ...(toOwn ? { trackStatus: "Track", reminderDate: t.reminderDate ?? today() } : {}), updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(erpTransports.id, t.id));
    await tx.execute(sql`update erp_orders set transporter = ${transporter}, updated_at = now() where id in (select order_id from erp_order_details where transport_id in ${moving.map((t) => t.id)})`);
    await addEvent(tx as unknown as typeof db, ctx, moving.map((t) => t.id), "delivered_by", null, `Delivered by ${transporter}`, false);
  });
  await erpAudit(ctx, "erp.logistics.deliveredBy", "erp_transport", moving.map((t) => t.id).join(","), { transporter: moving.map((t) => t.transporter) }, { transporter });
  await syncBookOrders([...new Set(moving.map((t) => t.orderNo))]);
  return okVoid(`${moving.length} bill${moving.length === 1 ? "" : "s"} now delivered by ${transporter}`);
}

/**
 * ATTACH ALL READY: every pair the desk was sure of, attached in one press.
 * Each goes through the ordinary `attachLr` (or `markDelivered` for a signed
 * copy), so every rule still applies; one refused pair is reported and the
 * rest still go.
 */
export async function attachReady(
  ctx: ErpContext,
  pairs: { lrId: string; transportIds: string[]; kind?: ProofKind; date?: string | null; receivedBy?: string | null }[],
  opts: { notify?: boolean } = {},
): Promise<Result<unknown>> {
  if (!pairs.length) return err("Nothing is ready to attach.", "rule_violation");
  if (pairs.length > 50) return err("Attach up to 50 at a time.", "validation");
  const cfg = await getConfig();
  let done = 0;
  const refused: string[] = [];
  for (const p of pairs) {
    const r =
      p.kind === "signed_copy"
        ? await markDelivered(ctx, p.transportIds, { date: p.date || today(), receivedBy: p.receivedBy ?? null, signedCopyId: p.lrId, notify: opts.notify })
        : await attachLr(ctx, p.lrId, p.transportIds, { notify: opts.notify, nextCallOn: addDays(today(), cfg["erp.logistics.callEveryDays"]) });
    if (r.ok) done++;
    else refused.push(r.error);
  }
  if (!done) return err(`Nothing attached: ${refused[0]}`, "rule_violation");
  return okVoid(`${done} attached${refused.length ? ` · ${refused.length} need a look: ${refused[0]}` : ""}`);
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
  const stage = t.lrNo ? "Reached Destination Area" : isMahekVehicle(t.transporter) ? "Out for Delivery" : "At transport";
  await db.transaction(async (tx) => {
    await tx.update(erpTransports).set({ materialStage: stage, trackStatus: t.lrNo || isMahekVehicle(t.transporter) ? "Track" : "Don't Track", deliveredOn: null, receivedBy: null, deliveredById: null, deliveryProof: null, reminderDate: today(), updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpTransports.id, t.id));
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
    /* OUR OWN VEHICLE IS A RESERVED NAME: renaming or switching it off would strand every Mahek Vehicle order. */
    if (isMahekVehicle(before.name) && !isMahekVehicle(name)) return fieldErr("name", `${MAHEK_VEHICLE} is our own vehicle and keeps its name`);
    if (isMahekVehicle(before.name) && input.active === false) return fieldErr("active", `${MAHEK_VEHICLE} cannot be switched off — orders choose it on "Delivered by"`);
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
  if (isMahekVehicle(from.name) || isMahekVehicle(into.name)) return err(`${MAHEK_VEHICLE} is our own vehicle, not a transporter — it cannot be merged.`, "rule_violation");
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

/** The area a godown is filed under, adding the rungs somebody typed (see `place-write.ts`). */
async function placeFor(tx: Tx, rungs: ResolvedRung[]): Promise<string | null> {
  const ids = await placeIdsFor(tx, rungs);
  return ids.at(-1)?.id ?? null;
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
  const staffNumbers = await readStaffNumbers();
  const base = await messageOrigin();
  const route = await watiRoute(cfg["erp.logistics.watiTemplate"]);
  const orderLinks = new Map<string, string>();
  if (base) {
    const { erpOrderTracking } = await import("@/db/schema");
    const { isNull } = await import("drizzle-orm");
    for (const k of await db.select().from(erpOrderTracking).where(and(inArray(erpOrderTracking.orderNo, [...new Set(ts.map((t) => t.orderNo))]), isNull(erpOrderTracking.revokedAt)))) {
      orderLinks.set(`${k.orderNo}|full`, `${base}/t/${k.token}`);
      orderLinks.set(`${k.orderNo}|delivery`, `${base}/t/${k.deliveryToken ?? k.token}`);
    }
  }
  const out: NotifyOutcome = { ...NO_NOTIFY };

  for (const c of people) {
    const mine = recipients.get(c.id)!;
    const first = mine[0];
    const lr = lrs.find((l) => l.id === first.lrId) ?? null;
    const facts: MessageFacts = {
      party: c.name,
      /* A bill raised on two orders has two records and is still one bill to the customer. */
      bills: [...new Set(mine.map((t) => t.billNo ?? `order ${t.orderNo}`))],
      lrNo: first.lrNo,
      lrDate: lr?.lrDate ?? null,
      transporter: first.transporter ?? lr?.transporter ?? null,
      packages: mine.every((t) => t.packages != null) ? mine.reduce((a, t) => a + (t.packages ?? 0), 0) : (lr?.packages ?? null),
      stage: first.materialStage,
      vehicleNo: first.vehicleNo ?? null,
      expectedOn: first.expectedDeliveryOn,
      city: first.currentCity,
      dispatchedFrom: first.dispatchedFrom,
      destination: first.destination ?? lr?.destination ?? null,
      pickupPoint: first.pickupPoint,
      pickupContact: first.pickupContact,
      /* The order's own tracking link where it has one — the delivery party's view where this is not the billing party —
         else the consignment's older link, which opens the same page. */
      trackUrl: base ? (orderLinks.get(`${first.orderNo}|${c.id === first.billingCustomerId ? "full" : "delivery"}`) ?? (first.trackToken ? `${base}/track/${first.trackToken}` : null)) : null,
      signature: cfg["erp.logistics.signature"] || "Mahek Marketing India",
      ...extra,
    };
    const body = customerMessage(kind, facts);
    const raw = whatsappNumberFor(c, "general");
    const phone = waNumber(raw);
    const skip = skipReason(c, raw, phone, staffNumbers);
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
  /* An order tracking message (0292) goes as order tracking's template, not the road's. */
  const route = m.orderNo ? await watiRoute(cfg["erp.tracking.watiTemplate"], "order tracking") : await watiRoute(cfg["erp.logistics.watiTemplate"]);
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
