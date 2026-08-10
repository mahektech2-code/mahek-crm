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

/**
 * Sarvam's flagship text model, used to WRITE where OpenAI cannot. Not
 * configuration: it is the fallback's only sensible choice, and a setting
 * nobody can test from a screen is a way for a deployment to be quietly
 * broken. `voice.languageModel` still names the OpenAI one, which is the one
 * worth tuning. It lives here rather than beside the calling code because the
 * Admin Console prints it, and that screen is a client component.
 */
export const SARVAM_LANGUAGE_MODEL = "sarvam-105b";

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
  // Sarvam is only reachable when it is the chosen provider. A key for a
  // provider nothing will ask is not a provider.
  const sarvam = provider === "sarvam" && hasSarvamKey;

  /*
   * OPENAI IS THE FLOOR. It serves when it is the choice, when it is the
   * fallback behind Sarvam, and — the case this clause exists for — whenever
   * there is no Sarvam key at all.
   *
   * The fallback switch is there to protect a DELIBERATE Sarvam-only
   * deployment: somewhere that has a Sarvam key and wants recordings kept
   * inside India, accepting the 30-second ceiling to get it. That is a real
   * choice and it still works. But with no Sarvam key there is no such
   * deployment to protect — the switch was then refusing OpenAI on behalf of
   * a provider that was never going to be asked, which left a configured
   * OpenAI account sitting unused behind a microphone nobody was shown.
   */
  const openai =
    hasOpenaiKey && (provider === "openai" || fallbackToOpenai || !hasSarvamKey);

  return {
    canHear: sarvam || openai,
    /* Tighten and Rewrite are a text call, and EITHER provider can make one:
     * Sarvam has a chat model too. Demanding OpenAI hid both buttons on a
     * deployment whose Sarvam key was working perfectly well, which is the
     * same mistake as the microphone one level up — a capability withheld
     * because of who was asked, not because of what could be done. They work
     * even where nothing is allowed to reach a provider for TRANSCRIPTION,
     * since text needs no audio. */
    canRefine: hasOpenaiKey || hasSarvamKey,
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
