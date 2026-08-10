import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { transcribeSpeech } from "@/lib/dictation";

/* ---------------------------------------------------------------------------
 * Audio in, an English note out.
 *
 * This is a route handler rather than a server action because server actions
 * cap the request body at a megabyte by default, and two minutes of Opus is
 * comfortably past that. Raising that ceiling would raise it for every action
 * in the app to carry one feature's audio, which is the wrong trade.
 *
 * The bytes are read, sent to the model and dropped. Nothing is written to
 * `attachments`, nothing reaches blob storage, and there is no id to fetch it
 * back by, because there is nothing to fetch.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
/* Transcription plus the English pass; well inside this, but a cold model
 * behind the gateway can be slow and a truncated request loses the speech. */
export const maxDuration = 120;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  }

  const config = await getConfig();
  if (!config["voice.enabled"]) {
    return NextResponse.json(
      { ok: false, error: "Dictation is switched off." },
      { status: 403 },
    );
  }

  let audio: File | null = null;
  let claimedSeconds = Number.NaN;
  try {
    const form = await request.formData();
    const field = form.get("audio");
    if (field instanceof File) audio = field;
    claimedSeconds = Number(form.get("seconds"));
  } catch {
    audio = null;
  }
  if (!audio || audio.size === 0) {
    return NextResponse.json(
      { ok: false, error: "No recording arrived." },
      { status: 400 },
    );
  }

  const maxBytes = config["voice.maxSizeMb"] * 1024 * 1024;
  if (audio.size > maxBytes) {
    return NextResponse.json(
      {
        ok: false,
        error: `That recording is longer than dictation accepts — ${config["voice.maxSizeMb"]}MB. Record it in two goes.`,
      },
      { status: 413 },
    );
  }

  /*
   * The recorder counted this for the timer on screen. It decides whether
   * Sarvam is even asked, since its ceiling is a documented 30 seconds — a
   * missing or silly value simply reads as long, which routes to OpenAI, and
   * that is the safe way for it to be wrong.
   */
  const seconds =
    Number.isFinite(claimedSeconds) && claimedSeconds > 0
      ? claimedSeconds
      : Number.MAX_SAFE_INTEGER;

  const outcome = await transcribeSpeech({
    audio: new Uint8Array(await audio.arrayBuffer()),
    mediaType: audio.type || "audio/webm",
    seconds,
    provider: config["voice.transcriptionProvider"],
    fallbackToOpenai: config["voice.fallbackToOpenai"],
    sarvamModel: config["voice.transcriptionModel"],
    openaiTranscriptionModel: config["voice.openaiTranscriptionModel"],
    languageModel: config["voice.languageModel"],
  });

  if (!outcome.ok) {
    const [status, error] =
      outcome.reason === "not_configured"
        ? [503, "Dictation is not set up on this deployment yet."]
        : outcome.reason === "too_long"
          ? /*
             * Dictation IS set up — they were offered a microphone. What is
             * missing is the second provider this particular recording needed,
             * so the sentence names the recording rather than the deployment
             * and says what to do with the one in hand.
             */
            [
              503,
              "That recording was too long for the service that hears them — it takes 30 seconds at a time. Say it again in shorter goes.",
            ]
          : outcome.reason === "no_speech"
            ? [200, "Nothing was heard in that recording. Try again, closer to the microphone."]
            : [502, "The transcription service did not answer. Your recording is still here — try again."];
    return NextResponse.json({ ok: false, reason: outcome.reason, error }, { status });
  }

  return NextResponse.json({
    ok: true,
    english: outcome.english,
    spoken: outcome.spoken,
    language: outcome.language,
    servedBy: outcome.servedBy,
  });
}
