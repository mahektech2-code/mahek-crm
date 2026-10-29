import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { nextWorkingDay, type BusinessDate } from "@/lib/business-date";
import { ladderFor, rungOf } from "@/lib/engines/lead-ladder";
import { stageLabel, type LeadSalesType, type LeadStage } from "@/lib/lead-labels";
import { READINESS_TARGET, TRIAL_NON_SKIPPABLE, type ReadinessChoice } from "@/lib/verification-readiness";
import type { Hat } from "@/lib/access-control";
import {
  applyLeadStageMove,
  evaluateLeadStageMove,
  leadGateInput,
  leadRow,
  type LeadMoveActor,
} from "@/lib/services/lead-service";

/* ---------------------------------------------------------------------------
 * WHAT A VERIFYING CALL DOES ABOUT "WHAT THEY ARE READY FOR".
 *
 * It asks the stage engine to move the lead, exactly as a person pressing the
 * stage button would, and takes the engine's answer:
 *
 *  - the gate is open  -> the move is made with no override at all;
 *  - the gate is shut  -> it is passed ONLY by the override the engine already
 *    has: the caller must hold `lead.override`, the deployment's "a manager may
 *    move a lead past a gate" setting must be on, and a reason is recorded. The
 *    transition stores exactly which conditions were still missing, and the
 *    hat that allowed it.
 *  - otherwise         -> nothing moves. The verification stands, the refusal
 *    is said in words, and the job that is still owed is named.
 *
 * Nothing here writes a sample, an approval, a GST verification or an order. A
 * readiness answer is evidence for a move; it never stands in for the work the
 * gates exist to ask for. The sample request, approval, dispatch and review
 * still happen in their own workflow, and a real order is still what takes a
 * lead to 1st Order.
 * ------------------------------------------------------------------------- */

export type ReadinessMoveOutcome =
  | { kind: "none" }
  | { kind: "already"; to: LeadStage; message: string }
  | { kind: "moved"; to: LeadStage; overridden: string[]; message: string }
  | { kind: "blocked"; to: LeadStage; code: string; missing: string[]; message: string };

const NEXT_STEP: Record<ReadinessChoice, string> = {
  trial: "Next: finish the qualification review, then request the sample.",
  rates: "Next: move the lead to Negotiation from its record, saying why no sample is needed.",
  order: "Next: take the order, move the lead to Negotiation, then record and confirm the actual order.",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export async function moveOnReadiness(input: {
  customerId: string;
  choice: ReadinessChoice | null;
  actor: LeadMoveActor;
  /** Whether the caller holds `lead.override`. Asked by the caller, as the engine expects. */
  canOverride: boolean;
  /** The narrowest hat that carries `lead.override`, to stamp an overridden move; null where none does. */
  overrideHat: Hat | null;
}): Promise<ReadinessMoveOutcome> {
  if (!input.choice) return { kind: "none" };
  const target = READINESS_TARGET[input.choice];
  const to = target.to;

  const lead = await leadRow(input.customerId);
  const gate = await leadGateInput(input.customerId);
  if (!lead || !gate || !lead.leadStage) return { kind: "none" };

  const from = lead.leadStage as LeadStage;
  const salesType = lead.leadSalesType as LeadSalesType | null;
  const here = rungOf(from, salesType);
  const there = ladderFor(salesType).indexOf(to);

  const config = await getConfig();
  const day = await today();
  const due = nextWorkingDay(day as BusinessDate, {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  });
  const nextAction = target.nextAction
    ? {
        action: target.nextAction,
        date: due,
        /* The person working the account owes the job; failing that, whoever holds the lead. */
        ownerId: lead.ownerId ?? lead.leadManagerId ?? input.actor.userId,
        outcome: null,
      }
    : null;

  /* Already there, or further on: nothing to move. Where the job is "take the
     order" and the lead is sitting in Negotiation, the job is still written. */
  if (there >= 0 && here >= there) {
    if (nextAction && from === to) {
      await db.transaction(async (tx) => {
        await tx
          .update(customers)
          .set({
            leadNextAction: nextAction.action,
            leadNextActionDate: nextAction.date,
            leadNextActionOwnerId: nextAction.ownerId,
            leadNextActionOutcome: null,
            updatedAt: new Date(),
          })
          .where(eq(customers.id, input.customerId));
        await tx.insert(auditLog).values({
          id: gen("aud"),
          actorId: input.actor.userId,
          action: "lead.readiness_next_action",
          entityType: "customer",
          entityId: input.customerId,
          actorRole: input.actor.hat?.role ?? null,
          actorApp: input.actor.hat?.app ?? null,
          afterState: { choice: input.choice, stage: from, nextAction: nextAction.action, date: nextAction.date },
        });
      });
      return {
        kind: "already",
        to,
        message: `Already in ${stageLabel(to)}. Next action set: ${nextAction.action}, ${nextAction.date}.`,
      };
    }
    return { kind: "already", to, message: `Already at or past ${stageLabel(to)}.` };
  }

  /* The gate is asked about the state the move is about to create, next action included. */
  const asked = nextAction
    ? { ...gate, nextAction: nextAction.action, nextActionDate: nextAction.date, nextActionOwnerId: nextAction.ownerId }
    : gate;

  let decision = await evaluateLeadStageMove({
    lead,
    gate: asked,
    to,
    reasonCode: null,
    override: null,
    canOverride: input.canOverride,
  });

  /* A trial needs two approvals no override may stand in for: the GST validation
     and the Sales Manager's review. Said before any override is considered. */
  if (!decision.ok && decision.code === "gate_shut" && input.choice === "trial") {
    const pending = decision.missing.map((c) => c.id).filter((id) => id in TRIAL_NON_SKIPPABLE);
    if (pending.length) {
      return blocked(
        input,
        to,
        "approval_pending",
        decision.missing.map((c) => c.id),
        `${stageLabel(to)} cannot be opened by a verification call: ${pending.map((id) => TRIAL_NON_SKIPPABLE[id].pending).join(", and ")}.`,
        `Next: ${pending.map((id) => TRIAL_NON_SKIPPABLE[id].next).join(", then ")}, then request the sample.`,
      );
    }
  }

  /* A shut gate may be passed by the engine's own override, and only by it. */
  if (!decision.ok && decision.code === "gate_shut") {
    if (!input.canOverride || !input.overrideHat) {
      return blocked(
        input,
        to,
        "override_not_permitted",
        decision.missing.map((c) => c.id),
        `${stageLabel(to)} is not open yet (${plural(decision.missing.length, "thing")} still to do) and you do not hold the permission to pass a closed gate.`,
      );
    }
    decision = await evaluateLeadStageMove({
      lead,
      gate: asked,
      to,
      reasonCode: null,
      override: { reasonCode: target.reasonCode },
      canOverride: input.canOverride,
    });
  }

  if (!decision.ok) {
    const why =
      decision.code === "override_not_offered"
        ? `${stageLabel(to)} is not open yet and passing a closed gate is switched off for this deployment.`
        : decision.message;
    return blocked(input, to, decision.code, decision.missing.map((c) => c.id), why);
  }

  const overridden = decision.kind === "overridden";
  await applyLeadStageMove(
    { ...input.actor, hat: overridden ? input.overrideHat : input.actor.hat },
    lead,
    to,
    {
      decision,
      reasonCode: overridden ? target.reasonCode : null,
      note: target.note,
      nextAction,
      hold: null,
      day,
    },
  );

  const skipped = decision.overriddenConditions;
  return {
    kind: "moved",
    to,
    overridden: skipped,
    message:
      `Moved to ${stageLabel(to)}` +
      (skipped.length ? ` — ${plural(skipped.length, "condition")} passed by override and recorded in the history.` : ".") +
      (nextAction ? ` Next action: ${nextAction.action}, ${nextAction.date}.` : ""),
  };
}

/** Nothing moved: the verification stands, the refusal is recorded, and the owed job is named. */
async function blocked(
  input: { customerId: string; choice: ReadinessChoice | null; actor: LeadMoveActor },
  to: LeadStage,
  code: string,
  missing: string[],
  why: string,
  nextStep?: string,
): Promise<ReadinessMoveOutcome> {
  await db.insert(auditLog).values({
    id: gen("aud"),
    actorId: input.actor.userId,
    action: "lead.readiness_move_blocked",
    entityType: "customer",
    entityId: input.customerId,
    actorRole: input.actor.hat?.role ?? null,
    actorApp: input.actor.hat?.app ?? null,
    afterState: { choice: input.choice, to, code, missing },
  });
  const next = nextStep ?? (input.choice ? NEXT_STEP[input.choice] : "");
  return { kind: "blocked", to, code, missing, message: `${why} ${next}`.trim() };
}
