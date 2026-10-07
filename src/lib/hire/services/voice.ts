import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { hireAiOutputs, hireAiTasks, hireAnswers, hireFiles, hireSessions, hireStageExecutions, type HireSegment } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { readSecret } from "@/lib/secrets";
import { fileStorage } from "@/lib/storage";
import { err, ok, type Result } from "@/lib/result";
import type { Stage } from "../blueprint-types";
import { stageByKey } from "../blueprint-types";
import type { HireContext } from "../access";
import { aiState, runTask } from "../ai/orchestrator";
import { scoreAnswer } from "../ai/score-answer";
import { VOICE_PROMPT_VERSION, VOICE_TOOLS, voiceInstructions } from "../ai/voice-instructions";
import { audit, getApplication, hid, type AppBundle } from "./core";
import { currentAnswers, scoringView, type ScoringView } from "./scoring";

/* ---------------------------------------------------------------------------
 * The AI voice screen (spec §5.3): minting a short-lived Realtime session for
 * the browser, saving what was said, and the review that follows.
 *
 * The server key never reaches the browser — only an ephemeral client secret
 * that expires in ten minutes. The recording is kept only when the candidate
 * agreed to it; a refusal ends the screen and routes them to a person.
 * ------------------------------------------------------------------------- */

export type ScreenTarget = { b: AppBundle; stage: Stage; execId: string };

export async function screenTarget(ctx: HireContext, execId: string): Promise<ScreenTarget | null> {
  const [exec] = await db.select().from(hireStageExecutions).where(eq(hireStageExecutions.id, execId)).limit(1);
  if (!exec || exec.supersededById) return null;
  const b = await getApplication(ctx, exec.applicationId);
  if (!b) return null;
  const stage = stageByKey(b.def, exec.stageKey);
  if (!stage || stage.type !== "ai_screen") return null;
  if (ctx.role === "interviewer" && exec.conductedById !== ctx.user.id && b.app.interviewerId !== ctx.user.id) return null;
  return { b, stage, execId: exec.id };
}

/** Whether a live screen can run, and if not the sentence saying why. */
export async function realtimeState(): Promise<{ on: true; model: string } | { on: false; reason: string }> {
  const ai = await aiState();
  if (!ai.on) return ai;
  const model = (await getConfig())["hire.ai.realtimeModel"];
  if (!model) return { on: false, reason: "No realtime speech model is configured (Admin Console → Settings → Hire)." };
  return { on: true, model };
}

export async function mintRealtimeSession(ctx: HireContext, execId: string): Promise<Result<{ clientSecret: string; model: string; expiresAt: number | null }>> {
  const t = await screenTarget(ctx, execId);
  if (!t) return err("That screen is not one you can run.", "not_found");
  if (t.b.app.status !== "in_progress" || t.b.app.stageKey !== t.stage.key) return err(`${t.b.candidate.fullName} is not at ${t.stage.name}.`, "rule_violation");
  const state = await realtimeState();
  if (!state.on) return err(state.reason, "rule_violation");
  const key = (await readSecret("openai.apiKey")) as string;
  const cfg = await getConfig();
  const languages = cfg["hire.languages"].split(",").map((s) => s.trim()).filter(Boolean);
  const instructions = voiceInstructions({ roleTitle: t.b.blueprint.title, stage: t.stage, languages, firstName: t.b.candidate.preferredName || t.b.candidate.fullName.split(" ")[0] });
  const started = Date.now();
  let status = "success";
  let error: string | null = null;
  let out: { value?: string; expires_at?: number } = {};
  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 600 },
        session: {
          type: "realtime",
          model: state.model,
          instructions,
          tools: VOICE_TOOLS,
          audio: {
            input: { transcription: { model: cfg["hire.ai.transcriptionModel"] }, turn_detection: { type: "server_vad", silence_duration_ms: 900 } },
            output: { voice: "marin" },
          },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      status = "error";
      error = `${res.status} ${(await res.text()).slice(0, 400)}`;
    } else out = (await res.json()) as typeof out;
  } catch (e) {
    status = "error";
    error = e instanceof Error ? e.message : String(e);
  }
  await db.insert(hireAiTasks).values({
    id: hid("hai"),
    taskType: "voice_screen",
    promptVersion: VOICE_PROMPT_VERSION,
    tier: "realtime",
    modelId: state.model,
    status: status === "success" && out.value ? "success" : "error",
    error,
    latencyMs: Date.now() - started,
    triggeredById: ctx.user.id,
    entityType: "stage_execution",
    entityId: execId,
    applicationId: t.b.app.id,
    blueprintId: t.b.blueprint.id,
    output: { started: true } as never,
    fallbackUsed: out.value ? null : "human_screen",
  });
  if (!out.value) {
    console.error("hire realtime session:", error);
    return err("The AI interviewer could not be started. Schedule a person to screen this candidate instead.", "rule_violation");
  }
  await audit(ctx, { applicationId: t.b.app.id, candidateId: t.b.candidate.id, entityType: "stage", entityId: execId, eventType: "voice_screen_started", summary: `AI voice screen started for ${t.stage.name} · the AI discloses itself and asks consent first` });
  return ok({ clientSecret: out.value, model: state.model, expiresAt: out.expires_at ?? null });
}

/* ------------------------------------------------------------------- save */

export const FinishPayload = z.object({
  execId: z.string(),
  consent: z.boolean().nullable(),
  endReason: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  segments: z.array(
    z.object({ speaker: z.enum(["ai", "candidate"]), startMs: z.number(), endMs: z.number(), text: z.string(), questionKey: z.string().nullable().optional() }),
  ),
  marks: z.array(z.object({ key: z.string(), atMs: z.number() })),
});
export type FinishPayload = z.infer<typeof FinishPayload>;

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));

/** Which question each candidate segment answers: the tool marks, else the nearest question the AI asked. */
export function assignQuestions(stage: Stage, p: Pick<FinishPayload, "segments" | "marks">): HireSegment[] {
  const marks = [...p.marks].filter((m) => stage.questions.some((q) => q.key === m.key)).sort((a, b) => a.atMs - b.atMs);
  let current: string | null = null;
  return p.segments
    .slice()
    .sort((a, b) => a.startMs - b.startMs)
    .map((s) => {
      if (marks.length) {
        const m = marks.filter((x) => x.atMs <= s.startMs + 500).pop();
        current = m?.key ?? null;
      } else if (s.speaker === "ai") {
        const w = words(s.text);
        let best: { key: string; n: number } | null = null;
        for (const q of stage.questions) {
          const qw = words(q.text);
          const n = [...qw].filter((x) => w.has(x)).length / Math.max(1, qw.size);
          if (n >= 0.4 && (!best || n > best.n)) best = { key: q.key, n };
        }
        if (best) current = best.key;
      }
      return { speaker: s.speaker, startMs: Math.round(s.startMs), endMs: Math.round(s.endMs), text: s.text, questionKey: current ?? undefined } as HireSegment;
    });
}

export async function saveVoiceScreen(ctx: HireContext, p: FinishPayload, audio: File | null): Promise<Result<{ sessionId: string; scored: number; manual: number }>> {
  const t = await screenTarget(ctx, p.execId);
  if (!t) return err("That screen is not one you can save.", "not_found");
  const { b, stage } = t;
  const segments = assignQuestions(stage, p);
  const candidateWords = segments.filter((s) => s.speaker === "candidate").reduce((n, s) => n + s.text.split(/\s+/).length, 0);
  const allWords = segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0) || 1;
  const sessionId = hid("hse");
  const refused = p.consent === false || p.endReason === "consent_refused";
  let fileId: string | null = null;

  if (audio && p.consent === true && audio.size > 0) {
    const buf = Buffer.from(await audio.arrayBuffer());
    const type = (audio.type || "audio/webm").split(";")[0];
    const stored = await fileStorage.upload({ key: `hire/audio/${sessionId}.webm`, body: buf, contentType: type });
    fileId = hid("hfi");
    await db.insert(hireFiles).values({ id: fileId, candidateId: b.candidate.id, applicationId: b.app.id, purpose: "audio", filename: `voice-screen-${b.candidate.code}.webm`, contentType: type, sizeBytes: stored.sizeBytes, storedRef: stored.ref, uploadedById: ctx.user.id });
  }

  const startedAt = new Date(Date.now() - p.durationMs);
  await db.insert(hireSessions).values({
    id: sessionId,
    executionId: t.execId,
    modality: "ai_voice",
    status: refused || p.endReason === "human_requested" ? "abandoned" : "ended",
    startedAt,
    endedAt: new Date(),
    recordingConsent: p.consent === true,
    consentAt: p.consent === true ? startedAt : null,
    aiDisclosed: true,
    languages: [],
    segments,
    audioFileId: fileId,
    candidateTalkRatio: Math.round((candidateWords / allWords) * 100) / 100,
    escalated: p.endReason && p.endReason !== "completed" ? p.endReason : null,
    interviewerIds: [ctx.user.id],
    createdById: ctx.user.id,
  });
  await db.update(hireStageExecutions).set({ status: "in_progress", modality: "ai_voice", startedAt: startedAt, conductedById: ctx.user.id, updatedAt: new Date() }).where(eq(hireStageExecutions.id, t.execId));

  if (refused) {
    await audit(ctx, { applicationId: b.app.id, candidateId: b.candidate.id, entityType: "session", entityId: sessionId, eventType: "voice_screen_consent_refused", summary: "AI voice screen ended: the candidate did not agree to recording. Nothing was recorded — schedule a person to screen them." });
    return ok({ sessionId, scored: 0, manual: 0 }, "The candidate did not agree to recording. Nothing was kept; a person should screen them.");
  }

  /* One answer per question, from the candidate's own words. */
  const prev = await currentAnswers(t.execId);
  let scored = 0;
  let manual = 0;
  await Promise.all(
    stage.questions.map(async (q) => {
      const text = segments
        .filter((s) => s.speaker === "candidate" && s.questionKey === q.key)
        .map((s) => s.text.trim())
        .filter(Boolean)
        .join(" ");
      if (!text) return;
      const before = prev.filter((a) => a.questionKey === q.key).pop();
      let ai: Awaited<ReturnType<typeof scoreAnswer>> | null = null;
      if (q.mode === "ai_rubric")
        ai = await scoreAnswer({ question: q, competencies: b.def.competencies, roleTitle: b.blueprint.title, response: text, sourceLabel: `${stage.name} · ${q.key.toUpperCase()}`, actorId: ctx.user.id, applicationId: b.app.id, blueprintId: b.blueprint.id });
      const id = hid("han");
      const o = ai?.ok ? ai.output : null;
      if (o) scored++;
      else manual++;
      await db.insert(hireAnswers).values({
        id,
        executionId: t.execId,
        questionKey: q.key,
        responseText: text,
        maxPoints: q.maxPoints,
        aiScore: o?.score ?? null,
        aiReasoning: o?.reasoning ?? null,
        aiConfidence: o?.confidence ?? null,
        aiFlags: o?.flags ?? [],
        evidence: o?.evidence ?? [],
        probeSuggestion: o?.probe ?? null,
        aiTaskId: ai?.taskId ?? null,
        createdById: ctx.user.id,
      });
      if (before) await db.update(hireAnswers).set({ supersededById: id }).where(and(eq(hireAnswers.id, before.id)));
    }),
  );

  /* The screen's recommendation — AI, marked as such, and only advice. */
  const answered = await currentAnswers(t.execId);
  const lines = stage.questions.map((q) => {
    const a = answered.filter((x) => x.questionKey === q.key).pop();
    return `- ${q.text}\n  Proposed: ${a?.aiScore != null ? `${a.aiScore}/${q.maxPoints}` : a?.responseText ? "not scored" : "not answered"}${a?.aiReasoning ? ` — ${a.aiReasoning}` : ""}`;
  });
  const rec = await runTask({
    taskType: "voice_recommendation",
    promptVersion: "voice-recommendation/v1",
    tier: "fast",
    system:
      "You summarise an AI screening call for a recruiter, from per-question rubric assessments only. Say what the evidence shows and what is missing, in two or three sentences, then recommend: advance to the next stage, a human screen, or hold. Never infer personality, emotion, accent, appearance, age, gender, health, religion, caste or family. Never state an outcome as decided — a person decides.",
    prompt: `Role: ${b.blueprint.title}. Stage: ${stage.name}, pass mark ${stage.passThreshold} on 0–100.\n${lines.join("\n")}`,
    schema: z.object({ action: z.string(), confidence: z.enum(["High", "Moderate", "Low"]), why: z.string() }),
    entity: { type: "session", id: sessionId, applicationId: b.app.id, blueprintId: b.blueprint.id },
    actorId: ctx.user.id,
    redactPrompt: true,
  });
  if (rec.ok) await db.insert(hireAiOutputs).values({ id: hid("hao"), kind: "voice_recommendation", applicationId: b.app.id, content: { sessionId, ...rec.output }, aiTaskId: rec.taskId, createdById: ctx.user.id });

  await audit(ctx, {
    applicationId: b.app.id,
    candidateId: b.candidate.id,
    entityType: "session",
    entityId: sessionId,
    eventType: "voice_screen_ended",
    summary: `AI voice screen ${p.endReason === "completed" ? "completed" : `ended (${(p.endReason ?? "stopped").replace(/_/g, " ")})`} · ${Math.round(p.durationMs / 60000)} min · recording consent ${p.consent ? "given" : "not given"} · ${scored} answer${scored === 1 ? "" : "s"} assessed by AI, ${manual} for a person to score`,
  });
  return ok({ sessionId, scored, manual }, "Saved. Every score waits for a person to confirm it.");
}

/* ----------------------------------------------------------------- review */

export type VoiceView = {
  sessionId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  consent: boolean;
  escalated: string | null;
  talkRatio: number | null;
  audioUrl: string | null;
  segments: HireSegment[];
  firstMs: Record<string, number>;
  recommendation: { action: string; confidence: string; why: string } | null;
  scoring: ScoringView | null;
};

export async function voiceView(ctx: HireContext, sessionId: string): Promise<VoiceView | null> {
  const [s] = await db.select().from(hireSessions).where(eq(hireSessions.id, sessionId)).limit(1);
  if (!s) return null;
  const scoring = await scoringView(ctx, s.executionId);
  if (!scoring) {
    /* An ai_screen the person cannot score is not one they may review either. */
    return null;
  }
  const [rec] = (await db
    .select({ content: hireAiOutputs.content })
    .from(hireAiOutputs)
    .where(and(eq(hireAiOutputs.applicationId, scoring.bundle.applicationId), eq(hireAiOutputs.kind, "voice_recommendation"), sql`${hireAiOutputs.content}->>'sessionId' = ${sessionId}`))
    .orderBy(desc(hireAiOutputs.createdAt))
    .limit(1)) as { content: { action: string; confidence: string; why: string } }[];
  const segs = (s.segments ?? []).slice().sort((a, b) => a.startMs - b.startMs);
  const firstMs: Record<string, number> = {};
  for (const g of segs) if (g.questionKey && firstMs[g.questionKey] == null) firstMs[g.questionKey] = g.startMs;
  const end = s.endedAt ? new Date(s.endedAt).getTime() : null;
  return {
    sessionId: s.id,
    status: s.status,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
    durationMs: end ? end - new Date(s.startedAt).getTime() : (segs[segs.length - 1]?.endMs ?? 0),
    consent: s.recordingConsent,
    escalated: s.escalated,
    talkRatio: s.candidateTalkRatio,
    audioUrl: s.audioFileId ? `/api/hire/audio/${s.audioFileId}` : null,
    segments: segs,
    firstMs,
    recommendation: rec?.content ?? null,
    scoring,
  };
}

/** Sessions on a stage execution, newest first — for the screen page's history. */
export async function sessionsFor(execId: string) {
  return db.select({ id: hireSessions.id, status: hireSessions.status, startedAt: hireSessions.startedAt, escalated: hireSessions.escalated, modality: hireSessions.modality }).from(hireSessions).where(eq(hireSessions.executionId, execId)).orderBy(desc(hireSessions.startedAt));
}

/** Who may hear a recording: anybody who can see the application it belongs to (interviewers: their own). */
export async function audioFor(ctx: HireContext, fileId: string): Promise<{ ref: string; contentType: string; size: number; applicationId: string; candidateId: string } | null> {
  const [f] = await db.select().from(hireFiles).where(eq(hireFiles.id, fileId)).limit(1);
  if (!f || f.purpose !== "audio" || f.removedAt || !f.applicationId) return null;
  const b = await getApplication(ctx, f.applicationId);
  if (!b) return null;
  return { ref: f.storedRef, contentType: f.contentType, size: f.sizeBytes, applicationId: f.applicationId, candidateId: f.candidateId };
}
