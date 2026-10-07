"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { hireAnswers, hireRejectionProposals, hireStageExecutions, type HireAnswer } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { err, ok, type Result } from "@/lib/result";
import { HireNotPermitted, requireHireCap, type HireContext } from "../access";
import { scoreAnswer } from "../ai/score-answer";
import { graceProblem, scoreCalc, scoreFixed, stageResult } from "../engines/scoring";
import { audit, hid, moveApplication } from "../services/core";
import { confirmedPoints, currentAnswers, loadExecution } from "../services/scoring";

/* ---------------------------------------------------------------------------
 * Scoring writes (design §7.4, spec §3, §2.4). APPEND-ONLY: every confirmation,
 * adjustment or AI re-score is a NEW hire_answers row and the one before it
 * carries `superseded_by_id`. A completed stage is never edited; correcting it
 * opens a new execution that supersedes the old.
 * ------------------------------------------------------------------------- */

const REASON_MIN = 10;

async function guard<T>(cap: "score" | "grace", fn: (ctx: HireContext) => Promise<Result<T>>): Promise<Result<T>> {
  try {
    const ctx = await requireHireCap(cap);
    return await fn(ctx);
  } catch (e) {
    if (e instanceof HireNotPermitted) return err(e.message, "not_permitted");
    console.error("hire scoring:", e);
    return err(e instanceof Error ? e.message : "Something went wrong.");
  }
}

/** Append a row superseding the current answer to this question. */
async function appendAnswer(prev: HireAnswer | undefined, row: Omit<typeof hireAnswers.$inferInsert, "id">): Promise<string> {
  const id = hid("han");
  await db.transaction(async (tx) => {
    await tx.insert(hireAnswers).values({ ...row, id });
    if (prev) await tx.update(hireAnswers).set({ supersededById: id }).where(and(eq(hireAnswers.id, prev.id), isNull(hireAnswers.supersededById)));
  });
  return id;
}

export type ConfirmInput =
  | { kind: "accept" }
  | { kind: "adjust"; score: number; reason: string }
  | { kind: "manual"; score: number; reason: string }
  | { kind: "fixed"; selected: string[] }
  | { kind: "calc"; inputs: Record<string, number> };

export async function confirmAnswer(execId: string, questionKey: string, input: ConfirmInput): Promise<Result<{ score: number }>> {
  return guard("score", async (ctx) => {
    const loaded = await loadExecution(ctx, execId);
    if (!loaded) return err("That stage is not one you can score.", "not_found");
    const { exec, b, stage } = loaded;
    if (exec.supersededById) return err("This run of the stage was superseded by a correction — score the current one.", "rule_violation");
    if (exec.status === "completed") return err(`${stage.name} is already completed. Use “Correct this stage” to reopen it as a new record.`, "rule_violation");
    const q = stage.questions.find((x) => x.key === questionKey);
    if (!q) return err("That question is not in this stage.", "not_found");
    const prev = (await currentAnswers(exec.id)).filter((a) => a.questionKey === q.key).pop();
    const base = {
      executionId: exec.id,
      questionKey: q.key,
      responseText: prev?.responseText ?? null,
      maxPoints: q.maxPoints,
      aiScore: prev?.aiScore ?? null,
      aiReasoning: prev?.aiReasoning ?? null,
      aiConfidence: prev?.aiConfidence ?? null,
      aiFlags: prev?.aiFlags ?? [],
      evidence: prev?.evidence ?? [],
      probeSuggestion: prev?.probeSuggestion ?? null,
      aiTaskId: prev?.aiTaskId ?? null,
      confirmedById: ctx.user.id,
      confirmedAt: new Date(),
      createdById: ctx.user.id,
    };
    let score: number;
    let row: Omit<typeof hireAnswers.$inferInsert, "id">;
    let summary: string;

    if (input.kind === "accept") {
      if (prev?.aiScore == null) return err("There is no AI score to accept on this question.", "rule_violation");
      score = prev.aiScore;
      row = { ...base, score, scoredBy: "ai", humanAction: "accepted" };
      summary = `Accepted the AI score ${score}/${q.maxPoints} on “${q.text.slice(0, 60)}”`;
    } else if (input.kind === "adjust" || input.kind === "manual") {
      if (!Number.isFinite(input.score) || input.score < 0 || input.score > q.maxPoints)
        return { ok: false, error: `A score between 0 and ${q.maxPoints}.`, code: "validation", fieldErrors: [{ field: "score", message: `0–${q.maxPoints}` }] };
      if (input.reason.trim().length < REASON_MIN)
        return { ok: false, error: "Say why in a sentence — it is kept beside the score.", code: "validation", fieldErrors: [{ field: "reason", message: `At least ${REASON_MIN} characters` }] };
      if (input.kind === "adjust" && prev?.aiScore == null) return err("There is no AI score to adjust — score it yourself.", "rule_violation");
      score = Math.round(input.score * 10) / 10;
      row = { ...base, score, scoredBy: "human", humanAction: input.kind === "adjust" ? "adjusted" : prev?.aiScore != null ? "scored_myself" : "manual", overrideReason: input.reason.trim() };
      summary =
        input.kind === "adjust"
          ? `Adjusted the AI score ${prev?.aiScore} → ${score}/${q.maxPoints} on “${q.text.slice(0, 60)}” · “${input.reason.trim()}”`
          : `Scored ${score}/${q.maxPoints} by hand on “${q.text.slice(0, 60)}”${prev?.aiScore != null ? ` (AI had ${prev.aiScore})` : ""} · “${input.reason.trim()}”`;
    } else if (input.kind === "fixed") {
      if (q.mode !== "fixed_choice") return err("That question is not fixed-choice.", "validation");
      const valid = (q.options ?? []).map((o) => o.key);
      const sel = input.selected.filter((k) => valid.includes(k));
      if (!sel.length) return { ok: false, error: "Select an answer.", code: "validation", fieldErrors: [{ field: "selected", message: "Required" }] };
      if (!q.cumulative && sel.length > 1) return err("This question takes one answer.", "validation");
      const r = scoreFixed(q, sel);
      if (r.points == null) return err(`${r.why} The blueprint has to define it before this can be scored.`, "rule_violation");
      score = r.points;
      row = { ...base, selected: sel, responseText: `Selected: ${(q.options ?? []).filter((o) => sel.includes(o.key)).map((o) => o.label).join(", ")}`, score, scoredBy: "fixed_choice", humanAction: "selected" };
      summary = `Recorded “${q.text.slice(0, 60)}” · ${r.why}`;
    } else {
      if (q.mode !== "calculated" || !q.calc) return err("That question is not calculated.", "validation");
      const r = scoreCalc(q.calc, input.inputs);
      if (r.points == null) return err(r.why, "validation");
      score = r.points;
      row = { ...base, calcInputs: input.inputs, responseText: r.why, score, scoredBy: "calculated", humanAction: "calculated" };
      summary = `Calculated “${q.text.slice(0, 60)}” · ${r.why}`;
    }

    const id = await appendAnswer(prev, row);
    if (exec.status === "not_started" || exec.status === "scheduled")
      await db.update(hireStageExecutions).set({ status: "in_progress", startedAt: exec.startedAt ?? new Date(), conductedById: exec.conductedById ?? ctx.user.id, updatedAt: new Date() }).where(eq(hireStageExecutions.id, exec.id));
    await audit(ctx, { applicationId: b.app.id, candidateId: b.candidate.id, entityType: "answer", entityId: id, eventType: "score_confirmed", summary: `${stage.name}: ${summary}` });
    revalidatePath(`/hire/scoring/${execId}`);
    return ok({ score }, "Score confirmed.");
  });
}

/** Ask the AI to score a written or transcribed answer. Never confirms anything. */
export async function aiScoreQuestion(execId: string, questionKey: string, responseText?: string): Promise<Result<{ insufficient: boolean }>> {
  return guard("score", async (ctx) => {
    const loaded = await loadExecution(ctx, execId);
    if (!loaded) return err("That stage is not one you can score.", "not_found");
    const { exec, b, stage } = loaded;
    if (exec.status === "completed" || exec.supersededById) return err("This stage is closed for scoring.", "rule_violation");
    const q = stage.questions.find((x) => x.key === questionKey);
    if (!q || q.mode !== "ai_rubric") return err("Only rubric questions are scored by AI.", "validation");
    const prev = (await currentAnswers(exec.id)).filter((a) => a.questionKey === q.key).pop();
    const text = (responseText ?? prev?.responseText ?? "").trim();
    if (!text) return { ok: false, error: "There is no answer to score — type or paste what the candidate said.", code: "validation", fieldErrors: [{ field: "response", message: "Required" }] };
    const r = await scoreAnswer({
      question: q,
      competencies: b.def.competencies,
      roleTitle: b.blueprint.title,
      response: text,
      sourceLabel: `${stage.name} · ${q.key.toUpperCase()}`,
      actorId: ctx.user.id,
      applicationId: b.app.id,
      blueprintId: b.blueprint.id,
      answerId: prev?.id,
    });
    if (!r.ok) {
      /* The response is still kept, so the person can score it by hand. */
      if (!prev || prev.responseText !== text)
        await appendAnswer(prev, { executionId: exec.id, questionKey: q.key, responseText: text, maxPoints: q.maxPoints, createdById: ctx.user.id });
      revalidatePath(`/hire/scoring/${execId}`);
      return err(r.reason, "rule_violation");
    }
    const o = r.output;
    const id = await appendAnswer(prev, {
      executionId: exec.id,
      questionKey: q.key,
      responseText: text,
      maxPoints: q.maxPoints,
      aiScore: o.score,
      aiReasoning: o.reasoning,
      aiConfidence: o.confidence,
      aiFlags: o.flags,
      evidence: o.evidence,
      probeSuggestion: o.probe,
      aiTaskId: r.taskId,
      createdById: ctx.user.id,
    });
    await audit(ctx, {
      applicationId: b.app.id,
      candidateId: b.candidate.id,
      entityType: "answer",
      entityId: id,
      eventType: "ai_scored",
      summary: `${stage.name}: AI ${o.insufficient ? "found the answer too brief to score" : `proposed ${o.score}/${q.maxPoints} (${o.confidenceWord})`} on “${q.text.slice(0, 60)}” — awaiting a person`,
      aiTaskId: r.taskId,
    });
    revalidatePath(`/hire/scoring/${execId}`);
    return ok({ insufficient: o.insufficient }, o.insufficient ? "Too brief to score — a probe is suggested." : "AI assessment ready for your review.");
  });
}

/** Save the grace adjustment (separate from the rubric total; reason mandatory). */
export async function setGrace(execId: string, grace: number, reason: string): Promise<Result> {
  return guard("grace", async (ctx) => {
    const loaded = await loadExecution(ctx, execId);
    if (!loaded) return err("That stage is not one you can score.", "not_found");
    const { exec, b, stage } = loaded;
    if (exec.status === "completed" || exec.supersededById) return err("This stage is closed. Correct it to change the grace.", "rule_violation");
    const problem = graceProblem(stage, grace, reason);
    if (problem) return { ok: false, error: problem, code: "validation", fieldErrors: [{ field: "graceReason", message: problem }] };
    await db.update(hireStageExecutions).set({ grace, graceReason: grace ? reason.trim() : null, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hireStageExecutions.id, exec.id));
    await audit(ctx, { applicationId: b.app.id, candidateId: b.candidate.id, entityType: "stage", entityId: exec.id, eventType: "grace", summary: `${stage.name}: grace ${grace > 0 ? "+" : ""}${grace}${grace ? ` · “${reason.trim()}”` : ""}` });
    revalidatePath(`/hire/scoring/${execId}`);
    return ok(undefined, "Grace saved.");
  });
}

/** Complete the stage: the outcome is recorded once, from confirmed scores, with one threshold. */
export async function completeStage(execId: string, grace: number, graceReason: string): Promise<Result<{ outcome: string; final: number; proposed: boolean }>> {
  return guard("score", async (ctx) => {
    if (grace !== 0 && !ctx.can("grace")) return err("A grace adjustment needs a role that may apply one.", "not_permitted");
    const loaded = await loadExecution(ctx, execId);
    if (!loaded) return err("That stage is not one you can score.", "not_found");
    const { exec, b, stage } = loaded;
    if (exec.supersededById) return err("This run of the stage was superseded.", "rule_violation");
    if (exec.status === "completed") return err(`${stage.name} is already completed.`, "rule_violation");
    const problem = graceProblem(stage, grace, graceReason);
    if (problem) return { ok: false, error: problem, code: "validation", fieldErrors: [{ field: "graceReason", message: problem }] };
    const answers = await currentAnswers(exec.id);
    const r = stageResult(stage, confirmedPoints(stage, answers), grace);
    if (r.outcome === "pending") return err(`${r.missing.length} question${r.missing.length === 1 ? " still needs" : "s still need"} a confirmed score.`, "rule_violation");
    /* A rubric question scored entirely by hand — AI never looked — is flagged for AI review when it returns (spec §4.3). */
    const manualWhileDown = stage.questions.some((q) => {
      const a = answers.filter((x) => x.questionKey === q.key).pop();
      return q.mode === "ai_rubric" && a?.aiScore == null && a?.humanAction === "manual";
    });
    const now = new Date();
    let proposed = false;
    await db.transaction(async (tx) => {
      await tx
        .update(hireStageExecutions)
        .set({
          status: "completed",
          completedAt: now,
          earned: r.earned,
          maxPoints: r.max,
          normalised: r.normalised,
          grace,
          graceReason: grace ? graceReason.trim() : null,
          finalScore: r.final,
          outcome: r.outcome,
          aiReviewPending: manualWhileDown,
          conductedById: exec.conductedById ?? ctx.user.id,
          updatedAt: now,
          updatedById: ctx.user.id,
        })
        .where(and(eq(hireStageExecutions.id, exec.id), isNull(hireStageExecutions.supersededById)));
      if (r.outcome === "fail") {
        const [open] = (await tx.execute(sql`select 1 from hire_rejection_proposals p where p.application_id = ${b.app.id} and p.stage_key = ${stage.key} and p.status = 'open' limit 1`)) as unknown as unknown[];
        if (!open) {
          const days = (await getConfig())["hire.rejection.reviewDays"];
          await tx.insert(hireRejectionProposals).values({
            id: hid("hrp"),
            applicationId: b.app.id,
            stageKey: stage.key,
            score: r.final,
            reasonCode: "below_pass",
            note: r.belowFloor ? `${r.final} is below this stage's floor of ${stage.autoRejectFloor}.` : `${r.final} against a pass mark of ${stage.passThreshold}.`,
            proposedById: ctx.user.id,
            windowEndsAt: new Date(now.getTime() + days * 86_400_000),
          });
          proposed = true;
        }
      }
      await audit(
        ctx,
        {
          applicationId: b.app.id,
          candidateId: b.candidate.id,
          entityType: "stage",
          entityId: exec.id,
          eventType: "stage_completed",
          summary: `${stage.name} completed · ${r.earned} of ${r.max} · ${r.normalised}${grace ? ` · grace ${grace > 0 ? "+" : ""}${grace} → ${r.final}` : ""} · ${r.outcome === "pass" ? "Pass" : "Fail"} against ${stage.passThreshold}${r.graceFlipped ? " · GRACE CHANGED THE OUTCOME" : ""}${manualWhileDown ? " · scored by hand, flagged for AI review" : ""}${proposed ? " · rejection proposed for a person to confirm" : ""}`,
          after: { earned: r.earned, normalised: r.normalised, grace, final: r.final, outcome: r.outcome, graceFlipped: r.graceFlipped },
        },
        tx,
      );
    });
    revalidatePath(`/hire/scoring/${execId}`);
    revalidatePath("/hire/review");
    return ok(
      { outcome: r.outcome, final: r.final, proposed },
      r.outcome === "pass" ? `${stage.name} passed at ${r.final}.` : `${stage.name} not passed at ${r.final}. A rejection is proposed — a named person confirms it in Decisions.`,
    );
  });
}

/** Correct a completed stage: a NEW execution supersedes it, carrying the answers forward. */
export async function reopenStage(execId: string, reason: string): Promise<Result<{ execId: string }>> {
  return guard("score", async (ctx) => {
    if (reason.trim().length < 20) return { ok: false, error: "Say why this stage is being corrected — at least 20 characters.", code: "validation", fieldErrors: [{ field: "reason", message: "At least 20 characters" }] };
    const loaded = await loadExecution(ctx, execId);
    if (!loaded) return err("That stage is not one you can score.", "not_found");
    const { exec, b, stage } = loaded;
    if (exec.supersededById) return err("This run was already corrected.", "rule_violation");
    if (exec.status !== "completed") return err("Only a completed stage is corrected; this one is still open.", "rule_violation");
    if (b.app.stageKey !== stage.key) return err(`${b.candidate.fullName} has moved past ${stage.name}. A completed stage behind them is corrected by a Hiring Manager from the record.`, "rule_violation");
    const newId = hid("hex");
    const answers = await currentAnswers(exec.id);
    await db.transaction(async (tx) => {
      await tx.insert(hireStageExecutions).values({
        id: newId,
        applicationId: exec.applicationId,
        stageKey: exec.stageKey,
        status: "in_progress",
        modality: exec.modality,
        startedAt: new Date(),
        conductedById: exec.conductedById,
        maxPoints: exec.maxPoints,
        grace: exec.grace,
        graceReason: exec.graceReason,
        outcome: "pending",
        entryWasGated: exec.entryWasGated,
        gateOverrideById: exec.gateOverrideById,
        gateOverrideReason: exec.gateOverrideReason,
        createdById: ctx.user.id,
      });
      for (const a of answers) {
        const { id: _old, supersededById: _s, ...rest } = a;
        void _old;
        void _s;
        await tx.insert(hireAnswers).values({ ...rest, id: hid("han"), executionId: newId, createdAt: new Date(), createdById: ctx.user.id });
      }
      await tx.update(hireStageExecutions).set({ supersededById: newId }).where(eq(hireStageExecutions.id, exec.id));
      await tx.execute(sql`update hire_rejection_proposals set status = 'dismissed', resolved_by_id = ${ctx.user.id}, resolved_at = now(), resolution = ${"Stage reopened for correction: " + reason.trim()} where application_id = ${b.app.id} and stage_key = ${stage.key} and status = 'open'`);
      await audit(ctx, { applicationId: b.app.id, candidateId: b.candidate.id, entityType: "stage", entityId: newId, eventType: "stage_reopened", summary: `${stage.name} reopened for correction — the earlier result (${exec.finalScore}, ${exec.outcome}) is kept and superseded · “${reason.trim()}”` }, tx);
    });
    return ok({ execId: newId }, "Reopened as a new record. The earlier result stays in the history.");
  });
}

/** After a pass: move to the next stage through the one gated path. */
export async function moveToNextStage(execId: string): Promise<Result<{ stageKey: string }>> {
  return guard("score", async (ctx) => {
    const loaded = await loadExecution(ctx, execId);
    if (!loaded) return err("Not found.", "not_found");
    const { b, stage } = loaded;
    const i = b.def.stages.findIndex((s) => s.key === stage.key);
    const next = b.def.stages[i + 1];
    if (!next) return err("This is the last stage.", "rule_violation");
    const r = await moveApplication(ctx, b.app.id, next.key);
    if (r.ok) revalidatePath(`/hire/scoring/${execId}`);
    return r;
  });
}
