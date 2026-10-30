import { randomUUID } from "node:crypto";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { calls, reminders, users } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A lead's follow-up is a row in `reminders`, the same table a promised payment
 * and a no-order callback already use, so `/crm/reminders` and the Call Log
 * surface it with no second mechanism.
 *
 * There is no unique key on that table and no column for "which lead follow-up
 * this is", so the row is recognised by what it IS: pending, system generated,
 * a call-back, on this customer, carrying this note prefix. A completed or
 * dismissed row never matches, which is what stops a finished follow-up being
 * reopened by a later call: the next one is a NEW row.
 */
export const LEAD_FOLLOWUP_PREFIX = "Lead follow-up";

const isLeadFollowUp = (customerId: string) =>
  and(
    eq(reminders.customerId, customerId),
    eq(reminders.status, "pending"),
    eq(reminders.systemGenerated, true),
    eq(reminders.type, "call_back"),
    like(reminders.note, `${LEAD_FOLLOWUP_PREFIX}%`),
  );

/**
 * Create or move THE ONE pending follow-up for a lead. Called inside the
 * transaction that saves the call, so the call and its reminder stand or fall
 * together. Rescheduling updates the open row (and counts it); any stray
 * duplicate left open by an earlier bug is dismissed rather than kept.
 */
export async function syncLeadFollowUp(
  tx: Tx,
  input: {
    customerId: string;
    /** The lead's CURRENT owner. Falls back to the actor only when nobody owns it. */
    ownerId: string | null;
    actorId: string;
    date: string;
    text: string;
    callId?: string | null;
  },
): Promise<{ reminderId: string; created: boolean }> {
  const assignedUserId = input.ownerId ?? input.actorId;
  const note = `${LEAD_FOLLOWUP_PREFIX} — ${input.text}`.slice(0, 500);
  const open = await tx
    .select({ id: reminders.id, dueDate: reminders.dueDate })
    .from(reminders)
    .where(isLeadFollowUp(input.customerId))
    .orderBy(desc(reminders.createdAt))
    .for("update");

  const [keep, ...extra] = open;
  if (extra.length) {
    await tx
      .update(reminders)
      .set({
        status: "dismissed",
        closedAt: new Date(),
        closedById: input.actorId,
        dismissReason: "Superseded by a newer lead follow-up",
        updatedAt: new Date(),
      })
      .where(
        sql`${reminders.id} in (${sql.join(
          extra.map((e) => sql`${e.id}`),
          sql`, `,
        )})`,
      );
  }

  if (keep) {
    await tx
      .update(reminders)
      .set({
        dueDate: input.date,
        assignedUserId,
        note,
        callId: input.callId ?? null,
        rescheduleCount: keep.dueDate === input.date ? sql`${reminders.rescheduleCount}` : sql`${reminders.rescheduleCount} + 1`,
        updatedAt: new Date(),
        updatedById: input.actorId,
      })
      .where(eq(reminders.id, keep.id));
    return { reminderId: keep.id, created: false };
  }

  const reminderId = `rem_${randomUUID().slice(0, 12)}`;
  await tx.insert(reminders).values({
    id: reminderId,
    customerId: input.customerId,
    createdByUserId: input.actorId,
    assignedUserId,
    callId: input.callId ?? null,
    dueDate: input.date,
    note,
    type: "call_back",
    systemGenerated: true,
    createdById: input.actorId,
    updatedById: input.actorId,
  });
  return { reminderId, created: true };
}

/** The lead changed hands: its open follow-up goes with it. Completed ones stay. */
export async function moveLeadFollowUpsTo(tx: Tx, customerId: string, newOwnerId: string | null, actorId: string) {
  if (!newOwnerId) return 0;
  const moved = await tx
    .update(reminders)
    .set({ assignedUserId: newOwnerId, updatedAt: new Date(), updatedById: actorId })
    .where(and(isLeadFollowUp(customerId), sql`${reminders.assignedUserId} <> ${newOwnerId}`))
    .returning({ id: reminders.id });
  return moved.length;
}

export type UpcomingFollowUp = {
  id: string;
  dueDate: string;
  note: string;
  type: string;
  assignedToName: string;
  assignedToId: string;
  rescheduleCount: number;
};

/** Every PENDING reminder on the lead, soonest first. The page's own scope check already ran. */
export async function leadUpcomingFollowUps(customerId: string): Promise<UpcomingFollowUp[]> {
  return db
    .select({
      id: reminders.id,
      dueDate: reminders.dueDate,
      note: reminders.note,
      type: reminders.type,
      assignedToName: users.name,
      assignedToId: reminders.assignedUserId,
      rescheduleCount: reminders.rescheduleCount,
    })
    .from(reminders)
    .innerJoin(users, eq(users.id, reminders.assignedUserId))
    .where(and(eq(reminders.customerId, customerId), eq(reminders.status, "pending")))
    .orderBy(reminders.dueDate)
    .limit(20);
}

export type LeadCallEntry = {
  id: string;
  at: string;
  byName: string;
  outcome: string;
  /** Precise outcome label for qualification calls, where recorded. */
  detailOutcome: string | null;
  callNumber: number | null;
  notes: string | null;
  nextAction: string | null;
  nextDate: string | null;
};

/**
 * Every call recorded against the lead, newest first, read from the existing
 * `calls` rows — the qualification calls and any other call logged at this
 * customer. Nothing is copied anywhere.
 */
export async function leadCallHistory(customerId: string): Promise<LeadCallEntry[]> {
  const rows = await db
    .select({
      id: calls.id,
      at: calls.startedAt,
      byName: users.name,
      outcome: calls.outcome,
      notes: calls.notes,
      detail: calls.outcomeDetail,
      nextStepDate: calls.nextStepDate,
      nextStepHeadline: calls.nextStepHeadline,
    })
    .from(calls)
    .leftJoin(users, eq(users.id, calls.userId))
    .where(and(eq(calls.customerId, customerId), eq(calls.direction, "outbound")))
    .orderBy(desc(calls.startedAt), desc(calls.id))
    .limit(200);
  return rows.map((r) => {
    const d = (r.detail ?? {}) as Record<string, string>;
    const n = Number(d.qualCall);
    return {
      id: r.id,
      at: r.at.toISOString(),
      byName: r.byName ?? "Someone",
      outcome: r.outcome ?? "",
      detailOutcome: d.qualOutcome ?? null,
      callNumber: Number.isFinite(n) && n > 0 ? n : null,
      notes: r.notes,
      nextAction: d.nextAction ?? r.nextStepHeadline ?? null,
      nextDate: d.nextDate ?? (r.nextStepDate ? String(r.nextStepDate) : null),
    };
  });
}

