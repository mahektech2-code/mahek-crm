import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { transcribeRequest } from "@/lib/dictation-requests";

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
 *
 * Everything past the sign-in check lives in `lib/dictation-requests.ts`,
 * which MBOS's own door reads too — the six refusals are worth saying well
 * once rather than twice.
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

  const answer = await transcribeRequest({
    audio: new Uint8Array(await audio.arrayBuffer()),
    /*
     * The browser's own word for what it recorded. Unlike an uploaded file,
     * whose bytes are the authority, this one came from the MediaRecorder
     * three lines of JavaScript ago rather than from a person — and Sarvam
     * needs the container named to read the part at all.
     */
    mediaType: audio.type || "audio/webm",
    seconds: claimedSeconds,
  });

  return NextResponse.json(answer.body, { status: answer.status });
}
