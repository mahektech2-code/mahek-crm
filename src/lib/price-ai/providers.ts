import "server-only";
import { randomUUID } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { priceAiRuns } from "@/db/schema";
import { readSecret } from "@/lib/secrets";
import { getConfig } from "@/lib/config/store";

/* ---------------------------------------------------------------------------
 * TWO MODELS, ASKED SEPARATELY, AND EVERY ANSWER KEPT.
 *
 * The Price Desk asks AI to read an instruction, review a change, give a
 * second opinion and weigh a special-price request. Money is the subject, so
 * two rules hold everywhere a model is asked:
 *
 * AI IS ADVICE. Nothing a model answers is written as a price, an approval or
 * a publish. Every figure is computed by code (`engines/price-instruction.ts`,
 * `engines/price-change.ts`) and every decision is a person's. A model's
 * findings are flags a person has to fix or answer; its numbers are never used.
 *
 * TWO MODELS ARE INDEPENDENT. OpenAI and Anthropic get the same evidence and
 * never see each other's answer. Their findings are kept apart, each tagged
 * with who raised it, and a disagreement is shown rather than averaged.
 *
 * A model that cannot answer — no key, switched off, a timeout, an answer that
 * does not fit the schema — is an ANSWER too: `{ ok: false, reason }`, said on
 * the screen, never an exception that takes the page down. Each run is a row
 * in `price_ai_runs`, so "what did the review say about this change in March"
 * is a query, not a memory.
 * ------------------------------------------------------------------------- */

export type Provider = "openai" | "anthropic";

export const PROVIDER_LABEL: Record<Provider, string> = { openai: "OpenAI", anthropic: "Claude" };

export type AiAnswer<T> =
  | { ok: true; provider: Provider; model: string; output: T; runId: string }
  | { ok: false; provider: Provider; reason: string; runId: string | null };

type Ask<S extends z.ZodTypeAny> = {
  feature: string;
  subject: { kind: string; id: string };
  system: string;
  prompt: string;
  schema: S;
  userId?: string | null;
  /** Seconds before giving up. A person is usually waiting. */
  timeoutSeconds?: number;
};

const gen = () => `pai_${randomUUID().slice(0, 12)}`;

async function record(input: {
  feature: string;
  subject: { kind: string; id: string };
  provider: Provider;
  model: string | null;
  ok: boolean;
  output?: unknown;
  error?: string;
  ms: number;
  userId?: string | null;
}): Promise<string | null> {
  try {
    const id = gen();
    await db.insert(priceAiRuns).values({
      id,
      subjectKind: input.subject.kind,
      subjectId: input.subject.id,
      feature: input.feature,
      provider: input.provider,
      model: input.model,
      ok: input.ok,
      output: (input.output ?? null) as never,
      error: input.error ?? null,
      ms: input.ms,
      createdById: input.userId ?? null,
    });
    return id;
  } catch (e) {
    // Losing the record of an answer must never lose the answer.
    console.error("price-ai: could not record a run:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Whether each model can be asked at all, without asking it. */
export async function aiReadiness(): Promise<{ enabled: boolean; openai: boolean; anthropic: boolean }> {
  const [config, openaiKey, anthropicKey] = await Promise.all([
    getConfig(),
    readSecret("openai.apiKey"),
    readSecret("anthropic.apiKey"),
  ]);
  const enabled = config["pricing.ai.enabled"];
  return { enabled, openai: enabled && !!openaiKey, anthropic: enabled && !!anthropicKey };
}

export async function askOpenAI<S extends z.ZodTypeAny>(args: Ask<S>): Promise<AiAnswer<z.infer<S>>> {
  const config = await getConfig();
  const model = config["pricing.ai.openaiModel"];
  const started = Date.now();
  if (!config["pricing.ai.enabled"]) return { ok: false, provider: "openai", reason: "AI is switched off for prices.", runId: null };
  const key = await readSecret("openai.apiKey");
  if (!key) return { ok: false, provider: "openai", reason: "No OpenAI key is set (Admin Console → Integrations).", runId: null };
  try {
    const client = createOpenAI({ apiKey: key });
    const result = await generateText({
      model: client(model),
      system: args.system,
      prompt: args.prompt,
      output: Output.object({ schema: args.schema }),
      providerOptions: { openai: { reasoningEffort: "low" } },
      maxRetries: 1,
      abortSignal: AbortSignal.timeout((args.timeoutSeconds ?? 60) * 1000),
    });
    const parsed = args.schema.safeParse(result.output);
    if (!parsed.success) throw new Error("The answer did not fit the expected shape.");
    const runId = await record({ ...args, provider: "openai", model, ok: true, output: parsed.data, ms: Date.now() - started, userId: args.userId });
    return { ok: true, provider: "openai", model, output: parsed.data, runId: runId ?? "" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const runId = await record({ ...args, provider: "openai", model, ok: false, error: reason, ms: Date.now() - started, userId: args.userId });
    return { ok: false, provider: "openai", reason: `OpenAI could not answer: ${reason}`, runId };
  }
}

/**
 * Anthropic's Messages API, asked through a forced tool call so the answer
 * arrives as JSON in the tool's input — then validated against the same zod
 * schema OpenAI's answer is. No SDK dependency: one POST.
 */
export async function askAnthropic<S extends z.ZodTypeAny>(args: Ask<S>): Promise<AiAnswer<z.infer<S>>> {
  const config = await getConfig();
  const model = config["pricing.ai.anthropicModel"];
  const started = Date.now();
  if (!config["pricing.ai.enabled"]) return { ok: false, provider: "anthropic", reason: "AI is switched off for prices.", runId: null };
  const key = await readSecret("anthropic.apiKey");
  if (!key) return { ok: false, provider: "anthropic", reason: "No Anthropic key is set (Admin Console → Integrations).", runId: null };
  try {
    const inputSchema = toToolSchema(args.schema);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: args.system,
        messages: [{ role: "user", content: args.prompt }],
        tools: [{ name: "answer", description: "Give the answer in this exact shape.", input_schema: inputSchema }],
        tool_choice: { type: "tool", name: "answer" },
      }),
      signal: AbortSignal.timeout((args.timeoutSeconds ?? 60) * 1000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const body = (await response.json()) as { content?: Array<{ type: string; name?: string; input?: unknown }> };
    const use = body.content?.find((c) => c.type === "tool_use" && c.name === "answer");
    if (!use) throw new Error("No answer came back.");
    const parsed = args.schema.safeParse(use.input);
    if (!parsed.success) throw new Error("The answer did not fit the expected shape.");
    const runId = await record({ ...args, provider: "anthropic", model, ok: true, output: parsed.data, ms: Date.now() - started, userId: args.userId });
    return { ok: true, provider: "anthropic", model, output: parsed.data, runId: runId ?? "" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const runId = await record({ ...args, provider: "anthropic", model, ok: false, error: reason, ms: Date.now() - started, userId: args.userId });
    return { ok: false, provider: "anthropic", reason: `Claude could not answer: ${reason}`, runId };
  }
}

/** Both, in parallel, independently. */
export async function askBoth<S extends z.ZodTypeAny>(args: Ask<S>): Promise<{ openai: AiAnswer<z.infer<S>>; anthropic: AiAnswer<z.infer<S>> }> {
  const [openai, anthropic] = await Promise.all([askOpenAI(args), askAnthropic(args)]);
  return { openai, anthropic };
}

/** The first that answers: OpenAI, then Anthropic. For reading a sentence, where one answer is enough. */
export async function askEither<S extends z.ZodTypeAny>(args: Ask<S>): Promise<AiAnswer<z.infer<S>>> {
  const first = await askOpenAI(args);
  if (first.ok) return first;
  const second = await askAnthropic(args);
  if (second.ok) return second;
  return { ok: false, provider: "openai", reason: [first.reason, second.reason].join(" "), runId: first.runId };
}

/** A zod schema as the JSON schema a tool's `input_schema` takes. */
function toToolSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== "object") return { type: "object", properties: { value: json }, required: ["value"] };
  return json;
}
