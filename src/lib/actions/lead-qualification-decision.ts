"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { today } from "@/lib/recompute";
import { getConfig } from "@/lib/config/store";
import { stageLabel, REASON_CODE_NEEDING_REMARKS, type LeadSalesType, type LeadStage } from "@/lib/lead-labels";
import { qualificationAccess } from "@/lib/lead-qualification-access";
import { decisionReasonLabel, NOT_READY_REASONS, SKIP_REASON } from "@/lib/qualification-decision";
import { assertLeadInScope } from "@/lib/services/lead-scope";
import { qualificationCollectorRefusal, requireQualificationApprover } from "@/lib/services/lead-verifier";
import { assertDesignatedQualificationApprover } from "@/lib/services/qualification-approver";
import {
  applyLeadStageMove,
  evaluateLeadStageMove,
  evaluateStageSelection,
  leadGateInput,
  leadRow,
  StageAlreadyMoved,
} from "@/lib/services/lead-service";
import { skippedSentence } from "@/lib/engines/lead-stage-select";

/* ---------------------------------------------------------------------------
 * "READY FOR SAMPLE / TRIAL?" — the decision asked once Qualification is saved.
 *
 * THIS LOOSENS NOTHING. The decision and its reason are ALWAYS written to the
 * audit log, whoever asks and whatever happens next. The MOVE is made only where
 * the rules that already exist allow it for this person, right now:
 *
 *   Yes                  -> the ordinary move to Sample / Trial: its gate must be
 *                           open, which includes the Sales Manager's review of
 *                           the Qualification. No override is passed.
 *   No, skip the trial   -> the existing "choose a later stage" rule
 *                           (`evaluateStageSelection`): the lead's designated
 *                           Sales Manager only, with the Sample / Trial entry
 *                           gate open, nothing else lifted.
 *   No, any other reason -> nothing moves; the reason is recorded.
 *
 * Where the move is not allowed the answer says exactly what is still needed and
 * nothing is changed except the audit row. Nothing here writes a sample, an
 * order, a review or an approval.
 * ------------------------------------------------------------------------- */

const decisionSchema = z.object({
  customerId: z.string().min(1),
  ready: z.boolean(),
  reasonCode: z.string().trim().min(1).max(80).optional(),
  note: z.string().trim().max(2000).optional(),
});

export type QualificationDecisionResult = {
  /** The rung the lead stands on now. */
  stage: LeadStage;
  moved: boolean;
  /** Why it did not move, in words; null where it moved or where staying was the answer. */
  held: string | null;
  /** What is still to do, for a move that could not be made. */
  missing: string[];
};

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

function refresh(customerId: string) {
  try {
    revalidatePath("/sales/leads");
    revalidatePath(`/sales/leads/${customerId}`);
    revalidatePath(`/crm/leads/${customerId}`);
    revalidatePath(`/crm/leads/${customerId}/qualify`);
  } catch {
    /* no request context — a job or a test */
  }
}

export async function decideAfterQualification(input: {
  customerId: string;
  ready: boolean;
  reasonCode?: string;
  note?: string;
}): Promise<Result<QualificationDecisionResult>> {
  try {
    const parsed = decisionSchema.safeParse(input);
    if (!parsed.success) {
      return err(parsed.error.issues[0]?.message ?? "That is not a valid decision.", "validation");
    }
    const p = parsed.data;

    /* The same two questions saving the Qualification asks: may this person work
       the lead, and is this the person who fills it in. */
    const ctx = await requireCapability("lead.work");
    const lead = await leadRow(p.customerId);
    if (!lead) return err("That lead is not on MahekOne.", "not_found");
    await assertLeadInScope(p.customerId, {
      kind: lead.kind,
      ownerId: lead.ownerId,
      salesAmId: lead.salesAmId,
      backOfficeAmId: lead.backOfficeAmId,
      leadManagerId: lead.leadManagerId,
    } as Parameters<typeof assertLeadInScope>[1]);

    if (lead.leadStage !== "qualification") {
      return err("This decision is asked at Qualification only.", "rule_violation");
    }
    const access = qualificationAccess(lead.leadStage);
    if (!access.writable) return err(access.reason, "rule_violation");
    const salesType = lead.leadSalesType as LeadSalesType | null;
    if (salesType !== "direct" && salesType !== "third_party") {
      return err("Sample / Trial is not asked on this lead's ladder.", "rule_violation");
    }
    /* WHO MAY SKIP THE TRIAL is settled first, because it changes who may ask: the
       lead's designated Sales Manager reviews a Qualification and does not fill it
       in, yet choosing a later stage is exactly hers. The approver check REFUSES by
       throwing for somebody who holds no manager hat; here that is just "no". */
    let isDesignatedApprover = false;
    if (!input.ready && input.reasonCode === SKIP_REASON.code) {
      try {
        const approver = await requireQualificationApprover(p.customerId);
        if (approver.ok && approver.ctx.user.id === ctx.user.id) {
          isDesignatedApprover = (await assertDesignatedQualificationApprover(p.customerId, ctx.user.id)).ok === true;
        }
      } catch {
        isDesignatedApprover = false;
      }
    }
    const barred = isDesignatedApprover ? null : await qualificationCollectorRefusal(ctx.user, lead);
    if (barred) return err(barred, "rule_violation");

    /* A No has to say why, and Other has to say what. */
    let reasonLabel: string | null = null;
    if (!p.ready) {
      const reason = NOT_READY_REASONS.find((r) => r.code === p.reasonCode);
      if (!reason) {
        return {
          ok: false,
          error: "Say why this lead is not going to a sample. Pick one of the reasons.",
          code: "validation",
          fieldErrors: [{ field: "reasonCode", message: "Pick a reason." }],
        };
      }
      if (reason.code === REASON_CODE_NEEDING_REMARKS && !p.note?.trim()) {
        return {
          ok: false,
          error: "You picked Other — say in words what it actually is.",
          code: "validation",
          fieldErrors: [{ field: "note", message: "Say what it actually is." }],
        };
      }
      reasonLabel = decisionReasonLabel(reason.code);
    }

    const gate = await leadGateInput(p.customerId);
    if (!gate) return err("That lead is not on MahekOne.", "not_found");
    const actor = {
      userId: ctx.user.id,
      hat: { app: ctx.authorisedIn, role: ctx.authorisedBy },
      sourceApp: "crm" as const,
    };
    const day = await today();

    const outcome: QualificationDecisionResult = { stage: "qualification", moved: false, held: null, missing: [] };
    let message = "";

    const record = async (extra: Record<string, unknown>) => {
      await db.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: "lead.qualification_decision",
        entityType: "customer",
        entityId: p.customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: { stage: "qualification" },
        afterState: {
          ready: p.ready,
          reasonCode: p.reasonCode ?? null,
          reason: reasonLabel,
          note: p.note ?? null,
          ...extra,
        },
      });
    };

    if (p.ready) {
      /* YES: the ordinary move, its gate asked as it stands. No override. */
      const decision = await evaluateLeadStageMove({ lead, gate, to: "sample_trial", canOverride: false });
      if (!decision.ok) {
        outcome.held = decision.message;
        outcome.missing = decision.missing.map((c) => c.says);
        await record({ moved: false, to: "sample_trial", held: decision.message, missing: outcome.missing });
        refresh(p.customerId);
        return ok(outcome, `Ready for Sample / Trial is recorded. ${decision.message}`);
      }
      try {
        await applyLeadStageMove(actor, lead, "sample_trial", {
          decision,
          reasonCode: null,
          note: "Qualification completed — ready for Sample / Trial.",
          day,
          expectFrom: "qualification",
        });
      } catch (e) {
        if (e instanceof StageAlreadyMoved) {
          return err("This lead has already moved. Reload to see where it is now.", "rule_violation");
        }
        throw e;
      }
      await record({ moved: true, to: "sample_trial" });
      outcome.stage = "sample_trial";
      outcome.moved = true;
      message = `${lead.name} moved to ${stageLabel("sample_trial")}.`;
    } else if (p.reasonCode === SKIP_REASON.code) {
      /* NO, SKIP THE TRIAL: only the designated Sales Manager may, by the rule that
         already governs choosing a later stage. Anyone else's decision is recorded. */
      if (!isDesignatedApprover) {
        outcome.held =
          "Skipping Sample / Trial is decided by this lead's designated Sales Manager. Your answer is recorded and they can move it to Negotiation from the lead's record.";
        await record({ moved: false, to: "negotiation", held: outcome.held });
        refresh(p.customerId);
        return ok(outcome, outcome.held);
      }
      const decision = await evaluateStageSelection({ lead, gate, to: "negotiation", reasonCode: SKIP_REASON.code });
      if (!decision.ok) {
        outcome.held = decision.message;
        outcome.missing = decision.missing.map((c) => c.says);
        await record({ moved: false, to: "negotiation", held: decision.message, missing: outcome.missing });
        refresh(p.customerId);
        return ok(outcome, decision.message);
      }
      const config = await getConfig();
      const label =
        config["leads.stageSkipReasons"].find((r) => r.code === SKIP_REASON.code)?.label ?? SKIP_REASON.label;
      try {
        await applyLeadStageMove(actor, lead, "negotiation", {
          decision,
          reasonCode: SKIP_REASON.code,
          note: p.note ?? null,
          reasonLabel: label,
          day,
          expectFrom: "qualification",
        });
      } catch (e) {
        if (e instanceof StageAlreadyMoved) {
          return err("This lead has already moved. Reload to see where it is now.", "rule_violation");
        }
        throw e;
      }
      await record({ moved: true, to: "negotiation", skipped: decision.skippedStages ?? [] });
      outcome.stage = "negotiation";
      outcome.moved = true;
      message = `${lead.name} moved to ${stageLabel("negotiation")}.${
        decision.skippedStages?.length ? ` ${skippedSentence(decision.skippedStages)} not climbed.` : ""
      }`;
    } else {
      /* NO, for any other reason: the lead stays; the reason is the record. */
      await record({ moved: false, stays: "qualification" });
      message = "Recorded. The lead stays at Qualification.";
    }

    refresh(p.customerId);
    return ok(outcome, message);
  } catch (e) {
    return fromThrown(e);
  }
}
