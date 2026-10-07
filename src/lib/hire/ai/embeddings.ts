import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";
import { db } from "@/db";
import { hireAiTasks } from "@/db/schema";
import { readSecret } from "@/lib/secrets";
import { redact } from "./guards";
import { aiState } from "./orchestrator";

/* ---------------------------------------------------------------------------
 * EMBEDDINGS for the talent pool's semantic search (spec §4.2, embedding
 * tier). Every call is a `hire_ai_tasks` row like any other model call — the
 * orchestrator's `runTask` is built for structured outputs, so this logs its
 * own ledger line in the same shape. Text is redacted before it leaves:
 * phone numbers, emails and identity numbers say nothing about whether
 * somebody can run a territory.
 * ------------------------------------------------------------------------- */

export const EMBEDDING_MODEL = "text-embedding-3-small";
/** List price, paise per million tokens — an estimate, labelled as one. */
const PAISE_PER_M = 170;

export const contentHash = (s: string) => createHash("sha256").update(`${EMBEDDING_MODEL}\n${s}`).digest("hex");

async function ledger(args: { status: string; tokens: number; latencyMs: number; count: number; error?: string; actorId: string | null }) {
  try {
    await db.insert(hireAiTasks).values({
      id: `hai_${randomUUID()}`,
      taskType: "embedding",
      promptVersion: "embedding/v1",
      tier: "embedding",
      modelId: EMBEDDING_MODEL,
      inputTokens: args.tokens || null,
      outputTokens: 0,
      latencyMs: args.latencyMs,
      costPaise: Math.round((args.tokens * PAISE_PER_M) / 1_000_000),
      status: args.status,
      error: args.error ?? null,
      fallbackUsed: args.status === "success" ? null : "keyword",
      triggeredById: args.actorId,
      entityType: "talent_search",
      output: { vectors: args.count } as never,
      redactionApplied: true,
      redactedFields: [],
    });
  } catch (e) {
    console.error("hire embedding ledger:", e instanceof Error ? e.message : e);
  }
}

export type EmbedResult = { ok: true; vectors: number[][] } | { ok: false; reason: string };

/** Embed texts; never throws. `ok: false` means: fall back to keywords and say so. */
export async function embedTexts(texts: string[], actorId: string | null): Promise<EmbedResult> {
  if (!texts.length) return { ok: true, vectors: [] };
  const state = await aiState();
  if (!state.on) return { ok: false, reason: state.reason };
  const key = await readSecret("openai.apiKey");
  if (!key) return { ok: false, reason: "No OpenAI key is set." };
  const model = createOpenAI({ apiKey: key }).embeddingModel(EMBEDDING_MODEL);
  const clean = texts.map((t) => redact(t).text.slice(0, 6000));
  const started = Date.now();
  try {
    if (clean.length === 1) {
      const r = await embed({ model, value: clean[0], maxRetries: 1, abortSignal: AbortSignal.timeout(30_000) });
      await ledger({ status: "success", tokens: r.usage?.tokens ?? 0, latencyMs: Date.now() - started, count: 1, actorId });
      return { ok: true, vectors: [r.embedding] };
    }
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < clean.length; i += 96) {
      const r = await embedMany({ model, values: clean.slice(i, i + 96), maxRetries: 1, abortSignal: AbortSignal.timeout(60_000) });
      vectors.push(...r.embeddings);
      tokens += r.usage?.tokens ?? 0;
    }
    await ledger({ status: "success", tokens, latencyMs: Date.now() - started, count: vectors.length, actorId });
    return { ok: true, vectors };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ledger({ status: /timeout|abort/i.test(msg) ? "timeout" : "error", tokens: 0, latencyMs: Date.now() - started, count: 0, error: msg.slice(0, 1000), actorId });
    console.error("hire embedding:", msg.slice(0, 300));
    return { ok: false, reason: "The embedding service did not answer." };
  }
}
