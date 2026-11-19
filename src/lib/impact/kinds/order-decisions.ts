import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers, erpOrderIntakeLines, erpOrderIntakes, orders, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { requireCapability } from "@/lib/access-control";
import { money } from "@/lib/format";
import type { ImpactBody, ImpactSource } from "../registry";
import type { ImpactItem } from "../types";
import { many, present } from "./crm-common";

/* ---------------------------------------------------------------------------
 * AN ORDER TURNED DOWN, said before it happens.
 *
 * Four acts end or return an order that somebody took on a call: the taker
 * cancelling their own TO, Accounts declining a TO, sending one back, and
 * declining a numbered order. Each needs a reason — the person who took it
 * rings the customer with it — and each used to be a plain reason box that
 * wrote at once. What they reach is wider than the row: the CRM's order row
 * beside the TO, the customer's buying cycle and so their place on the Call
 * Log, the taker's bell, the customer timeline. These reports say so.
 *
 * Every blocker is the act's own refusal in the act's own words, so the modal
 * and the write cannot disagree about whether it may happen.
 * ------------------------------------------------------------------------- */

const refuse = (message: string) => Object.assign(new Error(message), { name: "NotPermittedError" });

type IntakeFacts = {
  intake: typeof erpOrderIntakes.$inferSelect;
  customer: string;
  taker: string | null;
  lines: number;
  cans: number;
  valuePaise: number;
};

async function intakeFacts(id: string): Promise<IntakeFacts | null> {
  const [row] = await db
    .select({ intake: erpOrderIntakes, customer: customers.name, taker: users.name })
    .from(erpOrderIntakes)
    .innerJoin(customers, eq(customers.id, erpOrderIntakes.billingCustomerId))
    .leftJoin(users, eq(users.id, erpOrderIntakes.takenById))
    .where(eq(erpOrderIntakes.id, id));
  if (!row) return null;
  const lines = await db
    .select({ qtyCans: erpOrderIntakeLines.qtyCans, ratePaise: erpOrderIntakeLines.ratePaise })
    .from(erpOrderIntakeLines)
    .where(eq(erpOrderIntakeLines.intakeId, id));
  return {
    intake: row.intake,
    customer: row.customer,
    taker: row.taker,
    lines: lines.length,
    cans: lines.reduce((s, l) => s + Number(l.qtyCans), 0),
    valuePaise: lines.reduce((s, l) => s + Number(l.qtyCans) * Number(l.ratePaise ?? 0), 0),
  };
}

const toTitle = (f: IntakeFacts) =>
  `TO-${f.intake.toNo} for ${f.customer}${f.valuePaise > 0 ? `, ${money(f.valuePaise)}` : ""}`;

/** The TO itself, and the CRM order row a CRM or handset TO carries beside it. */
function toItems(f: IntakeFacts, becomes: string): ImpactItem[] {
  return [
    {
      app: "Accounts",
      label: "TO",
      effect: "changed",
      count: 1,
      examples: [`TO-${f.intake.toNo} · ${f.lines} ${many(f.lines, "product")} · ${f.cans.toLocaleString("en-IN")} cans`],
      note: `It ${becomes}. No order number is made, so the factory never sees it.`,
    },
    {
      app: "CRM",
      label: "order on the customer's record",
      effect: "changed",
      count: f.intake.originOrderId ? 1 : 0,
      note: "It stops counting as placed, so the customer returns to the Call Log on their own buying cycle.",
    },
  ];
}

/* ===================================== the taker cancels their own TO (CRM) */

/** `cancelMyToAction` — the same door: My orders, and only the person who took it. */
export const myToCancelImpact: ImpactSource = {
  async authorize(id) {
    const user = await requireUser();
    if (!(await canOpenModule(user.id, "crm.my-orders"))) throw refuse("My orders is not part of your access.");
    const [row] = await db
      .select({ takenById: erpOrderIntakes.takenById, author: orders.userId })
      .from(erpOrderIntakes)
      .leftJoin(orders, eq(orders.id, erpOrderIntakes.originOrderId))
      .where(eq(erpOrderIntakes.id, id));
    if (row && row.takenById !== user.id && row.author !== user.id) {
      throw refuse("Only the person who took this order can change it here. Ask Accounts.");
    }
  },

  async report(id): Promise<ImpactBody | null> {
    const f = await intakeFacts(id);
    if (!f) return null;
    const s = f.intake.status;
    return {
      title: toTitle(f),
      verb: "Cancel",
      confirmWord: `TO-${f.intake.toNo}`,
      items: present([
        ...toItems(f, "is cancelled with your reason and leaves Accounts' Order approvals"),
        {
          app: "Accounts",
          label: "TO waiting in Order approvals",
          effect: "changed",
          count: s === "open" ? 1 : 0,
          note: "Whoever was about to check it no longer sees it.",
        },
      ]),
      blockers:
        s === "open" || s === "correction"
          ? []
          : [`TO-${f.intake.toNo} can no longer be cancelled from here.`],
    };
  },
};

/* ========================================= Accounts decline or send back a TO */

const accountsDecide = async () => {
  await requireCapability("order.approve");
};

/** `declineToAction` — the TO is declined; the taker is told and the timeline says why. */
export const toDeclineImpact: ImpactSource = {
  authorize: accountsDecide,
  async report(id): Promise<ImpactBody | null> {
    const f = await intakeFacts(id);
    if (!f) return null;
    return {
      title: toTitle(f),
      verb: "Decline",
      confirmWord: `TO-${f.intake.toNo}`,
      items: present([
        ...toItems(f, "is declined with your reason"),
        {
          app: "CRM",
          label: "line on the customer's timeline",
          effect: "changed",
          count: 1,
          note: "The reason is written there, for whoever rings the customer next.",
        },
        {
          app: "CRM",
          label: `notification to ${f.taker ?? "whoever took it"}`,
          effect: "changed",
          count: f.intake.takenById ? 1 : 0,
          note: "They are told the reason, so they can ring the customer back.",
        },
      ]),
      blockers: ["open", "correction", "hold"].includes(f.intake.status)
        ? []
        : [`TO-${f.intake.toNo} is not waiting for Accounts.`],
    };
  },
};

/** `sendBackToAction` — back to whoever took it, both checks cleared. */
export const toSendBackImpact: ImpactSource = {
  authorize: accountsDecide,
  async report(id): Promise<ImpactBody | null> {
    const f = await intakeFacts(id);
    if (!f) return null;
    const checked = [f.intake.backOfficeAt ? "the back office check" : null, f.intake.productionAt ? "the production check" : null].filter(Boolean);
    return {
      title: toTitle(f),
      verb: "Send back",
      confirmWord: `TO-${f.intake.toNo}`,
      items: present([
        {
          app: "Accounts",
          label: "TO",
          effect: "changed",
          count: 1,
          examples: [`TO-${f.intake.toNo} · ${f.lines} ${many(f.lines, "product")} · ${f.cans.toLocaleString("en-IN")} cans`],
          note: "It leaves Order approvals and goes back to whoever took it, with your note. It comes back here when they send it again.",
        },
        {
          app: "ERP",
          label: checked.length === 1 ? "check already done" : "checks already done",
          effect: "changed",
          count: checked.length,
          examples: checked as string[],
          note: "Cleared — the corrected TO is a different order from the one anybody checked, so it is checked again.",
        },
        {
          app: "CRM",
          label: `notification to ${f.taker ?? "whoever took it"}`,
          effect: "changed",
          count: f.intake.takenById ? 1 : 0,
          note: "They are told what needs correcting.",
        },
        {
          app: "CRM",
          label: "order on the customer's record",
          effect: "kept",
          count: f.intake.originOrderId ? 1 : 0,
          note: "Still counted as taken while it is corrected.",
        },
      ]),
      blockers: f.intake.status === "open" ? [] : [`TO-${f.intake.toNo} is not waiting for checks.`],
    };
  },
};

/* ======================================== Accounts decline a numbered order */

/** `declineOrderAction` — an order that is no longer a TO, waiting for Accounts. */
export const orderDeclineImpact: ImpactSource = {
  authorize: accountsDecide,
  async report(id): Promise<ImpactBody | null> {
    const [row] = await db
      .select({ order: orders, customer: customers.name, taker: users.name })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(users, eq(users.id, orders.userId))
      .where(eq(orders.id, id));
    if (!row) return null;
    const { order } = row;
    const [asTo] = await db
      .select({ toNo: erpOrderIntakes.toNo, status: erpOrderIntakes.status })
      .from(erpOrderIntakes)
      .where(eq(erpOrderIntakes.originOrderId, id));
    const blockers: string[] = [];
    if (asTo && asTo.status !== "verified") {
      blockers.push(`It is still TO-${asTo.toNo}: decide it in the TO list at the top of Order approvals.`);
    } else if (order.status !== "pending_approval") {
      blockers.push(`That order was already ${order.status === "declined" ? "declined" : "decided"}.`);
    }
    const erpNo = order.source === "erp" && order.externalRef?.startsWith("ERP-") ? order.externalRef.slice(4) : null;
    return {
      title: `${erpNo ? `Order ${erpNo}` : "The order"} for ${row.customer}, ${money(Number(order.totalAmount ?? 0))}`,
      verb: "Decline",
      confirmWord: erpNo ? `Order ${erpNo}` : "DECLINE",
      items: present([
        {
          app: "Accounts",
          label: "order waiting for approval",
          effect: "changed",
          count: 1,
          note: "Declined with your reason. It stays on the customer's record; EOD value, targets and outstanding never count it.",
        },
        {
          app: "CRM",
          label: "customer's buying cycle",
          effect: "changed",
          count: 1,
          note: "The order stops counting as placed, so the customer returns to the Call Log on their own cycle.",
        },
        {
          app: "ERP",
          label: "order lines in the order book",
          effect: "changed",
          count: erpNo ? 1 : 0,
          note: "They learn the order was declined.",
        },
        {
          app: "CRM",
          label: `notification to ${row.taker ?? "whoever took it"}`,
          effect: "changed",
          count: order.userId ? 1 : 0,
          note: "The reason travels in the message, so they can ring the customer.",
        },
      ]),
      blockers,
    };
  },
};
