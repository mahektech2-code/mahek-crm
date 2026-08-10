import "server-only";

/* ---------------------------------------------------------------------------
 * Sarvam's speech-to-text, the one place MahekOne talks to it.
 *
 * A plain `fetch` rather than an SDK, the same way `mailer.ts` calls Resend:
 * it is one multipart POST with one header, and a dependency would be more
 * code to keep current than the request it replaces.
 *
 * Why it is here at all: `saaras:v3` is built for Indian languages and for
 * code-mixed speech — Hindi with English words dropped in mid-sentence is its
 * design target rather than an edge case, which is exactly how a telecaller
 * in Bhiwandi actually talks. A general model handles that; this one is meant
 * for it.
 *
 * TWO CALLS, ON PURPOSE. `transcribe` returns what was said in the language it
 * was said in; `translate` returns English. Asking for both is what keeps the
 * modal's "show what was heard" panel honest — the English can be checked
 * against the sentence it came from, which is the only way anybody ever
 * catches a translation that went wrong. They run in parallel, so the person
 * waits for the slower of the two rather than the sum.
 *
 * THIRTY SECONDS. The synchronous endpoint refuses longer audio, which is why
 * `checkConsistency` will not let `voice.maxSeconds` exceed 30 while Sarvam is
 * the transcription provider — a recorder that let somebody speak for a
 * minute and then failed would waste the minute. Their Batch API takes an
 * hour of audio and is the wrong shape for this: upload, poll, come back
 * later is fine for a meeting recording and useless to somebody mid-call.
 * ------------------------------------------------------------------------- */

const ENDPOINT = "https://api.sarvam.ai/speech-to-text";

/** The sync endpoint's own ceiling. Mirrored in `checkConsistency`. */
export const SARVAM_MAX_SECONDS = 30;

export type SarvamMode = "transcribe" | "translate";

export type SarvamOutcome =
  | { ok: true; text: string; language: string | null }
  | { ok: false; detail: string };

/**
 * One call. `mode` decides whether the text comes back in the spoken language
 * or in English; everything else about the request is identical, which is what
 * makes asking for both cheap to express.
 */
export async function sarvamSpeechToText({
  apiKey,
  audio,
  mediaType,
  model,
  mode,
  signal,
}: {
  apiKey: string;
  audio: Uint8Array;
  /** What the browser recorded, used only to name the part sensibly. */
  mediaType: string;
  model: string;
  mode: SarvamMode;
  signal?: AbortSignal;
}): Promise<SarvamOutcome> {
  const form = new FormData();
  /*
   * The extension has to look like the container or the service rejects the
   * part before it reads a byte — this is the one place a media type IS load
   * bearing, unlike an uploaded file where the bytes are the authority.
   */
  const extension = mediaType.includes("mp4")
    ? "mp4"
    : mediaType.includes("ogg")
      ? "ogg"
      : mediaType.includes("wav")
        ? "wav"
        : "webm";
  form.append("file", new Blob([audio as BlobPart], { type: mediaType }), `speech.${extension}`);
  form.append("model", model);
  form.append("mode", mode);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "api-subscription-key": apiKey },
      body: form,
      signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => `HTTP ${res.status}`);
      return { ok: false, detail: `${res.status} ${detail}`.slice(0, 500) };
    }

    const json = (await res.json()) as {
      transcript?: string;
      language_code?: string | null;
    };
    return {
      ok: true,
      text: (json.transcript ?? "").trim(),
      language: json.language_code ?? null,
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
