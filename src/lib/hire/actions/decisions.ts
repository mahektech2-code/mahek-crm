"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { hireApplications, hireDecisions, hireRejectionProposals } from "@/db/schema";
import { notifyUsers } from "@/lib/notify";
import { err, ok, type Result } from "@/lib/result";
import { REJECTION_LABEL, stageByKey } from "../blueprint-types";
import { HireNotPermitted, requireHireCap, seesScores, type HireContext } from "../access";
import { DECISION_REASON_MIN } from "../engines/gating";
import { GATE_POINT } from "../roles";
import { recommendAtGate, type GateRec } from "../ai/gate-recommendation";
import { draftRejection, rejectionTemplate, type RejectionDraft } from "../ai/rejection";
import { rankShortlist, type Ranking } from "../ai/rank";
import { audit, currentExecution, getApplication, hid, recordMessage } from "../services/core";
import { advanceFromGate, compareColumns, gateView, rejectApplication, storeGateRecommendation } from "../services/decisions";

/* ---------------------------------------------------------------------------
 * The writes behind Decisions, the gate and Compare. Each checks its own
 * capability — a server action is a URL — and every one leaves an audit line.
 * ------------------------------------------------------------------------- */

const MIN_REASON = 20;

async function guard<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HireNotPermitted) return err(e.message, "not_permitted");
    console.error("hire decisions:", e);
    return err(e instanceof Error ? e.message : "Something went wrong.");
  }
}

const reasonErr = (min: number) => ({ ok: false as const, error: `Reasoning of at least ${min} characters is required — it stays on the record.`, code: "validation" as const, fieldErrors: [{ field: "reasoning", message: `At least ${min} characters` }] });

/* ------------------------------------------------------------------ gate */

export async function refreshGateRecommendation(applicationId: string): Promise<Result<GateRec>> {
  return guard(async () => {
    const ctx = await requireHireCap("decide");
    const v = await gateView(ctx, applicationId);
    if (!v) return err("That candidate is not on your list.", "not_found");
    const res = await recommendAtGate({
      def: v.bundle.def,
      roleTitle: v.bundle.blueprint.title,
      nextStageName: v.nextStageName,
      cf: v.cf,
      actorId: ctx.user.id,
      applicationId,
      blueprintId: v.bundle.blueprint.id,
    });
    if (!res.ok) return err(res.reason, "rule_violation");
    await storeGateRecommendation(ctx, applicationId, res.output, res.taskId);
    await audit(ctx, { applicationId, candidateId: v.bundle.candidate.id, entityType: "application", entityId: applicationId, eventType: "ai_recommendation", summary: `AI recommendation at the gate: ${res.output.action} (${res.output.confidence})`, aiTaskId: res.taskId });
    revalidatePath(`/hire/gate/${applicationId}`);
    return ok(res.output, "Recommendation refreshed.");
  });
}

export async function recordGateDecision(
  applicationId: string,
  input: { decision: "advance" | "hold" | "reject"; reasoning: string; disagree: boolean; reasonCode?: string },
): Promise<Result<{ next: string | null }>> {
  return guard<{ next: string | null }>(async () => {
    const ctx = await requireHireCap("decide");
    const v = await gateView(ctx, applicationId);
    if (!v) return err("That candidate is not on your list.", "not_found");
    if (!v.atGate) return err(`${v.bundle.candidate.fullName} is not at a decision gate — they are at ${v.bundle.stage?.name ?? v.bundle.app.stageKey}.`, "rule_violation");
    if (!["advance", "hold", "reject"].includes(input.decision)) return err("Choose Advance, Hold or Reject.");
    const reasoning = input.reasoning.trim();
    if (reasoning.length < DECISION_REASON_MIN) return reasonErr(DECISION_REASON_MIN);
    const rec = v.rec;
    const agreed = rec ? !input.disagree && rec.action === input.decision : null;
    const aiSnap = rec ? { action: rec.action, confidence: rec.confidence, why: rec.why } : null;
    const exec = await currentExecution(applicationId, v.bundle.app.stageKey);
    const b = v.bundle;

    if (input.decision === "reject") {
      await rejectApplication(ctx, b, {
        reasoning,
        reasonCode: input.reasonCode && REJECTION_LABEL[input.reasonCode] ? input.reasonCode : "decision",
        stageKey: b.app.stageKey,
        executionId: exec?.id ?? null,
        aiRec: rec,
        agreedWithAi: agreed,
        decisionPoint: GATE_POINT,
      });
      revalidatePath("/hire/decisions");
      return ok({ next: null }, `Rejection recorded for ${b.candidate.fullName}.`);
    }

    await db.insert(hireDecisions).values({
      id: hid("hde"),
      applicationId,
      executionId: exec?.id ?? null,
      decisionPoint: GATE_POINT,
      decidedById: ctx.user.id,
      decidedByRole: ctx.roleLabel,
      decision: input.decision,
      reasoning,
      aiRecommendation: aiSnap,
      agreedWithAi: agreed,
    });
    await audit(ctx, {
      applicationId,
      candidateId: b.candidate.id,
      entityType: "decision",
      entityId: applicationId,
      eventType: "gate_decision",
      summary: `Decision gate: ${input.decision === "advance" ? "Advance" : "Hold"}${rec ? (agreed ? " · agreed with the AI" : " · disagreed with the AI") : " · no AI recommendation"} · “${reasoning}”`,
    });

    if (input.decision === "hold") {
      await db
        .update(hireApplications)
        .set({ status: "on_hold", holdReason: `Held at the decision gate: ${reasoning}`, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hireApplications.id, applicationId));
      await notifyRecruiter(ctx, b.app.recruiterId, `${b.candidate.fullName} is on hold at the gate`, `${ctx.user.name}: “${reasoning}”`, applicationId);
      revalidatePath("/hire/decisions");
      return ok({ next: null }, `${b.candidate.fullName} is on hold.`);
    }

    const moved = await advanceFromGate(ctx, applicationId);
    revalidatePath("/hire/decisions");
    if (!moved.ok) return ok({ next: null }, `Decision recorded, but the move did not happen: ${moved.error}`);
    await notifyRecruiter(ctx, b.app.recruiterId, `${b.candidate.fullName} advanced to ${moved.next}`, `${ctx.user.name}: “${reasoning}”`, applicationId);
    return ok({ next: moved.next }, `${b.candidate.fullName} advanced to ${moved.next}.`);
  });
}

async function notifyRecruiter(ctx: HireContext, userId: string | null, title: string, body: string, applicationId: string) {
  if (!userId || userId === ctx.user.id) return;
  await notifyUsers([{ userId, title, body, href: `/hire/c/${applicationId}` }]).catch(() => undefined);
}

/* ------------------------------------------------------------- proposals */

async function openProposal(proposalId: string) {
  const [p] = await db.select().from(hireRejectionProposals).where(and(eq(hireRejectionProposals.id, proposalId), eq(hireRejectionProposals.status, "open"))).limit(1);
  return p ?? null;
}

export async function confirmProposedRejection(proposalId: string, reasoning: string): Promise<Result<{ applicationId: string }>> {
  return guard(async () => {
    const ctx = await requireHireCap("confirmReject");
    const p = await openProposal(proposalId);
    if (!p) return err("This proposal has already been decided.", "conflict");
    const b = await getApplication(ctx, p.applicationId);
    if (!b) return err("That candidate is not on your list.", "not_found");
    if (reasoning.trim().length < MIN_REASON) return reasonErr(MIN_REASON);
    const exec = await currentExecution(p.applicationId, p.stageKey);
    await rejectApplication(ctx, b, { reasoning, reasonCode: p.reasonCode, stageKey: p.stageKey, executionId: exec?.id ?? null, decisionPoint: "rejection", proposalId: p.id });
    revalidatePath("/hire/decisions");
    return ok({ applicationId: p.applicationId }, `${b.candidate.fullName}’s rejection is confirmed. Draft the message to them next.`);
  });
}

export async function dismissProposal(proposalId: string, reasoning: string): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap("confirmReject");
    const p = await openProposal(proposalId);
    if (!p) return err("This proposal has already been decided.", "conflict");
    const b = await getApplication(ctx, p.applicationId);
    if (!b) return err("That candidate is not on your list.", "not_found");
    const why = reasoning.trim();
    if (why.length < MIN_REASON) return reasonErr(MIN_REASON);
    await db.update(hireRejectionProposals).set({ status: "dismissed", resolvedById: ctx.user.id, resolvedAt: new Date(), resolution: why }).where(eq(hireRejectionProposals.id, proposalId));
    await audit(ctx, {
      applicationId: b.app.id,
      candidateId: b.candidate.id,
      entityType: "rejection_proposal",
      entityId: proposalId,
      eventType: "rejection_dismissed",
      summary: `Proposed rejection at ${stageByKey(b.def, p.stageKey)?.name ?? p.stageKey} dismissed — the candidate stays · “${why}”`,
    });
    revalidatePath("/hire/decisions");
    return ok(undefined, `${b.candidate.fullName} stays in the pipeline.`);
  });
}

/* ----------------------------------------------------- rejection message */

export async function draftRejectionMessage(
  applicationId: string,
  input: { feedback: string; language: string },
): Promise<Result<RejectionDraft & { aiDrafted: boolean; aiTaskId: string | null; note: string | null }>> {
  return guard<RejectionDraft & { aiDrafted: boolean; aiTaskId: string | null; note: string | null }>(async () => {
    const ctx = await requireHireCap("confirmReject");
    const b = await getApplication(ctx, applicationId);
    if (!b) return err("That candidate is not on your list.", "not_found");
    if (b.app.status !== "rejected") return err("A rejection message is drafted only after a person has confirmed the rejection.", "rule_violation");
    const firstName = (b.candidate.preferredName || b.candidate.fullName).split(" ")[0];
    const stageName = stageByKey(b.def, b.app.rejectionStageKey ?? b.app.stageKey)?.name ?? "interview";
    const base = { firstName, roleTitle: b.blueprint.title, stageName, sender: ctx.user.name };
    const res = await draftRejection({
      ...base,
      reason: REJECTION_LABEL[b.app.rejectionReasonCode ?? ""] ?? "not taken further",
      feedback: input.feedback.trim() || null,
      language: input.language || b.candidate.preferredLanguage,
      actorId: ctx.user.id,
      applicationId,
    });
    if (res.ok) return ok({ ...res.output, aiDrafted: true, aiTaskId: res.taskId, note: null });
    const t = rejectionTemplate(base);
    return ok({ ...t, body: input.feedback.trim() ? t.body.replace("You are welcome", `${input.feedback.trim()}\n\nYou are welcome`) : t.body, aiDrafted: false, aiTaskId: null, note: `${res.reason} This is the standard template, in English.` });
  });
}

export async function recordRejectionMessage(
  applicationId: string,
  m: { channel: "email" | "whatsapp" | "sms"; subject: string; body: string; language: string; aiDrafted: boolean; aiTaskId: string | null },
): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap("confirmReject");
    const b = await getApplication(ctx, applicationId);
    if (!b) return err("That candidate is not on your list.", "not_found");
    if (b.candidate.doNotContact) return err(`${b.candidate.fullName} is marked do-not-contact${b.candidate.dncReason ? `: ${b.candidate.dncReason}` : ""}.`, "rule_violation");
    if (m.body.trim().length < 20) return err("The message is empty.");
    await recordMessage(ctx, {
      candidateId: b.candidate.id,
      applicationId,
      direction: "out",
      channel: m.channel,
      language: m.language,
      subject: m.channel === "email" ? m.subject : null,
      body: m.body.trim(),
      aiDrafted: m.aiDrafted,
      aiTaskId: m.aiTaskId,
      status: "logged",
    });
    return ok(undefined, "Recorded on their Communication tab.");
  });
}

/* ---------------------------------------------------------------- compare */

export type RankView = Ranking & { names: Record<string, string> };

export async function rankComparison(ids: string[]): Promise<Result<RankView>> {
  return guard(async () => {
    const ctx = await requireHireCap();
    if (!seesScores(ctx)) return err("Comparisons show scores, which interviewers do not see.", "not_permitted");
    const { columns, def, blueprintId, roleTitle } = await compareColumns(ctx, ids);
    if (!def || columns.length < 2) return err("Pick at least two candidates for the same role.");
    const labels = columns.map((_, i) => `Candidate ${i + 1}`);
    const res = await rankShortlist({
      roleTitle,
      competencies: def.competencies,
      candidates: columns.map((c, i) => ({
        label: labels[i],
        scores: c.cf.competencies,
        statements: Object.entries(c.cf.quotes).flatMap(([comp, qs]) => qs.slice(0, 2).map((q) => ({ text: q.text, source: q.source, competency: comp }))),
      })),
      actorId: ctx.user.id,
      blueprintId: blueprintId!,
    });
    if (!res.ok) return err(res.reason, "rule_violation");
    const names = Object.fromEntries(labels.map((l, i) => [l, columns[i].name]));
    return ok({ ...res.output, names });
  });
}
