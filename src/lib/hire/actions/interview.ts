"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { hireAnswers, hireSessions, hireStageExecutions, type HireCopilotEvent, type HireSegment } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { isScored, stageByKey } from "../blueprint-types";
import { requireHireCap, HireNotPermitted, type HireContext } from "../access";
import { copilotSuggest, type CopilotOut } from "../ai/copilot";
import { audit, getApplication, hid, type AppBundle } from "../services/core";
import { contradictionSources, liveSession } from "../services/interview";

/* ---------------------------------------------------------------------------
 * The interview workspace's writes. Every one checks for itself that the
 * person may interview and that the execution is in their scope — a server
 * action is a URL. The transcript and the copilot log are APPEND-ONLY: a line
 * is added, never edited.
 * ------------------------------------------------------------------------- */

async function authExec(execId: string): Promise<{ ctx: HireContext; exec: typeof hireStageExecutions.$inferSelect; bundle: AppBundle }> {
  const ctx = await requireHireCap("interview");
  const [exec] = await db.select().from(hireStageExecutions).where(eq(hireStageExecutions.id, execId)).limit(1);
  if (!exec || exec.supersededById) throw new HireNotPermitted("That interview is not on your list.");
  const bundle = await getApplication(ctx, exec.applicationId);
  if (!bundle) throw new HireNotPermitted("That interview is not on your list.");
  if (ctx.role === "interviewer" && exec.conductedById && exec.conductedById !== ctx.user.id) throw new HireNotPermitted("That interview is assigned to somebody else.");
  return { ctx, exec, bundle };
}

const fail = (e: unknown): Result<never> => ({ ok: false, error: e instanceof Error ? e.message : "Something went wrong.", code: e instanceof HireNotPermitted ? "not_permitted" : undefined });

/** Consent captured, the session opened. Without consent: notes only, nothing recorded. */
export async function startInterview(execId: string, consent: boolean, takeOver = false): Promise<Result<{ sessionId: string }>> {
  try {
    const { ctx, exec, bundle } = await authExec(execId);
    const stage = stageByKey(bundle.def, exec.stageKey);
    if (!stage || !isScored(stage)) return err("This stage is not an interview.", "validation");
    if (bundle.app.status !== "in_progress") return err(`${bundle.candidate.fullName}’s application is ${bundle.app.status.replace("_", " ")}.`, "rule_violation");
    if (exec.status === "completed") return err("This stage is already scored and complete.", "rule_violation");
    const existing = await liveSession(execId);
    if (existing) return ok({ sessionId: existing.id });

    const now = new Date();
    const sessionId = hid("hse");
    await db.transaction(async (tx) => {
      if (takeOver) {
        await tx
          .update(hireSessions)
          .set({ status: "ended", endedAt: now, escalated: `Taken over by ${ctx.user.name}`, updatedAt: now, updatedById: ctx.user.id })
          .where(and(eq(hireSessions.executionId, execId), eq(hireSessions.modality, "ai_voice"), eq(hireSessions.status, "live")));
      }
      await tx.insert(hireSessions).values({
        id: sessionId,
        executionId: execId,
        modality: takeOver ? "phone" : exec.modality && exec.modality !== "ai_voice" ? exec.modality : "in_person",
        status: "live",
        startedAt: now,
        recordingConsent: consent,
        consentAt: consent ? now : null,
        interviewerIds: [ctx.user.id],
        createdById: ctx.user.id,
      });
      await tx
        .update(hireStageExecutions)
        .set({ status: "in_progress", startedAt: exec.startedAt ?? now, conductedById: exec.conductedById ?? ctx.user.id, updatedAt: now, updatedById: ctx.user.id })
        .where(eq(hireStageExecutions.id, execId));
      await audit(
        ctx,
        {
          applicationId: bundle.app.id,
          candidateId: bundle.candidate.id,
          entityType: "session",
          entityId: sessionId,
          eventType: "interview_started",
          summary: `${takeOver ? "Took over the AI voice screen · " : ""}${stage.name} interview started · ${consent ? "recording consent given out loud" : "no recording consent — notes only, nothing recorded"}`,
        },
        tx,
      );
    });
    return ok({ sessionId });
  } catch (e) {
    return fail(e);
  }
}

/** A line typed by the interviewer — their note of what was said, or their own question. */
export async function addTranscriptLine(execId: string, line: { speaker: "interviewer" | "candidate"; text: string; questionKey: string | null }): Promise<Result<HireSegment>> {
  try {
    const { ctx } = await authExec(execId);
    const text = line.text.trim();
    if (!text) return err("Nothing to add.", "validation");
    if (text.length > 4000) return err("That note is too long for one line — split it.", "validation");
    const s = await liveSession(execId);
    if (!s) return err("The interview is not running.", "rule_violation");
    const at = Date.now() - new Date(s.startedAt).getTime();
    const seg: HireSegment = {
      speaker: line.speaker,
      name: line.speaker === "candidate" ? `Noted by ${ctx.user.name}` : ctx.user.name,
      startMs: Math.max(0, at),
      endMs: Math.max(0, at),
      text,
      questionKey: line.questionKey ?? undefined,
    };
    await db.execute(sql`update hire_sessions set segments = segments || ${JSON.stringify([seg])}::jsonb, updated_at = now() where id = ${s.id}`);
    return ok(seg);
  } catch (e) {
    return fail(e);
  }
}

export type CopilotAnswer = { on: true; out: CopilotOut } | { on: false; reason: string };

/** Ask the copilot — only after the candidate has finished an answer. */
export async function askCopilot(execId: string, currentQuestion: string | null): Promise<Result<CopilotAnswer>> {
  try {
    const { ctx, exec, bundle } = await authExec(execId);
    const s = await liveSession(execId);
    if (!s) return err("The interview is not running.", "rule_violation");
    const stage = stageByKey(bundle.def, exec.stageKey)!;
    const segs = s.segments ?? [];
    const last = [...segs].reverse().find((g) => g.speaker === "candidate");
    if (!last) return ok({ on: false, reason: "Waiting for the candidate’s first answer." });
    const answered = new Set(segs.filter((g) => g.speaker === "candidate" && g.questionKey).map((g) => g.questionKey!));
    if (currentQuestion) answered.add(currentQuestion);
    const probed = new Set(stage.questions.filter((q) => answered.has(q.key)).flatMap((q) => q.competencyKeys));
    const stageComps = [...new Set(stage.questions.flatMap((q) => q.competencyKeys))];
    const unprobed = bundle.def.competencies.filter((c) => stageComps.includes(c.key) && !probed.has(c.key)).map((c) => c.name);
    const remaining = stage.questions
      .filter((q) => !answered.has(q.key) && q.mode === "ai_rubric")
      .map((q) => ({ key: q.key, text: q.text, competency: bundle.def.competencies.find((c) => c.key === q.competencyKeys[0])?.name ?? "—" }));
    const planned = exec.scheduledMinutes ?? 60;
    const minutesLeft = Math.round(planned - (Date.now() - new Date(s.startedAt).getTime()) / 60_000);
    const sources = await contradictionSources(bundle.app.id, execId);
    /* The candidate's most recent ANSWER: the run of their lines since the interviewer last spoke. */
    const tail: string[] = [];
    for (let i = segs.length - 1; i >= 0 && segs[i].speaker === "candidate"; i--) tail.unshift(segs[i].text);
    const res = await copilotSuggest({
      roleTitle: bundle.blueprint.title,
      transcript: segs.map((g) => ({ speaker: g.speaker, text: g.text })),
      lastCandidate: tail.join(" ") || last.text,
      unprobed,
      remaining,
      sources,
      minutesLeft,
      actorId: ctx.user.id,
      applicationId: bundle.app.id,
      blueprintId: bundle.blueprint.id,
      sessionId: s.id,
    });
    if (!res.ok) return ok({ on: false, reason: res.reason });
    const now = new Date().toISOString();
    const events: HireCopilotEvent[] = [];
    if (res.output.suggestion) events.push({ at: now, kind: "suggestion", text: res.output.suggestion, why: res.output.why, action: "shown" });
    if (res.output.contradiction)
      events.push({
        at: now,
        kind: "contradiction",
        text: res.output.contradiction.probe,
        sources: [
          { text: res.output.contradiction.said, source: "Just now" },
          { text: res.output.contradiction.earlier, source: res.output.contradiction.earlierSource },
        ],
        action: "shown",
      });
    if (events.length) await db.execute(sql`update hire_sessions set copilot = copilot || ${JSON.stringify(events)}::jsonb where id = ${s.id}`);
    return ok({ on: true, out: res.output });
  } catch (e) {
    return fail(e);
  }
}

/** Ask or Dismiss — both recorded, because a suggestion nobody acted on is calibration data too. */
export async function copilotAction(execId: string, kind: "suggestion" | "contradiction", text: string, action: "used" | "dismissed"): Promise<Result> {
  try {
    await authExec(execId);
    const s = await liveSession(execId);
    if (!s) return err("The interview is not running.", "rule_violation");
    const ev: HireCopilotEvent = { at: new Date().toISOString(), kind, text, action };
    await db.execute(sql`update hire_sessions set copilot = copilot || ${JSON.stringify([ev])}::jsonb where id = ${s.id}`);
    return ok(undefined);
  } catch (e) {
    return fail(e);
  }
}

/**
 * End the interview. Each asked question gets an answer row carrying the
 * candidate's words, unscored — scoring is the next screen, where a person
 * confirms every score. Captured figures for calculated questions travel as
 * their inputs.
 */
export async function endInterview(execId: string, captured: Record<string, Record<string, number>>): Promise<Result<{ href: string }>> {
  try {
    const { ctx, exec, bundle } = await authExec(execId);
    const s = await liveSession(execId);
    if (!s) return err("The interview is not running.", "rule_violation");
    const stage = stageByKey(bundle.def, exec.stageKey)!;
    const segs = s.segments ?? [];
    const now = new Date();

    const dur = (g: HireSegment) => Math.max(0, g.endMs - g.startMs) || g.text.length * 60;
    const candT = segs.filter((g) => g.speaker === "candidate").reduce((n, g) => n + dur(g), 0);
    const allT = segs.reduce((n, g) => n + dur(g), 0);
    const ratio = allT ? Math.round((candT / allT) * 100) / 100 : null;

    const byQ = new Map<string, string[]>();
    for (const g of segs) if (g.speaker === "candidate" && g.questionKey) byQ.set(g.questionKey, [...(byQ.get(g.questionKey) ?? []), g.text]);

    const current = await db.select({ id: hireAnswers.id, questionKey: hireAnswers.questionKey }).from(hireAnswers).where(and(eq(hireAnswers.executionId, execId), isNull(hireAnswers.supersededById)));
    const curBy = new Map(current.map((a) => [a.questionKey, a.id]));
    let made = 0;

    await db.transaction(async (tx) => {
      for (const q of stage.questions) {
        const words = byQ.get(q.key);
        const inputs = q.mode === "calculated" ? captured[q.key] : undefined;
        const hasInputs = inputs && Object.values(inputs).some((v) => Number.isFinite(v));
        if (!words?.length && !hasInputs) continue;
        const ansId = hid("han");
        await tx.insert(hireAnswers).values({
          id: ansId,
          executionId: execId,
          questionKey: q.key,
          responseText: words?.length ? words.join(" ") : null,
          calcInputs: hasInputs ? inputs! : null,
          maxPoints: q.maxPoints,
          createdById: ctx.user.id,
        });
        const prior = curBy.get(q.key);
        if (prior) await tx.update(hireAnswers).set({ supersededById: ansId }).where(eq(hireAnswers.id, prior));
        made++;
      }
      await tx.update(hireSessions).set({ status: "ended", endedAt: now, candidateTalkRatio: ratio, updatedAt: now, updatedById: ctx.user.id }).where(eq(hireSessions.id, s.id));
      await audit(
        ctx,
        {
          applicationId: bundle.app.id,
          candidateId: bundle.candidate.id,
          entityType: "session",
          entityId: s.id,
          eventType: "interview_ended",
          summary: `${stage.name} interview ended · ${made} of ${stage.questions.length} questions with an answer · ${Math.round((now.getTime() - new Date(s.startedAt).getTime()) / 60_000)} min${ratio != null ? ` · candidate spoke ${Math.round(ratio * 100)}% of the time` : ""}`,
        },
        tx,
      );
    });
    return ok({ href: `/hire/scoring/${execId}` }, "Interview ended. Score each answer next — nothing counts until you confirm it.");
  } catch (e) {
    return fail(e);
  }
}
