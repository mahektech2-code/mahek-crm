import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import type { z } from "zod";
import { readSecret } from "@/lib/secrets";
import { SARVAM_LANGUAGE_MODEL } from "@/lib/voice-readiness";

/* ---------------------------------------------------------------------------
 * WORDS IN, A SCHEMA OUT — OpenAI first, Sarvam if OpenAI cannot answer, and
 * no model at all is an answer too.
 *
 * The call assistant and the visit assistant read different conversations
 * into different shapes and ask the models in exactly the same way. A second
 * copy of this ladder would be right the day it was written and wrong the day
 * somebody changed the retry, the timeout or the Sarvam fallback in one of the
 * two — and the one that drifted would be the one nobody was looking at.
 * ------------------------------------------------------------------------- */

export async function readStructured<S extends z.ZodTypeAny>(args: {
  /** For the logs: whose read failed. */
  label: string;
  system: string;
  prompt: string;
  schema: S;
  /** The keys, in words, for a model that cannot be handed a schema. */
  shapeHint: string;
  /** The OpenAI model id, from configuration. */
  model: string;
}): Promise<{ output: z.infer<S> | null; model: string | null }> {
  const [openaiKey, sarvamKey] = await Promise.all([
    readSecret("openai.apiKey"),
    readSecret("sarvam.apiKey"),
  ]);

  if (openaiKey) {
    try {
      const client = createOpenAI({ apiKey: openaiKey });
      const result = await generateText({
        model: client(args.model),
        system: args.system,
        prompt: args.prompt,
        output: Output.object({ schema: args.schema }),
        providerOptions: { openai: { reasoningEffort: "low" } },
        /* One retry, not the SDK's two: somebody is waiting, and a refusal
           like an empty credit balance will not change on a retry. */
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(45_000),
      });
      return {
        output: result.output as z.infer<S>,
        model: `openai:${args.model}`,
      };
    } catch (e) {
      console.error(
        `${args.label}: OpenAI read failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  /*
   * Sarvam's chat endpoint is OpenAI-shaped but does not promise structured
   * output, so it is asked for JSON in words and the answer is validated
   * against the same schema. An answer that does not validate is no answer —
   * a half-read conversation filled into a form is worse than asking.
   */
  if (sarvamKey) {
    try {
      const client = createOpenAI({
        apiKey: sarvamKey,
        baseURL: "https://api.sarvam.ai/v1",
      });
      const result = await generateText({
        model: client.chat(SARVAM_LANGUAGE_MODEL),
        system: `${args.system}\n\nAnswer with ONE JSON object and nothing else. Every key of the shape below must be present; use null where nothing was said.\n${args.shapeHint}`,
        prompt: args.prompt,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(45_000),
      });
      const json = extractJson(result.text);
      const parsed = json ? args.schema.safeParse(json) : null;
      if (parsed?.success) {
        return {
          output: parsed.data as z.infer<S>,
          model: `sarvam:${SARVAM_LANGUAGE_MODEL}`,
        };
      }
      console.error(`${args.label}: Sarvam's answer did not fit the schema.`);
    } catch (e) {
      console.error(
        `${args.label}: Sarvam read failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return { output: null, model: null };
}

/** Whether either model is configured at all — a read is worth asking for. */
export async function structuredReadAvailable(): Promise<boolean> {
  const [openaiKey, sarvamKey] = await Promise.all([
    readSecret("openai.apiKey"),
    readSecret("sarvam.apiKey"),
  ]);
  return Boolean(openaiKey || sarvamKey);
}

export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
