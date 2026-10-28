"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, customers } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { notifyUser } from "@/lib/notify";
import { MBOS_EVENT, writeTimelineEvent } from "@/lib/timeline";
import { today } from "@/lib/recompute";
import { gateTo } from "@/lib/engines/lead-gates";
import { PROSPECT_REVIEW_AUDIT, PROSPECT_REVIEW_NEXT, prospectReviewStateOf } from "@/lib/prospect-review";
import { assertLeadInScope } from "@/lib/services/lead-scope";
import { leadGateInput, leadRow } from "@/lib/services/lead-service";
import { requireProspectVerifier } from "@/lib/services/prospect-verifier";
import { openQualificationAfterVerification } from "@/lib/services/lead-qualification-flow-service";
import { requestOf, settleProspectRequest } from "@/lib/services/lead-prospect-request-service";
import { returnProspectRequest } from "@/lib/actions/lead-calling-desk";
import { err, fromThrown, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * THE PROSPECT REVIEW — the primary verification, and the call is optional.
 *
 * A Prospect submitted for Qualification goes to its designated verifier, who
 * reads every Suspect and Prospect answer on one page and either CONFIRMS it —
 * which opens Qualification — or RETURNS it with a reason. A verification CALL
 * used to be the act that did this. It is now an optional follow-up the verifier
 * records after the decision; nothing here, and nothing downstream, waits for one.
 *
 * Nothing in this file decides WHO the verifier is. `requireLeadVerifier(…,
 * { designated: true })` is the one gate the verification call already asks —
 * the org chart's designated verifier where the chart is on, and the existing
 * permission and seat rules where it is off — and it is asked here, unchanged,
 * at the one place each decision is written. No routing rule, setting or
 * hierarchy relationship is added or altered.
 *
 * It also moves the lead through the SAME shared functions every other door uses
 * (`settleProspectRequest` to promote a desk's request, `openQualificationAfter
 * Verification` to open the rung), so the stage, the next action and the
 * notifications are exactly what a successful call produced.
 * ------------------------------------------------------------------------- */

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

function refresh(customerId: string) {
  try {
    for (const p of [
      `/crm/leads/${customerId}`,
      `/crm/leads/${customerId}/review`,
      `/crm/leads/${customerId}/qualify`,
      `/crm/leads/${customerId}/verify`,
      `/crm/leads/sales-manager/${customerId}`,
      `/crm/leads/sales-manager/${customerId}/review`,
      "/crm/leads/qualify/verification",
      "/crm/leads/calling-desk",
    ]) {
      revalidatePath(p);
    }
  } catch {
    /* no request context - a job or a test, where nothing is cached */
  }
}

const confirmSchema = z.object({ customerId: z.string().min(1) });
const returnSchema = z.object({
  customerId: z.string().min(1),
  note: z.string().trim().min(1, "Say what needs correcting — the owner works from this sentence.").max(2000),
});

/** The lead and its pending-review state, or the refusal. The verifier gate is asked by the caller. */
async function pendingReview(customerId: string) {
  const lead = await leadRow(customerId);
  if (!lead || !lead.leadStage) return { ok: false as const, refusal: err("That lead is not on MahekOne.", "not_found") };
  await assertLeadInScope(customerId, lead);
  const req = await requestOf(customerId);
  const state = prospectReviewStateOf({
    stage: lead.leadStage,
    verifiedAt: lead.leadVerifiedAt,
    nextAction: lead.leadNextAction,
    requestState: req?.state ?? null,
  });
  return { ok: true as const, lead, req, state };
}

/**
 * CONFIRM the Prospect: the designated verifier has read every Suspect and
 * Prospect answer and accepts them. Records the verification, promotes a desk's
 * request, and opens Qualification — with no call in between.
 */
export async function confirmProspectReview(input: z.input<typeof confirmSchema>): Promise<Result<null>> {
  try {
    const parsed = confirmSchema.safeParse(input);
    if (!parsed.success) return err("Say which lead.", "validation");
    const { customerId } = parsed.data;

    const found = await pendingReview(customerId);
    if (!found.ok) return found.refusal;
    const { lead, req, state } = found;

    /* The one gate the verification call asks — the org chart's designated
       verifier — asked before anything is said about the lead's state. */
    const ctx = await requireProspectVerifier(customerId);

    if (state === "confirmed") return err("This Prospect has already been confirmed.", "rule_violation");
    if (state === "returned") {
      return err("This Prospect was returned for correction. It is reviewed again once it is resubmitted.", "rule_violation");
    }
    if (state !== "pending") return err("There is no Prospect waiting for review on this lead.", "rule_violation");

    /* Confirm only on a complete set of answers: the gate's own verdict for the
       Prospect rung, the same one the move itself asks. */
    const gate = await leadGateInput(customerId);
    if (!gate) return err("That lead is not on MahekOne.", "not_found");
    const verdict = gateTo({ ...gate, prospectReasonRecorded: true }, "prospect");
    if (!verdict.open) {
      return err(`Not ready to confirm: ${verdict.missing.map((c) => c.says).join("; ")}.`, "rule_violation");
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({ leadVerifiedAt: now, leadVerifiedById: ctx.user.id, leadLastActivityDate: await today(), updatedAt: now })
        .where(eq(customers.id, customerId));
      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.validation,
        sourceApp: "crm",
        sourceRecordId: `${customerId}:prospect-review:${now.toISOString()}`,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: `${ctx.user.name} confirmed the Suspect and Prospect answers for ${lead.name}. Qualification opens.`,
      });
      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: PROSPECT_REVIEW_AUDIT.confirm,
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: { stage: lead.leadStage, verified: false },
        afterState: { verified: true, via: "review" },
      });
    });

    /* A desk's request is promoted here, on the review's own evidence. */
    if (req?.state === "awaiting" || req?.state === "followup") {
      const settled = await settleProspectRequest(customerId, "verified", { evidence: "review" });
      if (!settled.ok) {
        refresh(customerId);
        return err(`The review is recorded, but the lead could not be made a Prospect: ${settled.error}`, "rule_violation");
      }
    }

    const opened = await openQualificationAfterVerification(
      { userId: ctx.user.id, hat: { app: ctx.authorisedIn, role: ctx.authorisedBy }, sourceApp: "crm" },
      customerId,
    ).catch(() => null);
    refresh(customerId);
    return ok(
      null,
      opened?.opened
        ? "Confirmed — Qualification is open."
        : `Confirmed.${opened && opened.reason !== "already_open" ? ` Qualification did not open yet: ${opened.message}` : ""}`,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * RETURN the Prospect for correction, with the reason it is owed. Every answer is
 * kept. A desk's request goes back through the existing return (so it is
 * resubmitted the way it always was); a Prospect nobody has confirmed stays where
 * it is with the owner's next action set to correct it and send it back.
 */
export async function returnProspectForCorrection(input: z.input<typeof returnSchema>): Promise<Result<null>> {
  try {
    const parsed = returnSchema.safeParse(input);
    if (!parsed.success) {
      return err(parsed.error.issues[0]?.message ?? "Say what needs correcting.", "validation", [
        { field: "note", message: "What does the owner need to correct?" },
      ]);
    }
    const { customerId, note } = parsed.data;

    const found = await pendingReview(customerId);
    if (!found.ok) return found.refusal;
    const { lead, req, state } = found;

    const ctx = await requireProspectVerifier(customerId);
    if (state !== "pending") return err("There is no Prospect waiting for review on this lead.", "rule_violation");

    /* A desk's request: the existing return, which files its own audit row and
       timeline entry and puts the request in the desk's hands to resubmit. */
    if (req?.state === "awaiting" || req?.state === "followup") {
      const sent = await returnProspectRequest({ customerId, note });
      refresh(customerId);
      return sent.ok ? ok(null, "Returned to the desk with your reason. Every answer is kept.") : sent;
    }

    const day = await today();
    const now = new Date();
    const owner = lead.ownerId ?? lead.salesAmId;
    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          leadNextAction: PROSPECT_REVIEW_NEXT.returned,
          leadNextActionDate: day,
          leadNextActionOwnerId: owner,
          leadNextActionOutcome: note,
          leadLastActivityDate: day,
          updatedAt: now,
        })
        .where(eq(customers.id, customerId));
      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.prospectReturned,
        sourceApp: "crm",
        sourceRecordId: `${customerId}:returned:${now.toISOString()}`,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: `${ctx.user.name} returned the Prospect ${lead.name} for correction: ${note}`,
      });
      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: PROSPECT_REVIEW_AUDIT.returned,
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        beforeState: { nextAction: lead.leadNextAction ?? null },
        afterState: { returned: true, note },
      });
    });

    if (owner && owner !== ctx.user.id) {
      await notifyUser({
        userId: owner,
        title: `${lead.name}: returned for correction`,
        body: `${note} — correct it and send it back for review.`,
        kind: "warn",
        href: `/crm/leads/${customerId}/review`,
      }).catch(() => {});
    }
    refresh(customerId);
    return ok(null, "Returned for correction with your reason. Every answer is kept.");
  } catch (e) {
    return fromThrown(e);
  }
}

/**
 * RESUBMIT a returned Prospect for review. The owner's act, only once it was
 * returned, and it puts it back in front of the verifier it came from.
 */
export async function resubmitProspectForReview(customerId: string): Promise<Result<null>> {
  try {
    const ctx = await requireCapability("lead.work");
    const found = await pendingReview(customerId);
    if (!found.ok) return found.refusal;
    const { lead, state } = found;

    if (state !== "returned" || lead.leadStage !== "prospect") {
      return err(
        lead.leadStage !== "prospect" && state === "returned"
          ? "This request was returned to the Calling desk — correct it and resubmit it from there."
          : "Nothing has been returned on this lead, so there is nothing to resubmit.",
        "rule_violation",
      );
    }
    if (lead.ownerId !== ctx.user.id) {
      return err("Only the lead's owner can send it back for review.", "not_permitted");
    }

    const verifier = lead.leadManagerId ?? lead.salesManagerId;
    const day = await today();
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(customers)
        .set({
          leadNextAction: PROSPECT_REVIEW_NEXT.review,
          leadNextActionDate: day,
          leadNextActionOwnerId: verifier,
          leadNextActionOutcome: "Read every answer, then confirm it or return it",
          leadLastActivityDate: day,
          updatedAt: now,
        })
        .where(eq(customers.id, customerId));
      await writeTimelineEvent(tx, {
        customerId,
        eventType: MBOS_EVENT.prospectRequested,
        sourceApp: "crm",
        sourceRecordId: `${customerId}:resubmitted:${now.toISOString()}`,
        occurredAt: now,
        actorUserId: ctx.user.id,
        summary: `${ctx.user.name} resubmitted ${lead.name} for review.`,
      });
      await tx.insert(auditLog).values({
        id: gen("aud"),
        actorId: ctx.user.id,
        action: PROSPECT_REVIEW_AUDIT.resubmit,
        entityType: "customer",
        entityId: customerId,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        afterState: { resubmitted: true },
      });
    });
    if (verifier && verifier !== ctx.user.id) {
      await notifyUser({
        userId: verifier,
        title: `${lead.name} is ready to review`,
        body: `${ctx.user.name} corrected and resubmitted ${lead.name}. Read every Suspect and Prospect answer, then confirm it or return it.`,
        kind: "info",
        href: `/crm/leads/${customerId}/review`,
      }).catch(() => {});
    }
    refresh(customerId);
    return ok(null, "Sent back to the verifier for review.");
  } catch (e) {
    return fromThrown(e);
  }
}
