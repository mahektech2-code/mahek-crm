import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, customers, erpOrderHolds, erpOrderMilestones, erpOrderTracking, erpTransportMessages } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { whatsappNumberFor } from "@/lib/customer-contacts";
import { err, fieldErr, ok, type Result } from "@/lib/result";
import { waNumber } from "@/lib/whatsapp-delivery";
import type { ErpContext } from "./access";
import { messageOrigin, skipReason, staffNumbers, watiRoute } from "./customer-messaging";
import {
  buildJourney,
  deriveSteps,
  holdRefusal,
  holdTitle,
  longDay,
  productRows,
  reasonLabel,
  sentenceFor,
  STEP_LABEL,
  trackMessage,
  trackWatiParams,
  type HoldInput,
  type HoldRecord,
  type JourneyEntry,
  type LineFacts,
  type ProductFacts,
  type ProductRow,
  type Recorded,
  type Step,
  type TrackMessageFacts,
  type TrackMessageKind,
  type TransportFacts,
} from "./engines/order-tracking";
import { today } from "./screens/common";
import { isMahekVehicle } from "./engines/logistics";
import { erpAudit, erpId } from "./server";

/* ---------------------------------------------------------------------------
 * CUSTOMER ORDER TRACKING, wired to data. The rules are in
 * engines/order-tracking.ts; this reads the facts every team already records,
 * writes each step ONCE when it first becomes true, makes the link, keeps the
 * holds, and sends the messages. See "## Customer order tracking" in AGENTS.md.
 *
 * `syncOrderTracking` is called after every write that moves an order — it
 * rides on `syncBookOrders`, which every Orders and Logistics write already
 * calls — and hourly as the net under it. It can never fail the write that
 * called it.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const str = (v: unknown): string | null => (v == null ? null : String(v));

/** Steps older than this when first seen are recorded quietly: a message about something that happened yesterday is noise. */
const FRESH_MS = 6 * 3600_000;

export function newTrackingToken(): string {
  /* 24 characters from 18 random bytes, URL-safe: 144 bits, nothing to guess. */
  return randomBytes(18).toString("base64url");
}

/* ============================================================ the facts */

type OrderBasics = {
  orderNo: number;
  orderDate: string;
  billingId: string;
  deliveryId: string;
  billingName: string;
  deliveryName: string;
  deliveryCity: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  lines: (LineFacts & { lineId: string; product: ProductFacts })[];
};

/** The live lines (not cancelled) of ERP-taken orders. Lines copied from the Taken Order sheet are history and are never tracked. */
async function readOrders(orderNos: number[]): Promise<Map<number, OrderBasics>> {
  const out = new Map<number, OrderBasics>();
  if (!orderNos.length) return out;
  const rows = (await db.execute(sql`
    select o.id, o.order_no as "orderNo", o.order_date::text as "orderDate", o.status, o.order_check as "orderCheck",
           o.order_checked_at as "orderCheckedAt", o.party_status as "partyStatus", o.created_at as "createdAt", o.updated_at as "updatedAt",
           o.billing_customer_id as "billingId", o.delivery_customer_id as "deliveryId", bc.name as "billingName", dc.name as "deliveryName",
           dc.city as "deliveryCity", o.qty_cans as "qtyCans", o.tally_bill_no as "invoiceNo", o.invoice_date::text as "invoiceDate",
           p.name as sku, fg.name as good, p.millilitres_per_can as ml, p.cans_per_box as cpb, coalesce(pk.box_type, '') as "boxType",
           d.order_id is not null as billed, d.created_at as "billedAt", d.invoice_check as "invoiceCheck", d.invoice_checked_at as "invoiceCheckedAt",
           coalesce(d.verification, '') = 'Verified' as dispatched, d.dispatched_at as "dispatchedAt"
      from erp_orders o
      join customers bc on bc.id = o.billing_customer_id
      join customers dc on dc.id = o.delivery_customer_id
      join products p on p.id = o.sku_id
      left join finished_goods fg on fg.id = p.finished_good_id
      left join erp_product_packing pk on pk.product_id = p.id
      left join erp_order_details d on d.order_id = o.id
     where o.order_no in ${[...new Set(orderNos)]} and o.status <> 'Cancel' and o.source = 'erp'
     order by o.order_no, o.created_at, o.id
  `)) as unknown as Row[];
  for (const r of rows) {
    const no = Number(r.orderNo);
    let o = out.get(no);
    if (!o) {
      o = {
        orderNo: no,
        orderDate: String(r.orderDate),
        billingId: String(r.billingId),
        deliveryId: String(r.deliveryId),
        billingName: String(r.billingName),
        deliveryName: String(r.deliveryName),
        deliveryCity: str(r.deliveryCity),
        invoiceNo: null,
        invoiceDate: null,
        lines: [],
      };
      out.set(no, o);
    }
    if (r.invoiceNo && !o.invoiceNo) {
      o.invoiceNo = String(r.invoiceNo);
      o.invoiceDate = str(r.invoiceDate);
    }
    const boxType = String(r.boxType ?? "");
    o.lines.push({
      lineId: String(r.id),
      status: String(r.status),
      orderCheck: String(r.orderCheck),
      orderCheckedAt: iso(r.orderCheckedAt),
      partyStatus: str(r.partyStatus),
      createdAt: iso(r.createdAt)!,
      updatedAt: iso(r.updatedAt)!,
      billed: !!r.billed,
      billedAt: iso(r.billedAt),
      invoiceCheck: r.billed ? (str(r.invoiceCheck) ?? "Pending") : null,
      invoiceCheckedAt: iso(r.invoiceCheckedAt),
      dispatched: !!r.dispatched,
      dispatchedAt: iso(r.dispatchedAt),
      product: {
        name: String(r.sku),
        goodName: str(r.good),
        qtyCans: Number(r.qtyCans),
        litresPerCan: r.ml == null ? null : Number(r.ml) / 1000,
        cansPerBox: Number(r.cpb ?? 1),
        boxed: boxType.startsWith("Empty Box"),
        drum: boxType === "Empty Drum",
      },
    });
  }
  return out;
}

/** 0296 — a place on the way the customer may see: the godown it left from, or a city it reached. */
export type TrackingStop = { city: string; at: string; from: boolean };

type TransportRow = TransportFacts & {
  id: string;
  orderNo: number;
  lrNo: string | null;
  lrDate: string | null;
  lrFileId: string | null;
  signedCopyFileId: string | null;
  transporter: string | null;
  expectedOn: string | null;
  deliveredOn: string | null;
  receivedBy: string | null;
  billingId: string;
  route: TrackingStop[];
  destination: string | null;
  pickupPoint: string | null;
  pickupContact: string | null;
};

async function readTransports(orderNos: number[]): Promise<Map<number, TransportRow[]>> {
  const out = new Map<number, TransportRow[]>();
  if (!orderNos.length) return out;
  const rows = (await db.execute(sql`
    select t.id, t.order_no as "orderNo", t.material_stage as stage, t.at_transport_at as "atTransportAt", t.lr_no as "lrNo",
           l.lr_date::text as "lrDate", l.file_id as "lrFileId", l.assigned_at as "lrAttachedAt", coalesce(t.transporter, l.transporter) as transporter,
           t.expected_delivery_on::text as "expectedOn", t.delivered_on::text as "deliveredOn", t.received_by as "receivedBy",
           t.billing_customer_id as "billingId", sc.file_id as "signedCopyFileId",
           coalesce(t.destination, l.destination) as destination, t.pickup_point as "pickupPoint", t.pickup_contact as "pickupContact",
           coalesce((select json_agg(json_build_object('kind', e.kind, 'city', e.city, 'at', e.at) order by e.at)
                       from erp_transport_events e where e.transport_id = t.id and e.shared and e.city is not null and (e.kind = 'checkpoint' or e.id = (select min(d.id) from erp_transport_events d where d.transport_id = t.id and d.kind = 'dispatched' and d.city = t.dispatched_from))), '[]'::json) as route,
           (select min(e.at) from erp_transport_events e where e.transport_id = t.id and e.kind = 'delivered') as "deliveredAt",
           coalesce((select json_agg(json_build_object('kind', e.kind, 'stage', e.stage, 'at', e.at) order by e.at)
                       from erp_transport_events e where e.transport_id = t.id and e.shared), '[]'::json) as events
      from erp_transports t
      left join erp_lrs l on l.id = t.lr_id
      left join erp_lrs sc on sc.id = t.signed_copy_id
     where t.order_no in ${[...new Set(orderNos)]}
     order by t.created_at
  `)) as unknown as Row[];
  for (const r of rows) {
    const no = Number(r.orderNo);
    const stage = String(r.stage);
    const delivered = stage === "Close - Received to Party";
    const evs = (Array.isArray(r.events) ? r.events : []) as { kind: string; stage: string | null; at: string }[];
    out.set(no, [
      ...(out.get(no) ?? []),
      {
        id: String(r.id),
        orderNo: no,
        stage,
        atTransportAt: iso(r.atTransportAt),
        lrAttachedAt: r.lrNo ? (iso(r.lrAttachedAt) ?? evs.find((e) => e.kind === "lr")?.at ?? null) : null,
        delivered,
        deliveredAt: delivered ? (iso(r.deliveredAt) ?? (r.deliveredOn ? `${String(r.deliveredOn)}T12:00:00+05:30` : null)) : null,
        events: evs.map((e) => ({ kind: e.kind, stage: e.stage, at: iso(e.at)! })),
        lrNo: str(r.lrNo),
        lrDate: str(r.lrDate),
        lrFileId: str(r.lrFileId),
        signedCopyFileId: str(r.signedCopyFileId),
        ownVehicle: isMahekVehicle(str(r.transporter)),
        transporter: str(r.transporter),
        expectedOn: str(r.expectedOn),
        deliveredOn: str(r.deliveredOn),
        receivedBy: str(r.receivedBy),
        billingId: String(r.billingId),
        route: ((Array.isArray(r.route) ? r.route : []) as { kind: string; city: string; at: string }[]).map((e) => ({ city: String(e.city), at: iso(e.at)!, from: e.kind === "dispatched" })),
        destination: str(r.destination),
        pickupPoint: str(r.pickupPoint),
        pickupContact: str(r.pickupContact),
      },
    ]);
  }
  return out;
}

type Tracking = typeof erpOrderTracking.$inferSelect;

async function liveTracking(orderNos: number[]): Promise<Map<number, Tracking>> {
  if (!orderNos.length) return new Map();
  const rows = await db.select().from(erpOrderTracking).where(and(inArray(erpOrderTracking.orderNo, orderNos), isNull(erpOrderTracking.revokedAt)));
  return new Map(rows.map((r) => [r.orderNo, r]));
}

async function makeTracking(o: OrderBasics, userId: string | null, backfilled: boolean): Promise<Tracking | null> {
  const [row] = await db
    .insert(erpOrderTracking)
    .values({
      id: erpId("otrk"),
      orderNo: o.orderNo,
      token: newTrackingToken(),
      deliveryToken: o.deliveryId !== o.billingId ? newTrackingToken() : null,
      backfilled,
      createdById: userId,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  return (await liveTracking([o.orderNo])).get(o.orderNo) ?? null;
}

/* ============================================================ recording steps */

/**
 * BRINGS EVERY ORDER'S RECORDED STEPS IN LINE WITH THE FACTS. A step newly
 * true is written once, at the moment the records give (or now); a step no
 * longer true is withdrawn. A confirmed order gets its link. A step that is
 * fresh — written now, and recent — writes the customer's message where the
 * settings ask for one. Never throws: tracking must not fail the write behind it.
 */
export async function syncOrderTracking(orderNos: number[], opts: { userId?: string | null; backfill?: boolean } = {}): Promise<void> {
  try {
    await syncOrderTrackingOrThrow(orderNos, opts);
  } catch (e) {
    console.error("[order-tracking] sync failed", orderNos.slice(0, 20), e);
  }
}

export async function syncOrderTrackingOrThrow(orderNos: number[], opts: { userId?: string | null; backfill?: boolean } = {}): Promise<{ links: number; steps: number }> {
  const nos = [...new Set(orderNos.filter((n) => Number.isFinite(n)))];
  if (!nos.length) return { links: 0, steps: 0 };
  const cfg = await getConfig();
  if (!cfg["erp.tracking.enabled"]) return { links: 0, steps: 0 };
  const [orders, transports, tracking, recorded] = await Promise.all([
    readOrders(nos),
    readTransports(nos),
    liveTracking(nos),
    db.select().from(erpOrderMilestones).where(and(inArray(erpOrderMilestones.orderNo, nos), isNull(erpOrderMilestones.withdrawnAt))),
  ]);
  const now = Date.now();
  let links = 0;
  let steps = 0;
  for (const no of nos) {
    const o = orders.get(no);
    const live = recorded.filter((r) => r.orderNo === no);
    const derived = o ? deriveSteps({ lines: o.lines, transports: transports.get(no) ?? [] }) : new Map<Step, string | null>();
    let t = tracking.get(no) ?? null;
    if (o && derived.has("confirmed") && !t) {
      const confirmedAt = derived.get("confirmed");
      const stale = opts.backfill || (!!confirmedAt && now - Date.parse(confirmedAt) > FRESH_MS) || derived.has("dispatched");
      t = await makeTracking(o, opts.userId ?? null, stale);
      if (t) links++;
    }
    /* Goods that left are not on hold: a hold nobody resolved before dispatch closes itself, in the history. */
    if (derived.has("dispatched")) {
      const [stuck] = await db.select().from(erpOrderHolds).where(and(eq(erpOrderHolds.orderNo, no), eq(erpOrderHolds.kind, "hold"), isNull(erpOrderHolds.resolvedAt)));
      if (stuck) await closeHold(opts.userId ?? null, stuck.id, "Your goods have been dispatched.");
    }
    /* Withdrawn: recorded, and no longer true. */
    const gone = live.filter((r) => !derived.has(r.step as Step));
    if (gone.length) await db.update(erpOrderMilestones).set({ withdrawnAt: new Date() }).where(inArray(erpOrderMilestones.id, gone.map((r) => r.id)));
    const fresh: Step[] = [];
    for (const [step, at] of derived) {
      if (live.some((r) => r.step === step)) continue;
      const when = at ? new Date(at) : new Date();
      const [row] = await db
        .insert(erpOrderMilestones)
        .values({ id: erpId("oms"), orderNo: no, step, at: when, byId: opts.userId ?? null, backfilled: !!opts.backfill })
        .onConflictDoNothing()
        .returning({ id: erpOrderMilestones.id });
      if (!row) continue;
      steps++;
      if (!opts.backfill && now - when.getTime() <= FRESH_MS) fresh.push(step);
    }
    if (o && t && !t.backfilled && fresh.length) {
      const notify = cfg["erp.tracking.notify"] ?? {};
      for (const kind of ["confirmed", "invoice", "dispatched"] as const) {
        if (fresh.includes(kind) && notify[kind] !== false) await sendTrackMessage(o, t, kind, { userId: opts.userId ?? null });
      }
    }
  }
  return { links, steps };
}

/** The hourly net: every order still being worked or touched in the last fortnight. */
export async function syncOpenOrderTracking(): Promise<{ orders: number; links: number; steps: number }> {
  const rows = (await db.execute(sql`
    select distinct o.order_no as n from erp_orders o
      left join erp_order_details d on d.order_id = o.id
      left join erp_transports t on t.order_no = o.order_no
     where o.source = 'erp'
       and (o.updated_at > now() - interval '14 days' or d.updated_at > now() - interval '14 days' or t.updated_at > now() - interval '14 days'
            or (o.status <> 'Cancel' and coalesce(t.material_stage, '') <> 'Close - Received to Party' and o.order_date > (now() - interval '120 days')::date))
  `)) as unknown as { n: number }[];
  const nos = rows.map((r) => Number(r.n));
  let links = 0;
  let steps = 0;
  for (let i = 0; i < nos.length; i += 100) {
    const r = await syncOrderTrackingOrThrow(nos.slice(i, i + 100));
    links += r.links;
    steps += r.steps;
  }
  return { orders: nos.length, links, steps };
}

/** Deploy day: every ERP order already confirmed gets its link and its steps, quietly — nobody is messaged. */
export async function backfillOrderTracking(): Promise<{ orders: number; links: number; steps: number }> {
  const rows = (await db.execute(sql`select distinct order_no as n from erp_orders where source = 'erp' and order_check = 'Verified' and order_date > (now() - interval '400 days')::date`)) as unknown as { n: number }[];
  const nos = rows.map((r) => Number(r.n));
  let links = 0;
  let steps = 0;
  for (let i = 0; i < nos.length; i += 100) {
    const r = await syncOrderTrackingOrThrow(nos.slice(i, i + 100), { backfill: true });
    links += r.links;
    steps += r.steps;
  }
  return { orders: nos.length, links, steps };
}

/* ============================================================ messages */

export type TrackSendOutcome = { sent: number; toSend: number; skipped: number; failed: number };

function linkFor(base: string | null, t: Tracking, forDelivery: boolean): string | null {
  if (!base) return null;
  return `${base}/t/${forDelivery && t.deliveryToken ? t.deliveryToken : t.token}`;
}

/**
 * Writes one tracking message per recipient and sends it through Wati where it
 * can — the same conditions as Logistics' (`watiRoute`). A step is told once:
 * a second message of the same kind for the order (a hold: for the same hold)
 * is not written. The billing party is told every step; the delivery party,
 * where it is somebody else, only what is about the goods reaching it.
 */
async function sendTrackMessage(
  o: OrderBasics,
  t: Tracking,
  kind: TrackMessageKind,
  extra: { userId: string | null; hold?: { id: string; kind: "hold" | "delay"; text: string; nextUpdateOn: string | null; revisedOn: string | null; resolution?: string | null } },
): Promise<TrackSendOutcome> {
  const out: TrackSendOutcome = { sent: 0, toSend: 0, skipped: 0, failed: 0 };
  const eventId = extra.hold?.id ?? null;
  const [already] = (await db.execute(sql`
    select 1 from erp_transport_messages where order_no = ${o.orderNo} and kind = ${kind}
       ${eventId ? sql`and event_id = ${eventId}` : sql``} limit 1
  `)) as unknown as unknown[];
  if (already) return out;
  const cfg = await getConfig();
  const toDelivery = kind === "dispatched" || (kind !== "confirmed" && kind !== "invoice" && extra.hold?.kind === "delay");
  const ids = [...new Set([o.billingId, ...(toDelivery ? [o.deliveryId] : [])])];
  const people = await db.select().from(customers).where(inArray(customers.id, ids));
  const staff = await staffNumbers();
  const base = await messageOrigin();
  const route = await watiRoute(cfg["erp.tracking.watiTemplate"], "order tracking");
  const products = productRows(o.lines.map((l) => l.product));
  for (const c of people) {
    const forDelivery = c.id !== o.billingId;
    const facts: TrackMessageFacts = {
      party: c.name,
      orderNo: o.orderNo,
      orderDate: o.orderDate,
      products,
      trackUrl: linkFor(base, t, forDelivery),
      invoiceNo: o.invoiceNo,
      holdTitle: extra.hold ? holdTitle(extra.hold.kind) : null,
      holdText: extra.hold?.text ?? null,
      nextUpdate: extra.hold?.nextUpdateOn ?? null,
      revised: extra.hold?.revisedOn ?? null,
      resolution: extra.hold?.resolution ?? null,
      signature: cfg["erp.logistics.signature"] || "Mahek Marketing India",
    };
    const body = trackMessage(kind, facts);
    const raw = whatsappNumberFor(c, "general");
    const phone = waNumber(raw);
    const skip = skipReason(c, raw, phone, staff);
    const id = erpId("etmsg");
    const row = { id, customerId: c.id, transportIds: [] as string[], orderNo: o.orderNo, eventId, kind, phone: phone ?? raw ?? null, body, createdById: extra.userId };
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
    const params = trackWatiParams(facts, body);
    const missing = route.params.filter((p) => !(p in params));
    if (missing.length) {
      await db.insert(erpTransportMessages).values({ ...row, status: "to_send", why: `The Wati template asks for ${missing.join(", ")}, which order tracking cannot fill.` });
      out.toSend++;
      continue;
    }
    await db.insert(erpTransportMessages).values({ ...row, status: "to_send", why: "Sending through Wati…" });
    const { sendWatiTemplate } = await import("@/lib/wati");
    const sent = await sendWatiTemplate({ templateName: route.name, phone: phone!, params: route.params.map((name) => ({ name, value: params[name] || "-" })), localMessageId: id, broadcastName: `order_${kind}_${today()}` });
    if (sent.ok) {
      await db.update(erpTransportMessages).set({ status: "sent", why: null, providerRef: sent.broadcastId, sentAt: new Date(), sentById: extra.userId }).where(eq(erpTransportMessages.id, id));
      out.sent++;
    } else {
      await db.update(erpTransportMessages).set({ status: "failed", why: sent.uncertain ? `Wati did not answer — check Wati before sending again. ${sent.error}` : sent.error }).where(eq(erpTransportMessages.id, id));
      out.failed++;
    }
  }
  return out;
}

export function sendWords(o: TrackSendOutcome | null): string {
  if (!o) return "";
  const parts = [o.sent ? `${o.sent} WhatsApp sent` : null, o.toSend + o.failed ? `${o.toSend + o.failed} to send by hand` : null, o.skipped ? `${o.skipped} customer${o.skipped === 1 ? "" : "s"} cannot be messaged` : null].filter(Boolean);
  return parts.length ? ` · ${parts.join(", ")}` : "";
}

/* ============================================================ holds */

export type OpenHold = typeof erpOrderHolds.$inferSelect;

export async function openHolds(orderNos: number[]): Promise<Map<number, OpenHold>> {
  if (!orderNos.length) return new Map();
  const rows = await db.select().from(erpOrderHolds).where(and(inArray(erpOrderHolds.orderNo, [...new Set(orderNos)]), isNull(erpOrderHolds.resolvedAt)));
  return new Map(rows.map((r) => [r.orderNo, r]));
}

/** The reasons and their sentences as a hold dialog offers them: label → sentence, for a reason the admins have reworded too. */
export async function holdSentences(kind: "hold" | "delay"): Promise<{ labels: string[]; sentence: Record<string, string> }> {
  const cfg = await getConfig();
  const { reasonsFor } = await import("./engines/order-tracking");
  const rs = reasonsFor(kind);
  return { labels: rs.map((r) => r.label), sentence: Object.fromEntries(rs.map((r) => [r.label, sentenceFor(r.code, cfg["erp.tracking.holdMessages"])])) };
}

/**
 * Records a hold or a delay on an order. The caller has already moved the
 * lines (Orders) or the consignments (Logistics); this keeps the reason, the
 * customer's sentence and the internal note apart, and tells the customer
 * where asked. One open hold per order: a second is refused, naming the first.
 */
export async function recordHold(
  ctx: Pick<ErpContext, "user"> & Partial<ErpContext>,
  orderNo: number,
  input: HoldInput & { notify?: boolean; transportIds?: string[]; lineStatuses?: Record<string, string> },
  tx: typeof db = db,
): Promise<Result<{ holdId: string }>> {
  const refusal = holdRefusal(input, today());
  if (refusal) return fieldErr(refusal.field, refusal.message);
  const [open] = await tx.select().from(erpOrderHolds).where(and(eq(erpOrderHolds.orderNo, orderNo), isNull(erpOrderHolds.resolvedAt)));
  if (open) return err(`Order ${orderNo} is already ${open.kind === "hold" ? "on hold" : "marked delayed"} (${reasonLabel(open.reason)}). Resolve that first.`, "conflict");
  const id = erpId("ohold");
  await tx.insert(erpOrderHolds).values({
    id,
    orderNo,
    kind: input.kind,
    reason: input.reason,
    customerText: input.customerText.trim(),
    internalNote: input.internalNote?.trim() || null,
    nextUpdateOn: input.nextUpdateOn || null,
    revisedDeliveryOn: input.revisedDeliveryOn || null,
    transportIds: input.transportIds ?? [],
    lineStatuses: input.lineStatuses ?? {},
    raisedById: ctx.user.id,
  });
  return ok({ holdId: id });
}

/** After the hold's transaction: the customer's message, where asked and allowed. */
export async function tellHold(holdId: string, userId: string | null, notify: boolean): Promise<TrackSendOutcome | null> {
  if (!notify) return null;
  const cfg = await getConfig();
  const [h] = await db.select().from(erpOrderHolds).where(eq(erpOrderHolds.id, holdId));
  if (!h) return null;
  const resolved = !!h.resolvedAt;
  if ((cfg["erp.tracking.notify"] ?? {})[resolved ? "resolved" : "hold"] === false) return null;
  const o = (await readOrders([h.orderNo])).get(h.orderNo);
  const t = (await liveTracking([h.orderNo])).get(h.orderNo);
  if (!o || !t) return null;
  return sendTrackMessage(o, t, resolved ? "resolved" : "hold", {
    userId,
    hold: { id: h.id, kind: h.kind as "hold" | "delay", text: h.customerText, nextUpdateOn: h.nextUpdateOn, revisedOn: h.revisedDeliveryOn, resolution: h.resolutionText },
  });
}

/** Closes an open hold, keeping it in the history. Returns what it was so the caller can put the lines back. */
export async function closeHold(userId: string | null, holdId: string, resolution: string | null, tx: typeof db = db): Promise<Result<OpenHold>> {
  const [h] = await tx.select().from(erpOrderHolds).where(eq(erpOrderHolds.id, holdId));
  if (!h) return err("That hold is gone.", "not_found");
  if (h.resolvedAt) return err("That hold is already resolved.", "conflict");
  const [row] = await tx
    .update(erpOrderHolds)
    .set({ resolvedAt: new Date(), resolvedById: userId, resolutionText: resolution?.trim() || null })
    .where(and(eq(erpOrderHolds.id, holdId), isNull(erpOrderHolds.resolvedAt)))
    .returning();
  return row ? ok(row) : err("That hold is already resolved.", "conflict");
}

/** Logistics raised a delay the customer reads as one: a delay hold on every order on these consignments. */
export async function delayFromLogistics(ctx: ErpContext, rows: { id: string; orderNo: number }[], reason: string, opts: { note?: string | null; expectedOn?: string | null; notify: boolean }): Promise<TrackSendOutcome | null> {
  const cfg = await getConfig();
  if (!cfg["erp.tracking.enabled"]) return null;
  const byOrder = new Map<number, string[]>();
  for (const r of rows) byOrder.set(r.orderNo, [...(byOrder.get(r.orderNo) ?? []), r.id]);
  const open = await openHolds([...byOrder.keys()]);
  const text = sentenceFor(reason, cfg["erp.tracking.holdMessages"]) || "There is a delay in delivering your order. We will update you as soon as we know more.";
  const total: TrackSendOutcome = { sent: 0, toSend: 0, skipped: 0, failed: 0 };
  for (const [orderNo, ids] of byOrder) {
    const was = open.get(orderNo);
    if (was?.kind === "delay") {
      /* Still delayed: the newer word on the same delay, not a second one. */
      await db
        .update(erpOrderHolds)
        .set({ reason, customerText: text, internalNote: opts.note ?? was.internalNote, revisedDeliveryOn: opts.expectedOn ?? was.revisedDeliveryOn })
        .where(eq(erpOrderHolds.id, was.id));
      continue;
    }
    if (was) continue;
    const res = await recordHold(ctx, orderNo, { kind: "delay", reason, customerText: text, internalNote: opts.note, revisedDeliveryOn: opts.expectedOn ?? null, transportIds: ids });
    if (!res.ok) continue;
    await erpAudit(ctx, "erp.tracking.delay", "erp_order", String(orderNo), null, { reason, transports: ids });
    const o = await tellHold(res.data.holdId, ctx.user.id, opts.notify);
    if (o) for (const k of Object.keys(total) as (keyof TrackSendOutcome)[]) total[k] += o[k];
  }
  return total;
}

/** The problem on the road is cleared, or the goods arrived: every open delay on these orders closes. */
export async function clearDelays(ctx: { user: { id: string } } | null, orderNos: number[], resolution: string | null): Promise<void> {
  const open = await openHolds(orderNos);
  for (const h of open.values()) if (h.kind === "delay") await closeHold(ctx?.user.id ?? null, h.id, resolution);
}

/* ============================================================ links */

/** Revokes the order's link and makes a new one. The old link, and any consignment link sent before, stop working. */
export async function regenerateTracking(ctx: ErpContext, orderNo: number): Promise<Result<{ token: string }>> {
  const o = (await readOrders([orderNo])).get(orderNo);
  if (!o) return err("That order has no live lines.", "not_found");
  const was = (await liveTracking([orderNo])).get(orderNo);
  if (!was) return err(`Order ${orderNo} has no tracking link yet — it is made when the order is verified.`, "rule_violation");
  let made: Tracking | null = null;
  await db.transaction(async (tx) => {
    await tx.update(erpOrderTracking).set({ revokedAt: new Date(), revokedById: ctx.user.id }).where(eq(erpOrderTracking.id, was.id));
    [made] = await tx
      .insert(erpOrderTracking)
      .values({ id: erpId("otrk"), orderNo, token: newTrackingToken(), deliveryToken: was.deliveryToken ? newTrackingToken() : null, backfilled: was.backfilled, legacyLinks: false, createdById: ctx.user.id })
      .returning();
  });
  await erpAudit(ctx, "erp.tracking.regenerate", "erp_order", String(orderNo), { tracking: was.id }, { tracking: made!.id });
  return ok({ token: made!.token }, `New tracking link for order ${orderNo}. The old link no longer opens.`);
}

/* ============================================================ the documents */

/**
 * The order's invoice PDF: its own, else the one attached to another order on the
 * SAME invoice — one Tally invoice may cover several orders of one party, and its
 * PDF is attached once. Never another party's: an invoice is one party's.
 */
async function invoiceFile(orderNo: number): Promise<{ id: string; filename: string } | null> {
  const rows = (await db.execute(sql`
    select a.id, a.filename
      from attachments a
     where a.parent_type = 'erp_invoice' and a.status = 'available'
       and (a.parent_id = ${String(orderNo)}
            or a.parent_id in (
              select distinct o2.order_no::text
                from erp_orders o
                join erp_orders o2 on o2.billing_customer_id = o.billing_customer_id
                  and o2.status <> 'Cancel'
                  and upper(regexp_replace(coalesce(o2.tally_bill_no, ''), '\s', '', 'g')) = upper(regexp_replace(o.tally_bill_no, '\s', '', 'g'))
               where o.order_no = ${orderNo} and o.status <> 'Cancel' and coalesce(o.tally_bill_no, '') <> ''))
     order by (a.parent_id = ${String(orderNo)}) desc, a.created_at desc
     limit 1
  `)) as unknown as { id: string; filename: string }[];
  return rows[0] ? { id: String(rows[0].id), filename: String(rows[0].filename) } : null;
}

export async function invoiceFileFor(orderNo: number) {
  return invoiceFile(orderNo);
}

/* ============================================================ the reads */

export type TrackingDoc = { available: boolean; label: string; detail: string | null };

export type OrderTrackingView = {
  orderNo: number;
  orderDate: string;
  view: "full" | "delivery";
  deliverTo: string;
  status: { label: string; current: Step | null; lastUpdated: string | null; delivered: boolean };
  expectedOn: string | null;
  deliveredOn: string | null;
  receivedBy: string | null;
  transporter: string | null;
  lrNo: string | null;
  hold: { title: string; text: string; at: string; nextUpdateOn: string | null; revisedOn: string | null } | null;
  /** 0296 — the way the goods have come (after dispatch only), where they are going, and where to collect them. */
  route: TrackingStop[];
  destination: string | null;
  pickup: { point: string; contact: string | null } | null;
  products: ProductRow[];
  entries: JourneyEntry[];
  folded: boolean;
  unreported: string[];
  documents: { invoice: TrackingDoc; lr: TrackingDoc };
  token: string;
};

async function viewOf(t: Tracking, view: "full" | "delivery", token: string): Promise<OrderTrackingView | null> {
  const no = t.orderNo;
  const [orders, transports, recorded, holds, cfg] = await Promise.all([
    readOrders([no]),
    readTransports([no]),
    db.select().from(erpOrderMilestones).where(and(eq(erpOrderMilestones.orderNo, no), isNull(erpOrderMilestones.withdrawnAt))),
    db.select().from(erpOrderHolds).where(eq(erpOrderHolds.orderNo, no)),
    getConfig(),
  ]);
  const o = orders.get(no);
  if (!o) return null;
  const ts = transports.get(no) ?? [];
  const holdRecords: HoldRecord[] = holds
    .sort((a, b) => a.raisedAt.getTime() - b.raisedAt.getTime())
    .map((h) => ({
      kind: h.kind as "hold" | "delay",
      reason: h.reason,
      customerText: h.customerText,
      raisedAt: h.raisedAt.toISOString(),
      nextUpdateOn: h.nextUpdateOn,
      revisedDeliveryOn: h.revisedDeliveryOn,
      resolvedAt: h.resolvedAt ? h.resolvedAt.toISOString() : null,
      resolutionText: h.resolutionText,
    }));
  const rec: Recorded[] = recorded.map((r) => ({ step: r.step as Step, at: r.at.toISOString(), note: r.note }));
  const ownVehicle = ts.length > 0 && ts.every((x) => x.ownVehicle);
  const journey = buildJourney(rec, holdRecords, reasonLabel, { ownVehicle });
  const delivered = journey.current === "delivered";
  const latest = ts.at(-1) ?? null;
  const hold = journey.openHold;
  const invoiceLive = rec.some((r) => r.step === "invoice");
  const inv = view === "full" && invoiceLive && cfg["erp.tracking.showInvoice"] ? await invoiceFile(no) : null;
  const lrLive = rec.some((r) => r.step === "lr") && !!latest?.lrNo;
  const lrFile = lrLive && cfg["erp.tracking.showLr"] ? ts.find((x) => x.lrFileId)?.lrFileId ?? null : null;
  /* Our own vehicle's proof is the copy the customer signed — shown once the delivery is confirmed. */
  const signedFile = ownVehicle && delivered && cfg["erp.tracking.showLr"] ? ts.find((x) => x.signedCopyFileId)?.signedCopyFileId ?? null : null;
  const dispatched = rec.some((r) => r.step === "dispatched");
  return {
    orderNo: no,
    orderDate: o.orderDate,
    view,
    deliverTo: [o.deliveryName, o.deliveryCity].filter(Boolean).join(", "),
    status: { label: journey.currentLabel, current: journey.current, lastUpdated: journey.lastUpdated, delivered },
    expectedOn: dispatched && !delivered ? (hold?.revisedDeliveryOn ?? latest?.expectedOn ?? null) : null,
    deliveredOn: delivered ? (latest?.deliveredOn ?? null) : null,
    receivedBy: delivered ? (latest?.receivedBy ?? null) : null,
    transporter: dispatched ? (latest?.transporter ?? null) : null,
    lrNo: latest?.lrNo ?? null,
    hold: hold ? { title: holdTitle(hold.kind), text: hold.customerText, at: hold.raisedAt, nextUpdateOn: hold.nextUpdateOn, revisedOn: hold.revisedDeliveryOn } : null,
    route: dispatched ? (latest?.route ?? []) : [],
    destination: dispatched && !delivered ? (latest?.destination ?? null) : null,
    pickup: !delivered && latest?.stage === "Ready for Pickup" && latest.pickupPoint ? { point: latest.pickupPoint, contact: latest.pickupContact } : null,
    products: productRows(o.lines.map((l) => l.product)),
    entries: journey.entries,
    folded: journey.folded,
    unreported: journey.unreported.map((s) => STEP_LABEL[s]),
    documents: {
      invoice:
        view === "delivery"
          ? { available: false, label: "Sales Invoice", detail: "Sent to the party who placed the order." }
          : inv
            ? { available: true, label: "Sales Invoice", detail: [o.invoiceNo, o.invoiceDate ? longDay(o.invoiceDate) : null].filter(Boolean).join(" · ") || null }
            : { available: false, label: "Sales Invoice", detail: invoiceLive && cfg["erp.tracking.showInvoice"] ? "Your invoice will be shared with you separately." : "Will appear here when available" },
      lr: ownVehicle
        ? signedFile
          ? { available: true, label: "Signed delivery copy", detail: [latest?.receivedBy ? `Received by ${latest.receivedBy}` : null, latest?.deliveredOn ? longDay(latest.deliveredOn) : null].filter(Boolean).join(" · ") || null }
          : { available: false, label: "Signed delivery copy", detail: "Will appear here after delivery" }
        : lrFile
          ? { available: true, label: "LR Copy (Lorry Receipt)", detail: [latest?.lrNo ? `LR ${latest.lrNo}` : null, latest?.lrDate ? longDay(latest.lrDate) : null].filter(Boolean).join(" · ") || null }
          : { available: false, label: "LR Copy (Lorry Receipt)", detail: lrLive && latest?.lrNo ? `LR ${latest.lrNo}` : "Will appear here when available" },
    },
    token,
  };
}

/** The tracking row a link names, and which view it opens — or null for a link that names nothing or was revoked. */
async function byToken(token: string): Promise<{ t: Tracking; view: "full" | "delivery" } | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const [t] = await db
    .select()
    .from(erpOrderTracking)
    .where(and(isNull(erpOrderTracking.revokedAt), sql`(${erpOrderTracking.token} = ${token} or ${erpOrderTracking.deliveryToken} = ${token})`));
  if (!t) return null;
  return { t, view: t.token === token ? "full" : "delivery" };
}

/** The customer's page, read through the link. Counts the open; shows nothing internal. */
export async function publicOrderTracking(token: string): Promise<OrderTrackingView | null> {
  const hit = await byToken(token);
  if (!hit) return null;
  await db
    .update(erpOrderTracking)
    .set({ opens: sql`${erpOrderTracking.opens} + 1`, lastOpenedAt: new Date() })
    .where(eq(erpOrderTracking.id, hit.t.id))
    .catch(() => undefined);
  return viewOf(hit.t, hit.view, token);
}

/**
 * A consignment link sent before order tracking (/track/<token>): the order's
 * link it now stands for. Those links went to the billing and the delivery
 * party alike, so where the two differ it opens the delivery view — never the
 * invoice. Null where the order has no link, or a regenerate retired them.
 */
export async function orderLinkForConsignment(transportToken: string): Promise<string | null> {
  if (!/^[a-z0-9]{12,40}$/i.test(transportToken)) return null;
  const rows = (await db.execute(sql`
    select k.token, k.delivery_token as "deliveryToken", k.legacy_links as legacy
      from erp_transports t
      join erp_order_tracking k on k.order_no = t.order_no and k.revoked_at is null
     where t.track_token = ${transportToken}
     limit 1
  `)) as unknown as { token: string; deliveryToken: string | null; legacy: boolean }[];
  const r = rows[0];
  if (!r || !r.legacy) return null;
  return r.deliveryToken ?? r.token;
}

/** Whether a retired order link swallowed this consignment link (so the old page must not answer either). */
export async function consignmentLinkRetired(transportToken: string): Promise<boolean> {
  if (!/^[a-z0-9]{12,40}$/i.test(transportToken)) return false;
  const rows = (await db.execute(sql`
    select 1 from erp_transports t
      join erp_order_tracking k on k.order_no = t.order_no and k.revoked_at is null and not k.legacy_links
     where t.track_token = ${transportToken} limit 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** A document through the customer's link: only this order's, only once it is available, never the invoice on a delivery view. */
export async function publicDocument(token: string, kind: string): Promise<{ id: string } | null> {
  const hit = await byToken(token);
  if (!hit) return null;
  const v = await viewOf(hit.t, hit.view, token);
  if (!v) return null;
  if (kind === "invoice") {
    if (!v.documents.invoice.available) return null;
    const f = await invoiceFile(hit.t.orderNo);
    return f ? { id: f.id } : null;
  }
  if (kind === "lr") {
    if (!v.documents.lr.available) return null;
    const ts = (await readTransports([hit.t.orderNo])).get(hit.t.orderNo) ?? [];
    const id = ts.length && ts.every((x) => x.ownVehicle) ? ts.find((x) => x.signedCopyFileId)?.signedCopyFileId : ts.find((x) => x.lrFileId)?.lrFileId;
    return id ? { id } : null;
  }
  return null;
}

/* ============================================================ the staff panel */

export type TrackingPanel = {
  orderNo: number;
  link: string | null;
  deliveryLink: string | null;
  opens: number;
  lastOpenedAt: string | null;
  createdAt: string | null;
  backfilled: boolean;
  preview: OrderTrackingView | null;
  hold: (OpenHold & { reasonLabel: string }) | null;
  history: { kind: string; label: string; at: string; reason: string; customerText: string; internalNote: string | null; resolvedAt: string | null; resolutionText: string | null }[];
  messages: { id: string; kind: string; label: string; customer: string; phone: string | null; status: string; why: string | null; body: string; at: string; waLink: string | null }[];
  confirmationText: string | null;
  invoiceFile: { id: string; filename: string } | null;
  notConfirmedYet: boolean;
};

const MESSAGE_LABEL: Record<string, string> = {
  confirmed: "Order confirmed",
  invoice: "Invoice available",
  dispatched: "Dispatched",
  hold: "On hold / delayed",
  resolved: "Hold resolved",
  lr: "LR available",
  stage: "Transport update",
  issue: "Problem on the road",
  delivered: "Delivered",
};

/** Everything the order record's Customer tracking tab draws. Read by somebody holding Orders. */
export async function trackingPanel(orderNo: number): Promise<TrackingPanel> {
  const [t] = await db.select().from(erpOrderTracking).where(and(eq(erpOrderTracking.orderNo, orderNo), isNull(erpOrderTracking.revokedAt)));
  const base = await messageOrigin();
  const preview = t ? await viewOf(t, "full", t.token) : null;
  const holds = await db.select().from(erpOrderHolds).where(eq(erpOrderHolds.orderNo, orderNo));
  const open = holds.find((h) => !h.resolvedAt) ?? null;
  const msgs = (await db.execute(sql`
    select m.id, m.kind, c.name as customer, m.phone, m.status, m.why, m.body, m.created_at as at
      from erp_transport_messages m join customers c on c.id = m.customer_id
     where m.order_no = ${orderNo}
        or m.transport_ids && coalesce((select array_agg(t.id) from erp_transports t where t.order_no = ${orderNo}), '{}'::text[])
     order by m.created_at desc limit 40
  `)) as unknown as Row[];
  const o = (await readOrders([orderNo])).get(orderNo);
  const confirmationText =
    t && o
      ? trackMessage("confirmed", {
          party: o.billingName,
          orderNo,
          orderDate: o.orderDate,
          products: productRows(o.lines.map((l) => l.product)),
          trackUrl: linkFor(base, t, false),
          signature: "Mahek Marketing India",
        })
      : null;
  const { waLink } = await import("./engines/logistics");
  return {
    orderNo,
    link: t ? linkFor(base, t, false) ?? `/t/${t.token}` : null,
    deliveryLink: t?.deliveryToken ? (linkFor(base, t, true) ?? `/t/${t.deliveryToken}`) : null,
    opens: t?.opens ?? 0,
    lastOpenedAt: t?.lastOpenedAt ? t.lastOpenedAt.toISOString() : null,
    createdAt: t ? t.createdAt.toISOString() : null,
    backfilled: t?.backfilled ?? false,
    preview,
    hold: open ? { ...open, reasonLabel: reasonLabel(open.reason) } : null,
    history: holds
      .sort((a, b) => b.raisedAt.getTime() - a.raisedAt.getTime())
      .map((h) => ({ kind: h.kind, label: holdTitle(h.kind as "hold" | "delay"), at: h.raisedAt.toISOString(), reason: reasonLabel(h.reason), customerText: h.customerText, internalNote: h.internalNote, resolvedAt: h.resolvedAt ? h.resolvedAt.toISOString() : null, resolutionText: h.resolutionText })),
    messages: msgs.map((m) => ({
      id: String(m.id),
      kind: String(m.kind),
      label: MESSAGE_LABEL[String(m.kind)] ?? String(m.kind),
      customer: String(m.customer),
      phone: str(m.phone),
      status: String(m.status),
      why: str(m.why),
      body: String(m.body),
      at: iso(m.at)!,
      waLink: ["to_send", "failed"].includes(String(m.status)) ? waLink(str(m.phone), String(m.body)) : null,
    })),
    confirmationText,
    invoiceFile: await invoiceFile(orderNo),
    notConfirmedYet: !t,
  };
}

/* ============================================================ invoice PDF */

/** Binds an uploaded invoice PDF to the order. Only a file this person uploaded and nobody has claimed. */
export async function bindInvoiceFile(tx: typeof db, fileId: string | null | undefined, orderNo: number, userId: string): Promise<boolean> {
  if (!fileId) return false;
  const rows = await tx
    .update(attachments)
    .set({ parentType: "erp_invoice", parentId: String(orderNo), updatedAt: new Date() })
    .where(and(eq(attachments.id, fileId), isNull(attachments.parentId), eq(attachments.uploadedById, userId)))
    .returning({ id: attachments.id });
  return rows.length > 0;
}

