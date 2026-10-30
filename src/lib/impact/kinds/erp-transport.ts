import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpLrs, erpTransportPayments, erpTransporters, erpTransports, erpTrips, orders } from "@/db/schema";
import { readTransporterMergeKey, readTransporterRenameKey } from "@/lib/erp/transporter-keys";
import { lrClashes, nameUses } from "@/lib/erp/transporter-rename";
import { bookOrderRef, erpOrdersLive } from "@/lib/erp/book";
import { CLOSED, lrUploadName, shortDay } from "@/lib/erp/engines/logistics";
import { inrRate, nf } from "@/lib/erp/ui";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present } from "./erp-common";

/* ---------------------------------------------------------------------------
 * THE LOGISTICS DESK'S UNDOS. Nothing on this desk is ever deleted — an LR is
 * voided, a payment reversed, a delivery reopened — so the question a person
 * cannot answer from the row they pressed is what ELSE reads the thing they
 * are taking back: the bills a payment was shared over, the order the CRM and
 * Accounts read as delivered, the trip a bill leaves short.
 *
 * Every act is the Logistics screen's (`requireErpWrite("transport")`), so the
 * modal is too: somebody who cannot open the desk cannot read its trips and
 * payments by asking what reversing one would touch.
 * ------------------------------------------------------------------------- */

const onTheDesk = async () => {
  await erpMayDelete(["transport"]);
};

/* ================================================================ void an LR */

export const lrVoidImpact: ImpactSource = {
  authorize: onTheDesk,

  async report(id) {
    const [lr] = await db.select().from(erpLrs).where(eq(erpLrs.id, id));
    if (!lr || lr.status === "void") return null;
    /* What `voidLr` refuses on — a delivered bill, or a signed copy closing one — and what it takes
       off in passing: the bills still on the road, which go back to waiting for their LR. */
    const carrying = (await db.execute(sql`
      select order_no as "orderNo", material_stage = ${CLOSED} as delivered, signed_copy_id is not distinct from ${id} as "closes"
        from erp_transports where lr_id = ${id} or signed_copy_id = ${id} order by order_no
    `)) as unknown as { orderNo: number; delivered: boolean; closes: boolean }[];
    const delivered = carrying.filter((c) => c.delivered || c.closes);
    const open = carrying.filter((c) => !c.delivered && !c.closes);
    const orderList = (cs: { orderNo: number }[]) => `order ${cs.slice(0, 5).map((c) => c.orderNo).join(", ")}${cs.length > 5 ? "…" : ""}`;
    const blockers: string[] = [];
    if (delivered.length) {
      blockers.push(`This LR is attached to ${nf(delivered.length)} ${many(delivered.length, "bill")} already delivered (${orderList(delivered)}). A delivered bill keeps its LR — reopen it first.`);
    }
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: "bills taken off this LR — they leave On the road and wait for their LR on the Documents desk",
        effect: "changed",
        count: open.length,
        note: open.length ? `${orderList(open)}. The party is not messaged; attaching the right LR tells them.` : undefined,
      },
      {
        app: "ERP",
        label: `${lrUploadName(lr.lrNo)} ${lr.status === "unassigned" ? "leaves the Documents desk, marked void" : "is marked void"} with your reason — nothing is erased`,
        effect: "changed",
        count: 1,
        note: [lr.transporter, lr.lrDate ? `dated ${shortDay(lr.lrDate)}` : null, lr.destination ? `to ${lr.destination}` : null].filter(Boolean).join(" · ") || undefined,
      },
      {
        app: "ERP",
        label: "photo of the LR",
        effect: "kept",
        count: lr.fileId ? 1 : 0,
        note: "It stays on the record beside the reason, so a voided upload can still be checked.",
      },
    ];
    return {
      title: lrUploadName(lr.lrNo),
      verb: "Void",
      confirmWord: lr.lrNo && lr.lrNo.length <= 40 ? lr.lrNo : "VOID",
      items: present(items),
      blockers,
    };
  },
};

/* ===================================================== a bill off its trip */

export const tripBillImpact: ImpactSource = {
  authorize: onTheDesk,

  async report(id) {
    const [t] = await db
      .select({ id: erpTransports.id, orderNo: erpTransports.orderNo, billNo: erpTransports.billNo, tripId: erpTransports.tripId, vehicleNo: erpTransports.vehicleNo })
      .from(erpTransports)
      .where(eq(erpTransports.id, id));
    if (!t) return null;
    const order = `Order ${t.orderNo}`;
    if (!t.tripId) {
      return { title: order, verb: "Remove", confirmWord: String(t.orderNo), items: [], blockers: ["That bill is on no trip."] };
    }
    const [[trip], others, [held], [paid]] = await Promise.all([
      db.select({ tripNo: erpTrips.tripNo, vehicleNo: erpTrips.vehicleNo }).from(erpTrips).where(eq(erpTrips.id, t.tripId)),
      db.execute(sql`
        select order_no as "orderNo", bill_no as "billNo" from erp_transports
         where trip_id = ${t.tripId} and id <> ${id} order by order_no limit 6
      `) as unknown as Promise<{ orderNo: number; billNo: string | null }[]>,
      db.execute(sql`
        select (select count(*)::int from erp_transports where trip_id = ${t.tripId} and id <> ${id}) as others,
               (select count(*)::int from erp_transport_allocations where transport_id = ${id} and not reversed) as shares
      `) as unknown as Promise<{ others: number; shares: number }[]>,
      db.execute(sql`select count(*)::int as n from erp_transport_payments where trip_id = ${t.tripId} and status <> 'reversed'`) as unknown as Promise<{ n: number }[]>,
    ]);
    const tripNo = trip?.tripNo ?? 0;
    const blockers: string[] = [];
    /* `removeFromTrip` refuses the same way: the share is part of the trip's cost and would leave with the bill. */
    if (Number(held?.shares ?? 0)) blockers.push(`Order ${t.orderNo} carries a share of this trip's transport payment; reverse the payment first.`);
    const rest = Number(held?.others ?? 0);
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `bill taken off trip ${tripNo} — it waits with the bills on no trip`,
        effect: "changed",
        count: 1,
        note: t.vehicleNo ? `It keeps the vehicle number dispatch recorded (${t.vehicleNo}) until it is put on another trip.` : undefined,
      },
      {
        app: "ERP",
        label: `other ${many(rest, "bill")} on trip ${tripNo}`,
        effect: "kept",
        count: rest,
        examples: others.slice(0, 5).map((o) => o.billNo ?? `Order ${o.orderNo}`),
      },
    ];
    if (!rest) {
      items.push({
        app: "ERP",
        label: `trip ${tripNo}${trip?.vehicleNo ? ` · ${trip.vehicleNo}` : ""}, with no bills on it`,
        effect: "kept",
        count: 1,
        note: "The trip itself stays — it is not deleted when its last bill leaves.",
      });
    }
    if (Number(paid?.n ?? 0)) {
      items.push({
        app: "ERP",
        label: `transport ${many(Number(paid.n), "payment")} recorded on trip ${tripNo}`,
        effect: "kept",
        count: Number(paid.n),
        note: "None of it was shared to this bill, so none of it moves.",
      });
    }
    return {
      title: `${t.billNo ?? order} on trip ${tripNo}`,
      verb: "Remove",
      confirmWord: String(t.orderNo),
      items: present(items),
      blockers,
    };
  },
};

/* ============================================ reverse a transport payment */

export const transportPaymentImpact: ImpactSource = {
  authorize: onTheDesk,

  async report(id) {
    const [p] = await db
      .select({ p: erpTransportPayments, tripNo: erpTrips.tripNo })
      .from(erpTransportPayments)
      .innerJoin(erpTrips, eq(erpTrips.id, erpTransportPayments.tripId))
      .where(eq(erpTransportPayments.id, id));
    if (!p) return null;
    const pay = p.p;
    const [shares, [{ n: others }]] = await Promise.all([
      db.execute(sql`
        select t.order_no as "orderNo", t.bill_no as "billNo", a.amount_paise::float8 as share
          from erp_transport_allocations a join erp_transports t on t.id = a.transport_id
         where a.payment_id = ${id} and not a.reversed
         order by t.order_no
      `) as unknown as Promise<{ orderNo: number; billNo: string | null; share: number }[]>,
      db.execute(sql`
        select count(*)::int as n from erp_transport_payments where trip_id = ${pay.tripId} and id <> ${id} and status <> 'reversed'
      `) as unknown as Promise<{ n: number }[]>,
    ]);
    const blockers = pay.status === "reversed" ? ["That payment is already reversed."] : [];
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `transport payment of ${inrRate(pay.amountPaise)} marked reversed`,
        effect: "changed",
        count: 1,
        note: [pay.paidOn ? `Paid ${shortDay(pay.paidOn)}` : null, pay.paidTo ? `to ${pay.paidTo}` : null, pay.reference ? `ref ${pay.reference}` : null].filter(Boolean).join(" · ") || undefined,
      },
      {
        app: "ERP",
        label: `${many(shares.length, "bill")} lose their share of it and can be shared again`,
        effect: "changed",
        count: shares.length,
        examples: shares.slice(0, 5).map((s) => `${s.billNo ?? `Order ${s.orderNo}`} · ${inrRate(s.share)}`),
        note: "Each bill's transport cost on the bills register goes blank until another payment is shared over it.",
      },
      {
        app: "ERP",
        label: `other transport ${many(Number(others), "payment")} on trip ${p.tripNo}`,
        effect: "kept",
        count: Number(others),
      },
      {
        app: "ERP",
        label: "payment and its shares on the record",
        effect: "kept",
        count: 1,
        note: "Nothing is deleted: they stay, struck through, with who reversed it and why. Logistics records payments; reversing one makes or recalls none.",
      },
    ];
    return {
      title: `the ${inrRate(pay.amountPaise)} payment on trip ${p.tripNo}`,
      verb: "Reverse",
      confirmWord: "REVERSE",
      items: present(items),
      blockers,
    };
  },
};

/* ===================================================== reopen a delivery */

export const deliveryReopenImpact: ImpactSource = {
  authorize: onTheDesk,

  async report(id) {
    const [t] = await db.select().from(erpTransports).where(eq(erpTransports.id, id));
    if (!t) return null;
    const name = t.billNo ?? `Order ${t.orderNo}`;
    if (t.materialStage !== CLOSED) {
      return { title: name, verb: "Reopen", confirmWord: String(t.orderNo), items: [], blockers: ["That bill is not closed."] };
    }
    const stage = t.lrNo ? "Reached Destination Area" : "At transport";
    const [[sent], [waiting], live] = await Promise.all([
      db.execute(sql`
        select count(*)::int as n from erp_transport_messages
         where kind = 'delivered' and ${id} = any(transport_ids) and status in ('sent', 'sent_by_hand', 'delivered', 'read')
      `) as unknown as Promise<{ n: number }[]>,
      db.execute(sql`
        select count(*)::int as n from erp_transport_messages
         where kind = 'delivered' and ${id} = any(transport_ids) and status in ('to_send', 'failed')
      `) as unknown as Promise<{ n: number }[]>,
      erpOrdersLive(),
    ]);
    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: `bill back on the road at "${stage}", with a call to the transporter due today`,
        effect: "changed",
        count: 1,
      },
      {
        app: "ERP",
        label: "delivery record cleared",
        effect: "changed",
        count: 1,
        note: [
          t.deliveredOn ? `Delivered ${shortDay(t.deliveredOn)}` : null,
          t.receivedBy ? `received by ${t.receivedBy}` : null,
          t.deliveryProof ? `proof: ${t.deliveryProof}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "The day, who received it and the proof are taken off the bill; the reopening is logged with your reason.",
      },
    ];
    if (live) {
      const [book] = await db.select({ status: orders.status }).from(orders).where(eq(orders.externalRef, bookOrderRef(t.orderNo)));
      if (book?.status === "delivered") {
        items.push({
          app: "Accounts",
          label: `order ${bookOrderRef(t.orderNo)} in the order book no longer reads delivered`,
          effect: "changed",
          count: 1,
          note: "It reads in transit again — what Accounts and the CRM show for the order. It still counts as sold: goods on a lorry are goods sold.",
        });
      }
    }
    items.push({
      app: "ERP",
      label: `"delivered" ${many(Number(sent?.n ?? 0), "message")} the customer was already sent`,
      effect: "kept",
      count: Number(sent?.n ?? 0),
      note: "The customer is not messaged that it was reopened — tell them if they need to know.",
    });
    items.push({
      app: "ERP",
      label: `"delivered" ${many(Number(waiting?.n ?? 0), "message")} still waiting to be sent`,
      effect: "kept",
      count: Number(waiting?.n ?? 0),
      note: "It still says delivered. Skip it on Messages, or it will tell the customer the goods arrived.",
    });
    return {
      title: name,
      verb: "Reopen",
      confirmWord: String(t.orderNo),
      items: present(items),
      blockers: [],
    };
  },
};

/* ============================================= a transporter renamed or merged */

const usesAsItems = (uses: { use: { label: string; one: string }; count: number }[], to: string): ImpactItem[] =>
  present(uses.map(({ use, count }) => ({ app: "ERP", label: count === 1 ? use.one : use.label, effect: "changed" as const, count, note: `Will read "${to}".` })));

export const transporterRenameImpact: ImpactSource = {
  authorize: onTheDesk,

  async report(key) {
    const { id, name } = readTransporterRenameKey(key);
    const [t] = await db.select().from(erpTransporters).where(eq(erpTransporters.id, id));
    if (!t || !name) return null;
    const blockers: string[] = [];
    const [other] = (await db.execute(sql`select name from erp_transporters where lower(name) = ${name.toLowerCase()} and id <> ${id} limit 1`)) as unknown as { name: string }[];
    if (other) blockers.push(`${other.name} is already in the list. Close this and use Merge into… on ${t.name} to fold the two together.`);
    const clash = await lrClashes(t.name, name);
    if (clash.length) blockers.push(`${name} already has LRs numbered ${clash.slice(0, 5).join(", ")}, the same as ${t.name}'s — an LR number has to be unique for a transporter. Fix those LRs first.`);
    const uses = await nameUses(t.name);
    const items = usesAsItems(uses, name);
    return {
      title: `${t.name} → ${name}`,
      verb: "Rename",
      confirmWord: "RENAME",
      items: items.length ? items : [{ app: "ERP", label: "Nothing else carries this name yet — only the transporter list changes", effect: "kept", count: 0 }],
      blockers,
    };
  },
};

export const transporterMergeImpact: ImpactSource = {
  authorize: onTheDesk,

  async report(key) {
    const { fromId, intoId } = readTransporterMergeKey(key);
    if (!fromId || fromId === intoId) return null;
    const [from] = await db.select().from(erpTransporters).where(eq(erpTransporters.id, fromId));
    const [into] = await db.select().from(erpTransporters).where(eq(erpTransporters.id, intoId));
    if (!from || !into) return null;
    const clash = await lrClashes(from.name, into.name);
    const blockers = clash.length
      ? [`Both have LRs numbered ${clash.slice(0, 5).join(", ")} — an LR number has to be unique for a transporter. Void or fix the duplicate first.`]
      : [];
    const [{ n: godowns }] = (await db.execute(sql`select count(*)::int as n from erp_transporter_godowns where transporter_id = ${fromId}`)) as unknown as { n: number }[];
    const items: ImpactItem[] = [
      { app: "ERP", label: `${from.name} leaves the transporter list`, effect: "deleted", count: 1 },
      ...usesAsItems(await nameUses(from.name), into.name),
      { app: "ERP", label: Number(godowns) === 1 ? "godown, with its people" : "godowns, with their people", effect: "changed", count: Number(godowns), note: `Move to ${into.name}.` },
    ];
    return {
      title: `${from.name} into ${into.name}`,
      verb: "Merge",
      confirmWord: "MERGE",
      items: present(items),
      blockers,
    };
  },
};
