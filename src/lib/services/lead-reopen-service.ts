import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, leadStageTransitions, notifications, users } from "@/db/schema";
import { getConfig } from "../config/store";
import { REASON_CODE_NEEDING_REMARKS, stageLabel, type LeadSalesType, type LeadStage } from "../lead-labels";
import { reopenNote, reopenTarget } from "../engines/lead-reopen";
import { err, ok, type Result } from "../result";
import { MBOS_EVENT, writeTimelineEvent } from "../timeline";
import type { LeadMoveActor } from "./lead-service";

/* ---------------------------------------------------------------------------
 * REOPENING A LOST LEAD — the ONE implementation, behind two thin doors.
 *
 * The Sales Manager's `reopenSalesManagerLead` and the Telecaller's
 * `reopenDeskLead` each ask their own authorisation question and then call this.
 * What "reopen" means — which rung, what is cleared, what is kept, what is
 * written — is decided here once, so the two seats cannot come to hold two
 * different ideas of it.
 *
 * IT IS NOT A MOVE ALONG A LADDER, and it is deliberately not
 * `applyLeadStageMove`: `lost` is on no ladder, `directionOf` refuses every
 * move out of it, and the one generic way to walk a lead backwards (`reverted`)
 * demands `lead.override` and asks a question about direction that does not
 * apply. It is its own act with its own rule (`engines/lead-reopen.ts`).
 *
 * THE SAME ROW, THE SAME ID. Nothing here inserts into `customers`. The lost
 * transition that closed the lead is never edited; a NEW transition
 * (`from_stage = 'lost'`) is appended beside it, so the history reads
 * "… → lost → <rung>" and the earlier loss stays visible for good. That second
 * row IS the reopened marker — a reader derives "was reopened" from it, which
 * is why no column and no migration was added for it.
 *
 * WHAT IS CLEARED is only what describes the CURRENT state: the lost reason on
 * the row (the historical one lives on the transition), the archive flag, and
 * the "decided" marks that would otherwise make a reopened lead look finished.
 * What is never touched: calls, timeline, the older audit rows, ownership
 * history, the verification calls themselves.
 *
 * ONE TRANSACTION ON A LOCKED ROW, and the lock is what makes it idempotent:
 * the first request moves the lead off `lost`, the second reads a lead that is
 * no longer there and is refused cleanly. Two reopen transitions from one loss
 * cannot be written.
 *
 * NOTHING GATES ITSELF OPEN. The lead lands on a rung and every ordinary gate
 * applies from there — a reopened lead cannot reach Customer on the strength of
 * having been further along once.
 * ------------------------------------------------------------------------- */

/** Thrown inside the transaction so the whole thing rolls back and the caller answers in words. */
class ReopenRefusal extends Error {
  constructor(public readonly result: ReturnType<typeof err>) {
    super(result.error);
  }
}

export type ReopenLostLeadInput = {
  actor: LeadMoveActor;
  customerId: string;
  /** A code from `leads.reopenReasons`. */
  reasonCode: string;
  note?: string | null;
  /** §24 — a reopened lead is an active lead and may not be left owing nothing. */
  nextAction: { action: string; date: string; ownerId: string; outcome?: string | null };
  /** The business day, resolved by the caller — engines read no clock. */
  day: string;
  /** Which seat reopened it. Recorded on the audit row; changes no rule. */
  seat: "sales_manager" | "calling_desk";
};

export type ReopenLostLeadResult = {
  stage: LeadStage;
  transitionId: string;
  restoredFromArchive: boolean;
  basis: string;
};

/**
 * The instant of this lead's NEWEST reopen, as a SQL expression — or
 * `-infinity` where it has never been reopened.
 *
 * It is what makes a reopened Call-3 lead callable again WITHOUT deleting or
 * falsifying a single call: the desk counts the calls made SINCE the reopen,
 * and every earlier call stays in `calls`, on the record and in the history.
 * A move out of `lost` can only be a reopen (`directionOf` refuses every other),
 * so the transition row is the marker and no column is needed.
 */
export function reopenedAtSql(customerIdColumn: string): SQL {
  return sql`coalesce(
    (select max(rt.at) from lead_stage_transitions rt
      where rt.customer_id = ${sql.raw(customerIdColumn)}
        and rt.from_stage = 'lost' and rt.to_stage <> 'lost'),
    '-infinity'::timestamptz)`;
}

/** The same expression for one lead named by a bound id rather than by a column. */
export function reopenedAtOf(customerId: string): SQL {
  return sql`coalesce(
    (select max(rt.at) from lead_stage_transitions rt
      where rt.customer_id = ${customerId}
        and rt.from_stage = 'lost' and rt.to_stage <> 'lost'),
    '-infinity'::timestamptz)`;
}

type Executor = Pick<typeof db, "select">;

/** The newest reopen of this lead: when, and which transition. Null where it never was. */
export async function latestReopen(
  customerId: string,
  executor: Executor = db,
): Promise<{ at: Date; id: string } | null> {
  const [row] = await executor
    .select({ at: leadStageTransitions.at, id: leadStageTransitions.id })
    .from(leadStageTransitions)
    .where(
      and(
        eq(leadStageTransitions.customerId, customerId),
        eq(leadStageTransitions.fromStage, "lost"),
        sql`${leadStageTransitions.toStage} <> 'lost'`,
      ),
    )
    .orderBy(desc(leadStageTransitions.at), desc(leadStageTransitions.id))
    .limit(1);
  return row ?? null;
}

/** The rung the NEWEST loss left, for a door that needs to word its default before calling `reopenLostLead`. */
export async function lostFromOf(customerId: string): Promise<LeadStage | null> {
  const [closing] = await db
    .select({ fromStage: leadStageTransitions.fromStage })
    .from(leadStageTransitions)
    .where(and(eq(leadStageTransitions.customerId, customerId), eq(leadStageTransitions.toStage, "lost")))
    .orderBy(desc(leadStageTransitions.at), desc(leadStageTransitions.id))
    .limit(1);
  return (closing?.fromStage as LeadStage | null | undefined) ?? null;
}

export async function reopenLostLead(
  input: ReopenLostLeadInput,
): Promise<Result<ReopenLostLeadResult>> {
  const config = await getConfig();

  const reason = config["leads.reopenReasons"].find((r) => r.code === input.reasonCode);
  if (!reason) {
    return err("Pick one of the listed reasons for reopening this lead.", "validation", [
      { field: "reasonCode", message: "Why is it being reopened?" },
    ]);
  }
  if (input.reasonCode === REASON_CODE_NEEDING_REMARKS && !input.note?.trim()) {
    return err("You picked Other — say in words why this lead is being reopened.", "validation", [
      { field: "note", message: "Say what it actually is." },
    ]);
  }
  const action = input.nextAction.action.trim();
  if (!action) {
    return err("A reopened lead must say what happens next.", "validation", [
      { field: "nextAction", message: "What happens next?" },
    ]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.nextAction.date) || input.nextAction.date < input.day) {
    return err("Give the day it is next worked as today or a later date.", "validation", [
      { field: "nextActionDate", message: "Pick today or a later day." },
    ]);
  }

  const [owner] = await db
    .select({ id: users.id, active: users.active })
    .from(users)
    .where(eq(users.id, input.nextAction.ownerId))
    .limit(1);
  if (!owner?.active) {
    return err("That person cannot be given the next action — they have no active account.", "validation", [
      { field: "nextActionOwner", message: "Pick somebody who can sign in." },
    ]);
  }

  const transitionId = `lst_${randomUUID().slice(0, 12)}`;

  try {
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          name: customers.name,
          kind: customers.kind,
          stage: customers.leadStage,
          salesType: customers.leadSalesType,
          lostReason: customers.leadLostReason,
          archived: customers.leadArchived,
          leadManagerId: customers.leadManagerId,
          ownerId: customers.ownerId,
        })
        .from(customers)
        .where(eq(customers.id, input.customerId))
        .for("update");

      if (!row) throw new ReopenRefusal(err("That lead is not on MahekOne.", "not_found"));
      /* THE IDEMPOTENCE GUARD. Asked AFTER the lock is taken, so the second of
         two simultaneous requests sees the first one's answer. */
      if (row.stage !== "lost") {
        throw new ReopenRefusal(
          err(
            "This lead is no longer Lost — somebody has already reopened it, or it has moved on. Refresh to see where it stands.",
            "conflict",
          ),
        );
      }

      /* The loss that closed it — the newest one. Read inside the lock so a
         lead lost, reopened and lost again restores from the LATEST loss. */
      const [closing] = await tx
        .select({ fromStage: leadStageTransitions.fromStage, note: leadStageTransitions.note })
        .from(leadStageTransitions)
        .where(
          and(
            eq(leadStageTransitions.customerId, input.customerId),
            eq(leadStageTransitions.toStage, "lost"),
          ),
        )
        .orderBy(desc(leadStageTransitions.at), desc(leadStageTransitions.id))
        .limit(1);

      const target = reopenTarget({
        lostFrom: closing?.fromStage as LeadStage | null | undefined,
        salesType: row.salesType as LeadSalesType | null,
        lostReason: row.lostReason,
      });
      const previousReason =
        config["leads.lostReasons"].find((r) => r.code === row.lostReason)?.label ?? row.lostReason;

      await tx.insert(leadStageTransitions).values({
        id: transitionId,
        customerId: input.customerId,
        fromStage: "lost",
        toStage: target.stage,
        salesType: row.salesType,
        /* `passed`, not `reverted`: reverted means walked DOWN a ladder and
           belongs to `lead.override`. What marks this one as a reopen is
           `from_stage = 'lost'` and the note's prefix. */
        kind: "passed",
        reasonCode: input.reasonCode,
        note: reopenNote({
          reasonLabel: reason.label,
          note: input.note,
          restoredFromArchive: row.archived,
          previousLostReason: previousReason,
        }),
        overriddenConditions: [],
        actorId: input.actor.userId,
        actorRole: input.actor.hat?.role ?? null,
        actorApp: input.actor.hat?.app ?? null,
      });

      const set: Partial<typeof customers.$inferInsert> = {
        leadStage: target.stage,
        leadStageSince: input.day,
        leadLastActivityDate: input.day,
        /* The CURRENT lost reason goes; the historical one is on the lost
           transition, which is never edited. */
        leadLostReason: null,
        leadNextAction: action,
        leadNextActionDate: input.nextAction.date,
        leadNextActionOwnerId: input.nextAction.ownerId,
        leadNextActionOutcome: input.nextAction.outcome ?? null,
        /* "Not a Prospect" was a decision and this reverses it: left standing it
           would stop the visit cap asking the question again. */
        leadSuspectDecidedAt: null,
        updatedAt: new Date(),
      };

      if (row.archived) {
        set.leadArchived = false;
        set.leadArchivedAt = null;
      }

      if (target.basis === "verification_failed") {
        /* NOT silently verified. The failed call stays in `mbos_lead_validations`;
           what is reset is the state the gates read, so the Sales Manager has to
           perform the verification again. */
        set.leadVerifiedAt = null;
        set.leadVerifiedById = null;
        set.leadQualificationReview = null;
        set.leadQualificationReviewNote = null;
        set.leadQualificationReviewedAt = null;
        set.leadQualificationReviewedById = null;
      }

      await tx.update(customers).set(set).where(eq(customers.id, input.customerId));

      await writeTimelineEvent(tx, {
        customerId: input.customerId,
        eventType: MBOS_EVENT.leadStage,
        sourceApp: input.actor.sourceApp,
        sourceRecordId: transitionId,
        occurredAt: new Date(),
        actorUserId: input.actor.userId,
        summary: `Lead reopened from Lost to ${stageLabel(target.stage)} — ${reason.label}${
          row.archived ? " (restored from the archive)" : ""
        }`,
      });

      if (input.nextAction.ownerId !== input.actor.userId) {
        await tx.insert(notifications).values({
          id: `ntf_${randomUUID().slice(0, 12)}`,
          userId: input.nextAction.ownerId,
          title: `${row.name} was reopened`,
          body: `${row.name} is back at ${stageLabel(target.stage)} (${reason.label}). Next: ${action}, ${input.nextAction.date}.`,
          kind: "info",
          href: `/crm/leads/${input.customerId}`,
        });
      }

      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: input.actor.userId,
        action: "lead.stage.reopen",
        entityType: "customer",
        entityId: input.customerId,
        actorRole: input.actor.hat?.role ?? null,
        actorApp: input.actor.hat?.app ?? null,
        beforeState: {
          stage: "lost",
          lostReason: row.lostReason,
          archived: row.archived,
          verifiedReset: target.basis === "verification_failed",
        },
        afterState: {
          stage: target.stage,
          basis: target.basis,
          reasonCode: input.reasonCode,
          seat: input.seat,
          restoredFromArchive: row.archived,
          source: input.actor.sourceApp,
        },
      });

      return {
        stage: target.stage,
        transitionId,
        restoredFromArchive: row.archived,
        basis: target.basis,
      };
    });

    return ok(result, `Reopened — back at ${stageLabel(result.stage)}.`);
  } catch (e) {
    if (e instanceof ReopenRefusal) return e.result;
    throw e;
  }
}
