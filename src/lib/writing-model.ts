import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { readSecret } from "@/lib/secrets";
import { isPermanentRefusal, SARVAM_LANGUAGE_MODEL } from "@/lib/voice-readiness";
export { SARVAM_LANGUAGE_MODEL };

/* ---------------------------------------------------------------------------
 * The model that WRITES, as opposed to the one that hears.
 *
 * Dictation is two jobs and they were welded to one account. Hearing can be
 * done by Sarvam or by OpenAI; writing — turning what was heard into correct
 * English, and later tightening or rewriting it — could only be done by
 * OpenAI. So a deployment with a working Sarvam key and an OpenAI account out
 * of credit produced notes that were raw machine translation, with Tighten and
 * Rewrite hidden entirely, and nothing on any screen said why.
 *
 * Two providers, tried in order, and the ORDER IS DELIBERATE. OpenAI first,
 * because writing English prose is what it is best at and the note is read by
 * whoever picks up the account next. Sarvam second, because it can do the job
 * on the key that is already there — and a slightly plainer sentence is worth
 * a great deal more than no sentence.
 *
 * Sarvam's chat API is OpenAI-compatible enough for the SDK: same shape, and
 * it accepts `Authorization: Bearer`, which is what `createOpenAI` sends. Only
 * the base URL and the model name differ, so this is a provider swap rather
 * than a second integration.
 * ------------------------------------------------------------------------- */

const SARVAM_BASE_URL = "https://api.sarvam.ai/v1";

export type WritingProvider = "openai" | "sarvam";

export type WritingOutcome =
  | { ok: true; text: string; servedBy: WritingProvider }
  /** Neither provider has a key. Nothing was sent anywhere. */
  | { ok: false; reason: "not_configured" }
  /** Every provider that had a key failed or refused. */
  | { ok: false; reason: "failed"; detail: string };

/**
 * Ask the best available model to write something, falling through on refusal.
 *
 * A permanent refusal from OpenAI — no credit, revoked key — moves straight to
 * Sarvam rather than being reported, because the person is mid-call and does
 * not care whose billing failed. A transient failure falls through too: at
 * this point the audio is already transcribed and the alternative is handing
 * back an unwritten note.
 */
export async function write({
  system,
  prompt,
  openaiModel,
  timeoutMs = 60_000,
  providers = ["openai", "sarvam"],
}: {
  system: string;
  prompt: string;
  /** The OpenAI model to use where OpenAI serves. Configuration. */
  openaiModel: string;
  timeoutMs?: number;
  /**
   * Which accounts this call may use, in order. Defaults to both — OpenAI
   * first, Sarvam as the fallback that keeps dictation writing on a key that
   * is already there. A caller that has been told to use one account only
   * passes `["openai"]`, and a permanent refusal is then reported rather than
   * silently answered by the other provider.
   */
  providers?: WritingProvider[];
}): Promise<WritingOutcome> {
  const [openaiKey, sarvamKey] = await Promise.all([
    providers.includes("openai") ? readSecret("openai.apiKey") : null,
    providers.includes("sarvam") ? readSecret("sarvam.apiKey") : null,
  ]);

  const attempts: Array<{ provider: WritingProvider; key: string; model: string }> = [];
  if (openaiKey) attempts.push({ provider: "openai", key: openaiKey, model: openaiModel });
  if (sarvamKey) {
    attempts.push({
      provider: "sarvam",
      key: sarvamKey,
      model: SARVAM_LANGUAGE_MODEL,
    });
  }

  if (!attempts.length) return { ok: false, reason: "not_configured" };

  let lastDetail = "";
  for (const attempt of attempts) {
    const client = createOpenAI({
      apiKey: attempt.key,
      ...(attempt.provider === "sarvam" ? { baseURL: SARVAM_BASE_URL } : {}),
    });

    try {
      const result = await generateText({
        model: client(attempt.model),
        system,
        prompt,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      const text = result.text.trim();
      if (text) return { ok: true, text, servedBy: attempt.provider };
      lastDetail = `${attempt.provider} returned nothing.`;
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : String(e);
      console.error(
        `Dictation: writing via ${attempt.provider} failed${
          isPermanentRefusal(lastDetail) ? " (permanent refusal)" : ""
        }:`,
        lastDetail,
      );
    }
  }

  return { ok: false, reason: "failed", detail: lastDetail };
}

/** Whether anything at all can write. Drives whether Tighten and Rewrite show. */
export async function writingConfigured(): Promise<boolean> {
  const [openaiKey, sarvamKey] = await Promise.all([
    readSecret("openai.apiKey"),
    readSecret("sarvam.apiKey"),
  ]);
  return Boolean(openaiKey || sarvamKey);
}
