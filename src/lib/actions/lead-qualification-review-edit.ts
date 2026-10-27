"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { notifyUser } from "@/lib/notify";
import { MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import { qualificationAccess } from "@/lib/lead-qualification-access";
import { QUALIFICATION_ANSWER_KEYS } from "@/lib/engines/lead-gates";
import {
  diffAnswers,
  isCollectorEdit,
  PROSPECT_EDIT_KEYS,
  REVIEW_EDIT_ACTION,
  splitEdits,
} from "@/lib/qualification-review";
import { saveLeadQualification, saveProspectFields } from "@/lib/actions/leads";
import { assertLeadInScope } from "@/lib/services/lead-scope";
import { leadRow, type LeadRow } from "@/lib/services/lead-service";
import { qualificationCollectorRefusal, requireQualificationApprover } from "@/lib/services/lead-verifier";
import { assertDesignatedQualificationApprover } from "@/lib/services/qualification-approver";
import { err, fromThrown, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * THE APPROVER CHANGES AN ANSWER FROM THE QUALIFICATION REVIEW.
 *
 * This action WRITES NOTHING ITSELF to the lead. The answers are the Calling
 * Desk's, the Prospect's and the Qualification's, and each already has a writer
 * with its validation, its review-voiding rule and its audit row:
 * `saveProspectFields` and `saveLeadQualification`. This calls them, so a limit
 * changed in one place governs every screen that edits the same answer.
 *
 * What it adds is the two things the review needs and those writers do not:
 *
 *  1. WHO. Only the lead's designated approver — the same check, in the same
 *     order, as the decision itself (`reviewLeadQualification`): the existing
 *     approver gate, then `assertDesignatedQualificationApprover`. Holding
 *     `lead.verify`, or being an administrator, is not enough.
 *  2. WHAT CHANGED. The existing writers record what they were sent. A review
 *     needs what the lead now holds that it did not before, field by field, with
 *     the editor and the time. So the lead is read before and after, and only
 *     the fields that really differ are filed.
 *
 * THE CRM'S OWN DIVISION OF LABOUR IS NOT BYPASSED. The Salesman collects a
 * Qualification and the Sales Manager reviews it, so both writers refuse the
 * Sales Manager the GST number, application, credit days, buyer and every
 * Qualification answer. That refusal is asked for HERE, up front and for the
 * whole request, so a request that mixes an allowed field with a refused one
 * saves neither — never half.
 *
 * It does not touch the creator, the owner, the lead manager seat, the stage,
 * the sales type, the next action or any verdict.
 * ------------------------------------------------------------------------- */

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const schema = z
  .object({
    customerId: z.string().min(1),
    edits: z
      .object({
        fields: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
        answers: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
  })
  .strict();

/** The editable answers as the lead holds them, under the names the review uses. */
function snapshot(lead: LeadRow): Record<string, unknown> {
  const q = (lead.leadQualification ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {
    customerType: lead.customerType,
    monthlyLitres: lead.leadMonthlyVolumeLitres,
    competitor: lead.leadCompetitor,
    requiredProductId: lead.leadRequiredProductId,
    contactPerson: lead.contactPerson,
    decisionMaker: lead.leadDecisionMaker,
    creditDaysWanted: lead.leadCreditDaysWanted,
    application: lead.leadApplication,
    buyer: lead.leadBuyer,
    gstin: lead.gstin,
  };
  for (const k of QUALIFICATION_ANSWER_KEYS) out[k] = q[k] ?? null;
  return out;
}

export async function saveQualificationReviewEdits(
  input: z.input<typeof schema>,
): Promise<Result<{ changed: number }>> {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return err("That is not something the review can save.", "validation");
    const { customerId } = parsed.data;
    const split = splitEdits(parsed.data.edits as never);

    /* A name this review does not edit refuses the WHOLE request. Saving the
       half it recognises would hide that the other half was refused. */
    if (split.refused.length) {
      return err(`The review cannot change: ${split.refused.join(", ")}. Nothing was saved.`, "validation");
    }
    const fieldKeys = Object.keys(split.fields);
    const answerKeys = Object.keys(split.answers);
    if (!fieldKeys.length && !answerKeys.length) return err("There is nothing to save.", "validation");

    const before = await leadRow(customerId);
    if (!before || !before.leadStage) return err("That lead is not on MahekOne.", "not_found");
    await assertLeadInScope(customerId, before);

    /* The existing approver gate first (it audits the hat and refuses the owner
       and a different Sales Manager), then the one person it is designated to. */
    const approver = await requireQualificationApprover(customerId);
    if (!approver.ok) return err(approver.message, "not_permitted");
    const ctx = approver.ctx;
    const designated = await assertDesignatedQualificationApprover(customerId, ctx.user.id);
    if (!designated.ok) return err(designated.message, "not_permitted");

    const access = qualificationAccess(before.leadStage);
    if (!access.writable) return err(access.reason, "rule_violation");

    /* The Salesman collects; the Sales Manager does not fill in Qualification
       answers. Asked of the CRM's own rule, for the whole request. */
    if ([...fieldKeys, ...answerKeys].some(isCollectorEdit)) {
      const barred = await qualificationCollectorRefusal(ctx.user, {
        id: customerId,
        ownerId: before.ownerId,
        salesManagerId: before.salesManagerId,
        leadStage: before.leadStage,
      });
      if (barred) return err(`${barred} Nothing was saved.`, "rule_violation");
    }

    const wasSnapshot = snapshot(before);

    /* The fields first: their validation is the one that can plausibly refuse.
       If the fields are refused nothing has been written yet. */
    if (fieldKeys.length) {
      const r = await saveProspectFields(customerId, split.fields as never);
      if (!r.ok) return r as Result<{ changed: number }>;
    }
    let answersNote: string | null = null;
    if (answerKeys.length) {
      const r = await saveLeadQualification(customerId, split.answers as Record<string, string>);
      if (!r.ok) answersNote = `The other answers were saved, but these were not: ${r.error}`;
    }

    const after = await leadRow(customerId);
    const nowSnapshot = after ? snapshot(after) : wasSnapshot;
    const changes = diffAnswers([...PROSPECT_EDIT_KEYS, ...QUALIFICATION_ANSWER_KEYS], wasSnapshot, nowSnapshot);

    if (changes.length) {
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.insert(auditLog).values({
          id: gen("aud"),
          actorId: ctx.user.id,
          action: REVIEW_EDIT_ACTION,
          entityType: "customer",
          entityId: customerId,
          actorRole: ctx.authorisedBy,
          actorApp: ctx.authorisedIn,
          beforeState: Object.fromEntries(changes.map((c) => [c.field, c.from])),
          afterState: { changes },
        });
        await writeTimelineEvent(tx, {
          customerId,
          eventType: MBOS_EVENT.qualificationReview,
          sourceApp: "crm",
          sourceRecordId: `${customerId}:review-edit:${now.toISOString()}`,
          occurredAt: now,
          actorUserId: ctx.user.id,
          /* The names of what changed, never the values: the timeline is read by
             far more people than the lead's own answers are. */
          summary: `${ctx.user.name} changed ${changes.map((c) => c.label).join(", ")} while reviewing the qualification of ${before.name}.`,
        });
      });

      /* Told, after the write, and never able to fail it. Field NAMES only. */
      if (before.ownerId && before.ownerId !== ctx.user.id) {
        await notifyUser({
          userId: before.ownerId,
          title: `${before.name}: your sales manager changed ${changes.length} answer${changes.length === 1 ? "" : "s"}`,
          body: `${changes.map((c) => c.label).join(", ")} — changed while reviewing the qualification.`,
          kind: "info",
          href: `/crm/leads/${customerId}/review`,
        }).catch(() => {});
      }
    }

    try {
      revalidatePath(`/crm/leads/${customerId}`);
      revalidatePath(`/crm/leads/${customerId}/qualify`);
      revalidatePath(`/crm/leads/${customerId}/review`);
      revalidatePath(`/sales/leads/${customerId}`);
      revalidatePath(`/sales/leads/${customerId}/review`);
    } catch {
      /* no request context - a job or a test, where nothing is cached */
    }

    if (answersNote) return err(answersNote, "rule_violation");
    return ok(
      { changed: changes.length },
      changes.length ? `Saved ${changes.length} change${changes.length === 1 ? "" : "s"}.` : "Nothing was different, so nothing changed.",
    );
  } catch (e) {
    return fromThrown(e);
  }
}
