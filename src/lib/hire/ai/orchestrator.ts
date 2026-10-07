import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, type ModelMessage } from "ai";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { hireAiTasks } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { readSecret } from "@/lib/secrets";
import { findProhibited, redact } from "./guards";

/* ---------------------------------------------------------------------------
 * THE AI ORCHESTRATION LAYER (spec §4). Every model call in Hire passes
 * through `runTask`; no feature calls the provider directly.
 *
 * What it guarantees, in the order it does them:
 *   1. The switch and the key — off or keyless, the task is logged as
 *      `disabled` and the caller is told the manual path in words.
 *   2. Redaction — PII is stripped before transmission when asked.
 *   3. Caching — a deterministic task with the same input returns the
 *      earlier answer instead of paying for it twice.
 *   4. Schema enforcement — a strict structured output; a violation is
 *      retried ONCE, then escalated to the manual path.
 *   5. The caller's validation — for a score, that every evidence quote is
 *      really in the source text. A hallucinated quote fails here.
 *   6. Prohibited inference — personality, emotion, appearance, health,
 *      religion, caste or family in the output rejects it, and it is logged.
 *   7. The ledger — one `hire_ai_tasks` row per call: prompt version, model,
 *      tokens, latency, an estimated cost, and the full structured output.
 *
 * It never throws. A task that cannot run answers `ok: false` with a sentence
 * a screen can print, because the pipeline never stops for want of a model
 * (spec §4.3) — it runs slower and says so.
 * ------------------------------------------------------------------------- */

export type Tier = "reasoning" | "fast" | "vision";

export type TaskEntity = {
  type: string;
  id?: string | null;
  applicationId?: string | null;
  blueprintId?: string | null;
};

export type TaskInput<S extends z.ZodTypeAny> = {
  taskType: string;
  promptVersion: string;
  tier: Tier;
  system: string;
  /** Plain text prompt, or full messages (for files). */
  prompt?: string;
  messages?: ModelMessage[];
  schema: S;
  entity: TaskEntity;
  actorId?: string | null;
  /** Strip phone numbers, emails and identity numbers from `prompt` first. */
  redactPrompt?: boolean;
  /** Return an earlier successful answer for an identical input. */
  cacheable?: boolean;
  /** The caller's own check of the output; a message rejects it. */
  validate?: (out: z.infer<S>) => string | null;
  /** Seconds to wait. */
  timeoutSeconds?: number;
};

export type TaskResult<T> =
  | { ok: true; output: T; taskId: string; model: string; cached: boolean }
  | { ok: false; status: string; reason: string; taskId: string | null };

const MANUAL = "The AI step is unavailable, so this takes its manual path.";

/** Rough list prices, paise per million tokens (input, output). An ESTIMATE, labelled as one. */
const PRICE: Record<string, [number, number]> = {
  "gpt-5": [10500, 84000],
  "gpt-5-mini": [2100, 16800],
  "gpt-5-nano": [420, 3400],
  "gpt-4o": [21000, 84000],
  "gpt-4o-mini": [1260, 5040],
  "gpt-4.1": [16800, 67200],
  "gpt-4.1-mini": [3400, 13400],
};

export function estimateCostPaise(model: string, inTok: number, outTok: number): number {
  const p = PRICE[model] ?? PRICE["gpt-5-mini"];
  return Math.round((inTok * p[0] + outTok * p[1]) / 1_000_000);
}

export async function modelFor(tier: Tier): Promise<string> {
  const c = await getConfig();
  return tier === "reasoning" ? c["hire.ai.reasoningModel"] : tier === "vision" ? c["hire.ai.visionModel"] : c["hire.ai.fastModel"];
}

/** Whether AI can run at all right now, and if not, why — for a screen to say. */
export async function aiState(): Promise<{ on: true } | { on: false; reason: string }> {
  const c = await getConfig();
  if (!c["hire.ai.enabled"]) return { on: false, reason: "AI assistance is switched off in Admin Console → Settings → Hire. Every step runs by hand." };
  if (!(await readSecret("openai.apiKey"))) return { on: false, reason: "No OpenAI key is set (Admin Console → Integrations). Every step runs by hand." };
  return { on: true };
}

const hashOf = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

type Ledger = {
  taskType: string;
  promptVersion: string;
  tier: Tier;
  modelId: string | null;
  inputHash: string;
  status: string;
  output?: unknown;
  error?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  costPaise?: number | null;
  retryCount?: number;
  fallbackUsed?: string | null;
  entity: TaskEntity;
  actorId?: string | null;
  redacted: string[];
};

async function log(l: Ledger): Promise<string> {
  const id = `hai_${randomUUID()}`;
  try {
    await db.insert(hireAiTasks).values({
      id,
      taskType: l.taskType,
      promptVersion: l.promptVersion,
      tier: l.tier,
      modelId: l.modelId,
      inputHash: l.inputHash,
      status: l.status,
      output: (l.output ?? null) as never,
      error: l.error ?? null,
      inputTokens: l.inputTokens ?? null,
      outputTokens: l.outputTokens ?? null,
      latencyMs: l.latencyMs ?? null,
      costPaise: l.costPaise ?? null,
      retryCount: l.retryCount ?? 0,
      fallbackUsed: l.fallbackUsed ?? null,
      triggeredById: l.actorId ?? null,
      entityType: l.entity.type,
      entityId: l.entity.id ?? null,
      applicationId: l.entity.applicationId ?? null,
      blueprintId: l.entity.blueprintId ?? null,
      redactionApplied: l.redacted.length > 0,
      redactedFields: l.redacted,
    });
  } catch (e) {
    /* The ledger must never be why a task fails. */
    console.error("hire ai ledger:", e instanceof Error ? e.message : e);
  }
  return id;
}

export async function runTask<S extends z.ZodTypeAny>(input: TaskInput<S>): Promise<TaskResult<z.infer<S>>> {
  let prompt = input.prompt;
  let redacted: string[] = [];
  if (prompt && input.redactPrompt) {
    const r = redact(prompt);
    prompt = r.text;
    redacted = r.fields;
  }
  const inputHash = hashOf({ s: input.system, p: prompt, m: input.messages ? "files" : null, v: input.promptVersion });
  const base = { taskType: input.taskType, promptVersion: input.promptVersion, tier: input.tier, inputHash, entity: input.entity, actorId: input.actorId, redacted };

  const state = await aiState();
  const model = await modelFor(input.tier);
  if (!state.on) {
    const taskId = await log({ ...base, modelId: null, status: "disabled", error: state.reason, fallbackUsed: "manual" });
    return { ok: false, status: "disabled", reason: state.reason, taskId };
  }

  if (input.cacheable && !input.messages) {
    const [hit] = await db
      .select({ id: hireAiTasks.id, output: hireAiTasks.output, modelId: hireAiTasks.modelId })
      .from(hireAiTasks)
      .where(and(eq(hireAiTasks.taskType, input.taskType), eq(hireAiTasks.inputHash, inputHash), eq(hireAiTasks.status, "success"), gte(hireAiTasks.createdAt, sql`now() - interval '30 days'`)))
      .orderBy(desc(hireAiTasks.createdAt))
      .limit(1);
    if (hit?.output) {
      const parsed = input.schema.safeParse(hit.output);
      if (parsed.success) return { ok: true, output: parsed.data, taskId: hit.id, model: hit.modelId ?? model, cached: true };
    }
  }

  const key = (await readSecret("openai.apiKey")) as string;
  const client = createOpenAI({ apiKey: key });
  let lastError = "";
  let lastStatus = "error";
  let inTok = 0;
  let outTok = 0;
  const started = Date.now();
  let feedback = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const callArgs = {
        model: client(model),
        system: input.system,
        output: Output.object({ schema: input.schema }),
        maxRetries: 1,
        abortSignal: AbortSignal.timeout((input.timeoutSeconds ?? 90) * 1000),
        ...(input.tier === "vision" ? {} : { providerOptions: { openai: { reasoningEffort: input.tier === "reasoning" ? "medium" : "low" } } }),
      };
      const result = input.messages
        ? await generateText({ ...callArgs, messages: feedback ? [...input.messages, { role: "user", content: feedback }] : input.messages })
        : await generateText({ ...callArgs, prompt: feedback ? `${prompt}\n\n${feedback}` : (prompt ?? "") });
      inTok += result.usage?.inputTokens ?? 0;
      outTok += result.usage?.outputTokens ?? 0;
      const out = result.output as z.infer<S>;

      const banned = findProhibited(out);
      if (banned) {
        lastStatus = "prohibited";
        lastError = `The output made a prohibited inference (${banned}); it was discarded.`;
        feedback = `Your previous answer was rejected: it made an inference about ${banned}. Score only what the candidate said and did. Never infer personality, emotion, appearance, health, religion, caste or family circumstances.`;
        continue;
      }
      const invalid = input.validate?.(out) ?? null;
      if (invalid) {
        lastStatus = "evidence_invalid";
        lastError = invalid;
        feedback = `Your previous answer was rejected: ${invalid} Quote the candidate exactly, character for character, from the text given.`;
        continue;
      }
      const latencyMs = Date.now() - started;
      const taskId = await log({ ...base, modelId: model, status: "success", output: out, inputTokens: inTok, outputTokens: outTok, latencyMs, costPaise: estimateCostPaise(model, inTok, outTok), retryCount: attempt });
      return { ok: true, output: out, taskId, model, cached: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = msg;
      lastStatus = /timeout|aborted/i.test(msg) ? "timeout" : /schema|parse|NoObjectGenerated|No output/i.test(msg) ? "schema_violation" : /refus/i.test(msg) ? "refused" : "error";
      if (lastStatus !== "schema_violation") break;
    }
  }

  const latencyMs = Date.now() - started;
  const taskId = await log({ ...base, modelId: model, status: lastStatus, error: lastError.slice(0, 2000), inputTokens: inTok || null, outputTokens: outTok || null, latencyMs, costPaise: estimateCostPaise(model, inTok, outTok), retryCount: 1, fallbackUsed: "manual" });
  console.error(`hire ai ${input.taskType}: ${lastStatus}: ${lastError.slice(0, 300)}`);
  const reason =
    lastStatus === "evidence_invalid"
      ? "The AI’s quotes did not match what the candidate said, so its answer was discarded. Score this one yourself."
      : lastStatus === "prohibited"
        ? "The AI’s answer strayed into something Hire never scores, so it was discarded. Score this one yourself."
        : lastStatus === "timeout"
          ? "The AI took too long to answer. " + MANUAL
          : MANUAL;
  return { ok: false, status: lastStatus, reason, taskId };
}

/** This month's AI spend, for the budget alert. */
export async function monthSpendPaise(): Promise<number> {
  const [r] = (await db.execute(sql`
    select coalesce(sum(cost_paise), 0)::int as n from hire_ai_tasks
    where created_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
  `)) as unknown as { n: number | string }[];
  return Number(r?.n ?? 0);
}
