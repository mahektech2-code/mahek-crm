import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { transcribe } from "ai";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { hireAiTasks, hireFiles, hireStageExecutions, type HireSegment } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { readSecret } from "@/lib/secrets";
import { fileStorage } from "@/lib/storage";
import { hireContext } from "@/lib/hire/access";
import { aiState } from "@/lib/hire/ai/orchestrator";
import { getApplication, hid } from "@/lib/hire/services/core";
import { liveSession } from "@/lib/hire/services/interview";

/* ---------------------------------------------------------------------------
 * Live transcription for the interview workspace: one ~15-second chunk of
 * audio in, one transcript segment APPENDED to the session out.
 *
 * Only for a running interview the caller may conduct, and only where the
 * candidate consented to recording out loud — without consent the browser
 * never records, and this refuses anything sent anyway. The audio is kept
 * (hire_files, purpose `audio`) because consent was given for exactly that;
 * every call, success or not, is a row in the AI ledger.
 *
 * A route handler rather than a server action: audio is past the action body
 * limit, as it is for dictation.
 * ------------------------------------------------------------------------- */

export const runtime = "nodejs";

const say = (status: number, error: string) => Response.json({ ok: false, error }, { status });

export async function POST(req: Request) {
  const ctx = await hireContext();
  if (!ctx) return say(403, "Hire is not on your account.");
  if (!ctx.can("interview")) return say(403, "Interviewing is not part of your Hire role.");

  const form = await req.formData();
  const execId = String(form.get("execId") ?? "");
  const speaker = form.get("speaker") === "interviewer" ? "interviewer" : "candidate";
  const questionKey = String(form.get("questionKey") ?? "") || undefined;
  const startMs = Math.max(0, Number(form.get("startMs") ?? 0) || 0);
  const endMs = Math.max(startMs, Number(form.get("endMs") ?? startMs) || startMs);
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return say(400, "No audio arrived.");
  if (audio.size > 8 * 1024 * 1024) return say(413, "That chunk is too large.");

  const [exec] = await db.select().from(hireStageExecutions).where(eq(hireStageExecutions.id, execId)).limit(1);
  if (!exec) return say(404, "Not found.");
  const bundle = await getApplication(ctx, exec.applicationId);
  if (!bundle || (ctx.role === "interviewer" && exec.conductedById && exec.conductedById !== ctx.user.id)) return say(404, "Not found.");
  const session = await liveSession(execId);
  if (!session) return say(409, "The interview is not running.");
  if (!session.recordingConsent) return say(403, "The candidate did not consent to recording, so nothing is transcribed.");

  const state = await aiState();
  if (!state.on) return say(503, state.reason);
  const key = await readSecret("openai.apiKey");
  const model = (await getConfig())["hire.ai.transcriptionModel"];
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const mediaType = audio.type || "audio/webm";
  const started = Date.now();

  /* The recording is kept because the candidate agreed to it. */
  let fileId: string | null = null;
  try {
    const stored = await fileStorage.upload({ key: `hire/audio/${session.id}/${startMs}.webm`, body: bytes, contentType: mediaType });
    fileId = hid("hfi");
    await db.insert(hireFiles).values({
      id: fileId,
      candidateId: bundle.candidate.id,
      applicationId: bundle.app.id,
      purpose: "audio",
      filename: `interview-${startMs}.webm`,
      contentType: mediaType,
      sizeBytes: stored.sizeBytes,
      storedRef: stored.ref,
      uploadedById: ctx.user.id,
    });
  } catch (e) {
    console.error("hire transcribe: audio not stored:", e instanceof Error ? e.message : e);
  }

  const ledger = async (status: string, output: unknown, error: string | null) =>
    db.insert(hireAiTasks).values({
      id: hid("hai"),
      taskType: "transcription",
      promptVersion: "transcribe/v1",
      tier: "transcription",
      modelId: model,
      inputHash: createHash("sha256").update(bytes).digest("hex"),
      status,
      output: output as never,
      error,
      latencyMs: Date.now() - started,
      fallbackUsed: status === "success" ? null : "manual",
      triggeredById: ctx.user.id,
      entityType: "session",
      entityId: session.id,
      applicationId: bundle.app.id,
      blueprintId: bundle.blueprint.id,
    });

  let text: string;
  let language: string | undefined;
  try {
    const heard = await transcribe({
      model: createOpenAI({ apiKey: key! }).transcription(model),
      audio: bytes,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(60_000),
    });
    text = heard.text.trim();
    language = heard.language ?? undefined;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ledger(/timeout|abort/i.test(msg) ? "timeout" : "error", null, msg.slice(0, 2000));
    return say(502, "Transcription failed for that part. The interview carries on — type a note for it if it mattered.");
  }
  await ledger("success", { text, language, fileId }, null);
  if (!text) return Response.json({ ok: true, segment: null });

  const seg: HireSegment = { speaker, name: speaker === "interviewer" ? ctx.user.name : undefined, startMs, endMs, text, language, questionKey };
  await db.execute(sql`update hire_sessions set segments = segments || ${JSON.stringify([seg])}::jsonb,
    languages = case when ${language ?? ""} = '' or languages ? ${language ?? ""} then languages else languages || ${JSON.stringify([language ?? ""])}::jsonb end,
    audio_file_id = coalesce(audio_file_id, ${fileId}), updated_at = now() where id = ${session.id}`);
  return Response.json({ ok: true, segment: seg });
}
