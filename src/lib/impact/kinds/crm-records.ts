import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { complaints, customers, followUpAttempts, reminders, users } from "@/db/schema";
import { assertCustomerInScope, requireCapability } from "@/lib/access-control";
import { longDate, money } from "@/lib/format";
import { CN_STATUS_LABEL, categoryLabel } from "@/lib/complaint-labels";
import type { ImpactSource } from "../registry";
import { present, word } from "./crm-common";

/* ---------------------------------------------------------------------------
 * A PROMISE CANCELLED AND A COMPLAINT WITHDRAWN, said before they happen.
 *
 * Neither deletes anything. A cancelled promise keeps its attempt — the call
 * happened — and stops being the live promise; a withdrawn complaint is
 * closed with the reason in its history. What each one does move is named
 * here: the chase reminder that comes off a telecaller's list, the
 * credit-note request that goes with the complaint.
 * ------------------------------------------------------------------------- */

const seats = {
  id: customers.id,
  name: customers.name,
  kind: customers.kind,
  ownerId: customers.ownerId,
  salesAmId: customers.salesAmId,
  backOfficeAmId: customers.backOfficeAmId,
  leadManagerId: customers.leadManagerId,
  relationshipOwnerId: customers.relationshipOwnerId,
};

/** `cancelPromiseAction` — by the follow-up attempt that carries the promise. */
export const promiseCancelImpact: ImpactSource = {
  authorize: async (id) => {
    await requireCapability("reminder.close");
    const [row] = await db
      .select(seats)
      .from(followUpAttempts)
      .innerJoin(customers, eq(customers.id, followUpAttempts.customerId))
      .where(eq(followUpAttempts.id, id));
    if (row) await assertCustomerInScope(row);
  },

  async report(id) {
    const [a] = await db
      .select({
        attempt: followUpAttempts,
        customer: customers.name,
        by: users.name,
      })
      .from(followUpAttempts)
      .innerJoin(customers, eq(customers.id, followUpAttempts.customerId))
      .leftJoin(users, eq(users.id, followUpAttempts.userId))
      .where(eq(followUpAttempts.id, id));
    if (!a || !a.attempt.promisedDate) return null;
    const p = a.attempt;
    const [chase] = p.reminderId
      ? await db
          .select({ status: reminders.status, dueDate: reminders.dueDate, type: reminders.type })
          .from(reminders)
          .where(eq(reminders.id, p.reminderId))
      : [];
    const chasePending = chase?.status === "pending" && chase.type === "payment_promise";
    const what = `${p.promisedAmount ? money(Number(p.promisedAmount)) : "Payment"} by ${longDate(String(p.promisedDate))}`;

    return {
      title: `${a.customer} — ${what}`,
      verb: "Cancel promise",
      confirmWord: word(a.customer, "cancel"),
      items: present([
        {
          app: "CRM",
          label: "live promise on the collections worklist",
          effect: "changed",
          count: 1,
          examples: [what],
          note: `${a.customer} stops showing this promise and goes back to being chased by the stage their bills put them at. Promises kept stops judging it.`,
        },
        {
          app: "CRM",
          label: "chase reminder",
          effect: "changed",
          count: chasePending ? 1 : 0,
          note: `The reminder due ${chase ? longDate(String(chase.dueDate)) : ""} is dismissed with your reason.`,
        },
        {
          app: "CRM",
          label: "collections call it was promised on",
          effect: "kept",
          count: 1,
          note: `The call${a.by ? ` ${a.by} made` : ""} stays on the record, and in the day's count of promises taken.`,
        },
      ]),
      blockers: p.promiseCancelledAt ? ["This promise was already cancelled."] : [],
    };
  },
};

/** `withdrawComplaintAction` — a complaint raised by mistake or twice. */
export const complaintWithdrawImpact: ImpactSource = {
  authorize: async (id) => {
    await requireCapability("complaint.resolve");
    const [row] = await db
      .select(seats)
      .from(complaints)
      .innerJoin(customers, eq(customers.id, complaints.customerId))
      .where(eq(complaints.id, id));
    if (row) await assertCustomerInScope(row);
  },

  async report(id) {
    const [c] = await db
      .select({ complaint: complaints, customer: customers.name })
      .from(complaints)
      .innerJoin(customers, eq(customers.id, complaints.customerId))
      .where(eq(complaints.id, id));
    if (!c) return null;
    const k = c.complaint;
    const finished = ["resolved", "closed", "rejected"].includes(k.status);
    /* Money decided is accounts' to unwind; a request still waiting simply
       leaves their list with the complaint. */
    const cnDecided = k.requestCn && (k.cnStatus === "approved" || k.cnStatus === "issued");
    const cnWaiting = k.requestCn && (k.cnStatus === null || k.cnStatus === "requested" || k.cnStatus === "under_review");

    const blockers: string[] = [];
    if (finished) blockers.push("This complaint is already finished with — there is nothing to withdraw.");
    if (cnDecided) {
      blockers.push(
        `Its credit note is already ${(CN_STATUS_LABEL[k.cnStatus!] ?? k.cnStatus!).toLowerCase()} by accounts. A complaint with money decided against it is resolved through accounts, not withdrawn.`,
      );
    }

    return {
      title: `${c.customer} — ${categoryLabel(k.category)}`,
      verb: "Withdraw",
      confirmWord: word(c.customer, "withdraw"),
      items: present([
        {
          app: "CRM",
          label: "open complaint",
          effect: "changed",
          count: 1,
          examples: [k.description.length > 80 ? `${k.description.slice(0, 80)}…` : k.description],
          note: "It is closed, with your reason as the last line of its history. It is not deleted, and it leaves the open lists.",
        },
        {
          app: "Accounts",
          label: "credit-note request waiting on accounts",
          effect: "changed",
          count: cnWaiting ? 1 : 0,
          note: "The request leaves accounts' pending list as refused, with your reason.",
        },
      ]),
      blockers,
    };
  },
};
