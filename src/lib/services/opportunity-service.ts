import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, callOpportunities, calls, customers, users } from "@/db/schema";
import { resolveScope, scopedUserIds } from "../access-control";
import { err, ok, type Result } from "../result";
import { today } from "../recompute";

/* ---------------------------------------------------------------------------
 * THE OPPORTUNITY WORKLIST.
 *
 * `call_opportunities` was write-once: a row that landed on the customer's
 * timeline and was told to nobody, so whether anything came of it depended on
 * somebody happening to read that account. This is what makes it workable —
 * a list, an owner, a status and the sentence somebody wrote when they worked
 * it — WITHOUT making it a lead.
 *
 * It is deliberately not a lead. A lead here is an account that has never
 * ordered, about thirty readers of `customers.kind` are built on exactly that,
 * and an opportunity spotted on a call with a four-year customer cannot be one
 * without making every one of them wrong. Where the account IS a lead, nothing
 * changes: it is already on the lead desk, and the opportunity names what that
 * call turned up on it.
 *
 * WHO SEES A ROW is the same rule a reminder follows — the people in scope for
 * whoever is assigned it, plus whoever logged the call, so the telecaller who
 * raised one is never left unable to see what became of it. Nobody is added
 * for a row they have no connection to; an associate sees their own and a
 * manager their team's.
 * ------------------------------------------------------------------------- */

export const OPPORTUNITY_STATUSES = ["open", "in_progress", "won", "lost"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export type OpportunityRow = {
  id: string;
  customerId: string;
  customerName: string;
  product: string;
  estimatedQuantity: string | null;
  estimatedValuePaise: number | null;
  expectedOrderDate: string | null;
  status: OpportunityStatus;
  /** Who is expected to work it. The logger where nobody was assigned. */
  assignedUserId: string;
  assignedUserName: string;
  loggedByName: string;
  createdAt: string;
  workedNote: string | null;
  closedAt: string | null;
  /** The call it came out of, and what that call was about. */
  callId: string;
  callReason: string | null;
  callerRole: string | null;
  callerName: string | null;
  /** Open, and the day somebody expected an order has gone. */
  overdue: boolean;
};

function visibleTo(ids: string[] | null) {
  if (!ids) return undefined;
  return or(
    inArray(callOpportunities.assignedUserId, ids),
    inArray(callOpportunities.userId, ids),
  );
}

export async function listOpportunities(): Promise<OpportunityRow[]> {
  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const day = await today();

  const assignee = sql<string>`coalesce(${callOpportunities.assignedUserId}, ${callOpportunities.userId})`;
  const rows = await db
    .select({
      o: callOpportunities,
      customerName: customers.name,
      assignedUserName: sql<string>`(select name from users u where u.id = ${assignee})`,
      loggedByName: users.name,
      callReason: calls.callReason,
      callerRole: calls.callerRole,
      callerName: calls.callerName,
    })
    .from(callOpportunities)
    .innerJoin(customers, eq(customers.id, callOpportunities.customerId))
    .innerJoin(users, eq(users.id, callOpportunities.userId))
    .leftJoin(calls, eq(calls.id, callOpportunities.callId))
    .where(visibleTo(ids))
    .orderBy(desc(callOpportunities.createdAt))
    .limit(500);

  return rows.map(({ o, customerName, assignedUserName, loggedByName, callReason, callerRole, callerName }) => ({
    id: o.id,
    customerId: o.customerId,
    customerName,
    product: o.product,
    estimatedQuantity: o.estimatedQuantity,
    estimatedValuePaise: o.estimatedValuePaise,
    expectedOrderDate: o.expectedOrderDate,
    status: (OPPORTUNITY_STATUSES as readonly string[]).includes(o.status)
      ? (o.status as OpportunityStatus)
      : "open",
    assignedUserId: o.assignedUserId ?? o.userId,
    assignedUserName: assignedUserName ?? loggedByName,
    loggedByName,
    createdAt: o.createdAt.toISOString(),
    workedNote: o.workedNote,
    closedAt: o.closedAt ? o.closedAt.toISOString() : null,
    callId: o.callId,
    callReason,
    callerRole,
    callerName,
    overdue:
      (o.status === "open" || o.status === "in_progress") &&
      Boolean(o.expectedOrderDate && o.expectedOrderDate < day),
  }));
}

/**
 * Move one along. Anybody who can SEE the row may work it — the same people
 * the list drew it for — which is checked here and not only by not drawing the
 * buttons, because a server action is a URL.
 *
 * `lost` needs a sentence, for the reason a lost lead does: nobody will look
 * again, and "why" is what the next call to that account needs. Reopening is
 * always allowed and clears the closing mark — closing something by mistake
 * must never be harder to undo than to do.
 */
export async function setOpportunityStatus(input: {
  id: string;
  status: string;
  note?: string;
}): Promise<Result<{ status: OpportunityStatus }>> {
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(input.status)) {
    return err("That is not a status an opportunity can have.", "validation");
  }
  const status = input.status as OpportunityStatus;
  const note = input.note?.trim() || null;
  if (status === "lost" && !note) {
    return err("Say why it was lost — it is what the next call to them needs.", "validation", [
      { field: "note", message: "Say why it was lost." },
    ]);
  }

  const ctx = await resolveScope();
  const ids = scopedUserIds(ctx.scope);
  const [row] = await db
    .select()
    .from(callOpportunities)
    .where(and(eq(callOpportunities.id, input.id), visibleTo(ids)));
  /* Not yours to see answers the same as not there, or this is a way to
     enumerate somebody else's list. */
  if (!row) return err("That opportunity is not on your list.", "not_found");

  const closing = status === "won" || status === "lost";
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(callOpportunities)
      .set({
        status,
        /* A note is kept where one was given; a reopen does not erase what was
           written the last time it was worked. */
        workedNote: note ?? row.workedNote,
        closedAt: closing ? now : null,
        closedById: closing ? ctx.user.id : null,
        updatedAt: now,
        updatedById: ctx.user.id,
      })
      .where(eq(callOpportunities.id, row.id));
    await tx.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId: ctx.user.id,
      action: "opportunity.status",
      entityType: "call_opportunity",
      entityId: row.id,
      beforeState: { status: row.status } as never,
      afterState: { status, note } as never,
    });
  });
  return ok({ status }, "Updated");
}
