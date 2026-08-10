/* ---------------------------------------------------------------------------
 * What dictation can do, given which keys exist — PURE, and in its own file
 * for the usual reason: `dictation.ts` reaches the database through
 * `secrets.ts`, so a test importing it needs a DATABASE_URL to ask a question
 * that is entirely arithmetic.
 *
 * The question is not "is there a key" but "can the CHOSEN provider be
 * reached, and how long may a recording be before nothing can take it". Those
 * are different, and answering the first one drew a microphone that could not
 * produce a note in three separate configurations.
 * ------------------------------------------------------------------------- */

export type TranscriptionProvider = "sarvam" | "openai";

/**
 * Sarvam's synchronous speech-to-text refuses audio over this. Documented by
 * them, not discovered by us, and the reason long recordings are routed to
 * OpenAI instead of being capped for everybody.
 */
export const SARVAM_MAX_SECONDS = 30;

export type VoiceReadiness = {
  canHear: boolean;
  canRefine: boolean;
  /** The EFFECTIVE recording limit, which is not always the configured one. */
  maxSeconds: number;
};

export function resolveReadiness({
  provider,
  fallbackToOpenai,
  maxSeconds,
  hasSarvamKey,
  hasOpenaiKey,
}: {
  provider: TranscriptionProvider;
  fallbackToOpenai: boolean;
  maxSeconds: number;
  hasSarvamKey: boolean;
  hasOpenaiKey: boolean;
}): VoiceReadiness {
  // Sarvam is only reachable when it is the chosen provider; OpenAI serves
  // either as the choice or as the fallback behind Sarvam. A key for a
  // provider nothing will ask is not a provider.
  const sarvam = provider === "sarvam" && hasSarvamKey;
  const openai = hasOpenaiKey && (provider === "openai" || fallbackToOpenai);

  return {
    canHear: sarvam || openai,
    /* Tighten and Rewrite are a text call: they need OpenAI whoever did the
     * hearing, and they work even where nothing is allowed to reach it for
     * transcription. */
    canRefine: hasOpenaiKey,
    /* Where OpenAI cannot catch the long ones, the recorder stops at Sarvam's
     * own ceiling. A limit that lets somebody talk for two minutes into a
     * provider documented to refuse them is a promise the deployment cannot
     * keep, and it is broken at the worst moment — after they have spoken. */
    maxSeconds: openai ? maxSeconds : Math.min(maxSeconds, SARVAM_MAX_SECONDS),
  };
}

/**
 * A refusal no retry will change, told apart from a service that stumbled.
 *
 * An exhausted credit balance, a revoked key and a project with no budget all
 * arrive looking like an ordinary failure, and the sentence for an ordinary
 * failure is "try again" — which a telecaller then does, twice, mid-call,
 * because we asked them to. None of the three will succeed on the second press.
 *
 * Matched on the provider's own words rather than on a status code: 429 is
 * also honest rate limiting, which IS worth retrying, and the two say very
 * different things in the body. The strings are the ones OpenAI and Sarvam
 * actually return — `credit_balance_exhausted` was copied from a live reply,
 * not guessed at.
 */
export function isPermanentRefusal(detail: string): boolean {
  const said = detail.toLowerCase();
  return (
    said.includes("insufficient_quota") ||
    said.includes("credit_balance_exhausted") ||
    said.includes("no credits remaining") ||
    said.includes("exceeded your current quota") ||
    said.includes("invalid_api_key") ||
    said.includes("incorrect api key") ||
    said.includes("account is not active") ||
    said.includes("invalid api key") ||
    said.includes("unauthorized")
  );
}
