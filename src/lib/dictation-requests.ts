import "server-only";
import { getConfig } from "@/lib/config/store";
import { refineText, transcribeSpeech, voiceReadiness } from "@/lib/dictation";
import type { RefineMode } from "@/lib/dictation";

/* ---------------------------------------------------------------------------
 * Dictation as a REQUEST, with one copy of the sentences it answers in.
 *
 * There are two doors onto the same feature — the CRM's `/api/dictate/*`,
 * which a browser session opens, and MBOS's `/api/mbos/dictate/*`, which a
 * handset opens with a device token — and only the AUTHENTICATION differs.
 * Everything after it is identical: read the configuration, ask the same
 * provider through the same function, and turn the six ways it can fail into
 * a status and a sentence somebody can act on.
 *
 * Those sentences are the reason this file exists rather than the routes each
 * carrying their own. Three of the six say something specific and hard-won —
 * "record it in two shorter goes" is not "the service is down" and neither is
 * "tell your manager, this one will not fix itself" — and a second copy of
 * that ladder would drift within a release. The half that drifts is always
 * the half somebody reads at the worst moment.
 *
 * A route still checks its own caller. Nothing here knows who is asking, and
 * it must not: a helper that authenticated would be a helper somebody could
 * call from a route that forgot to.
 * ------------------------------------------------------------------------- */

export type DictationAvailability =
  | { available: false; reason: "disabled" | "not_configured" }
  | {
      available: true;
      /** The EFFECTIVE limit, which is not always the configured one. */
      maxSeconds: number;
      maxSizeMb: number;
      canRefine: boolean;
    };

/**
 * Whether a microphone may be drawn at all, and what it is allowed to do.
 *
 * Two different reasons not to offer it, and they are worth telling apart even
 * though nothing is drawn either way: "a manager turned it off" is somebody's
 * decision and "no credential" is a deploy that was never finished. Only one
 * of them should be chased.
 */
export async function dictationAvailability(): Promise<DictationAvailability> {
  const config = await getConfig();

  if (!config["voice.enabled"]) {
    return { available: false, reason: "disabled" };
  }

  const ready = await voiceReadiness({
    provider: config["voice.transcriptionProvider"],
    fallbackToOpenai: config["voice.fallbackToOpenai"],
    maxSeconds: config["voice.maxSeconds"],
  });

  /* No key the chosen provider can use, no microphone — rather than a button
   * that fails when pressed. */
  if (!ready.canHear) return { available: false, reason: "not_configured" };

  return {
    available: true,
    maxSeconds: ready.maxSeconds,
    maxSizeMb: config["voice.maxSizeMb"],
    /* Tighten and Rewrite are a text call and either provider can make one.
     * Told here so a screen can leave the buttons out rather than offer two
     * that fail. */
    canRefine: ready.canRefine,
  };
}

/** What a route should answer with: a status and a JSON body, nothing more. */
export type Answer = { status: number; body: Record<string, unknown> };

/* ------------------------------------------------------------- transcribe */

export type TranscribeRequest = {
  audio: Uint8Array;
  /** What the recording actually is, sniffed from the bytes by the caller. */
  mediaType: string;
  /**
   * How long the recorder ran. It decides whether Sarvam is even asked, since
   * its ceiling is a documented 30 seconds — a missing or silly value simply
   * reads as long, which routes to OpenAI, and that is the safe way for it to
   * be wrong.
   */
  seconds: number;
};

export async function transcribeRequest(input: TranscribeRequest): Promise<Answer> {
  const config = await getConfig();
  if (!config["voice.enabled"]) {
    return { status: 403, body: { ok: false, error: "Dictation is switched off." } };
  }

  if (input.audio.byteLength === 0) {
    return { status: 400, body: { ok: false, error: "No recording arrived." } };
  }

  const maxBytes = config["voice.maxSizeMb"] * 1024 * 1024;
  if (input.audio.byteLength > maxBytes) {
    return {
      status: 413,
      body: {
        ok: false,
        error: `That recording is longer than dictation accepts — ${config["voice.maxSizeMb"]}MB. Record it in two goes.`,
      },
    };
  }

  const outcome = await transcribeSpeech({
    audio: input.audio,
    mediaType: input.mediaType,
    seconds:
      Number.isFinite(input.seconds) && input.seconds > 0
        ? input.seconds
        : Number.MAX_SAFE_INTEGER,
    provider: config["voice.transcriptionProvider"],
    fallbackToOpenai: config["voice.fallbackToOpenai"],
    sarvamModel: config["voice.transcriptionModel"],
    openaiTranscriptionModel: config["voice.openaiTranscriptionModel"],
    languageModel: config["voice.languageModel"],
  });

  if (!outcome.ok) {
    const [status, error] = failureSentence(outcome.reason);
    return { status, body: { ok: false, reason: outcome.reason, error } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      english: outcome.english,
      spoken: outcome.spoken,
      language: outcome.language,
      servedBy: outcome.servedBy,
    },
  };
}

/**
 * The six refusals, in the words the person holding the phone needs.
 *
 * Each one aims somewhere different. `too_long` names the RECORDING rather
 * than the deployment, because dictation is set up and this one clip was the
 * problem. `provider_refused` is the only sentence here aimed past its reader:
 * the account has stopped answering and nobody on that screen can fix it, so
 * telling them to try again would waste a second minute of somebody's time in
 * front of a customer.
 */
function failureSentence(reason: string): [number, string] {
  switch (reason) {
    case "not_configured":
      return [503, "Dictation is not set up on this deployment yet."];
    case "too_long":
      return [
        503,
        "That recording was too long for the service that hears them — it takes 30 seconds at a time. Say it again in shorter goes.",
      ];
    case "provider_refused":
      return [
        503,
        "Dictation is unavailable — the account behind it has stopped accepting requests, which nobody on this screen can fix. Type the note this time, and tell your manager so it gets sorted.",
      ];
    case "no_speech":
      return [200, "Nothing was heard in that recording. Try again, closer to the microphone."];
    default:
      return [502, "The transcription service did not answer. Your recording is still here — try again."];
  }
}

/* ----------------------------------------------------------------- refine */

export async function refineRequest(input: {
  text: string;
  mode: RefineMode;
  instruction?: string;
}): Promise<Answer> {
  const config = await getConfig();
  if (!config["voice.enabled"]) {
    return { status: 403, body: { ok: false, error: "Dictation is switched off." } };
  }

  /* A rewrite with no instruction is a reword nobody asked for. */
  if (input.mode === "rewrite" && !input.instruction) {
    return { status: 400, body: { ok: false, error: "Say what to change." } };
  }

  const outcome = await refineText({
    text: input.text,
    mode: input.mode,
    instruction: input.instruction,
    languageModel: config["voice.languageModel"],
  });

  if (!outcome.ok) {
    return {
      status: outcome.reason === "not_configured" ? 503 : 502,
      body: {
        ok: false,
        error:
          outcome.reason === "not_configured"
            ? "Dictation is not set up on this deployment yet."
            : "That did not come back. Your text is unchanged.",
      },
    };
  }

  return { status: 200, body: { ok: true, text: outcome.text } };
}
