import { getCurrentUser } from "@/lib/auth";
import { transcribeRequest } from "@/lib/dictation-requests";

/* ---------------------------------------------------------------------------
 * One piece of a dictation: audio in, the words and then the English out.
 *
 * A dictation is no longer one recording sent when it ends. The browser cuts
 * it at the person's own pauses while they are still talking, and each piece
 * comes here the moment it is cut — so a telecaller can speak for as long as
 * the call needs, and by the time they press stop nearly all of it has
 * already been heard and written. The wait after stop is ONE short piece,
 * however long they talked. It is also why no provider's ceiling reaches the
 * person any more: every piece sits comfortably under Sarvam's 30 seconds.
 *
 * The answer is newline-delimited JSON, two events:
 *
 *   `heard`   — the words, in the language they were said in, and the
 *               provider's rough English where it gave one. Sent BEFORE the
 *               written pass, because the call assistant starts reading the
 *               call from these rather than waiting for the polish;
 *   `written` — the English note for this piece.
 *
 * or one `error`. The audio is read, sent and dropped, exactly as before.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ ok: false, error: "Not signed in." }, { status: 401 });
  }

  let audio: File | null = null;
  let claimedSeconds = Number.NaN;
  let piece = false;
  try {
    const form = await request.formData();
    const field = form.get("audio");
    if (field instanceof File) audio = field;
    claimedSeconds = Number(form.get("seconds"));
    piece = form.get("piece") === "1";
  } catch {
    audio = null;
  }
  if (!audio || audio.size === 0) {
    return Response.json({ ok: false, error: "No recording arrived." }, { status: 400 });
  }

  const bytes = new Uint8Array(await audio.arrayBuffer());
  const mediaType = audio.type || "audio/webm";

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      try {
        let heard = false;
        const answer = await transcribeRequest({
          audio: bytes,
          mediaType,
          seconds: claimedSeconds,
          piece,
          onHeard: (h) => {
            heard = true;
            send({ type: "heard", spoken: h.spoken, draft: h.draft, language: h.language });
          },
        });
        const body = answer.body as Record<string, unknown>;
        if (answer.status !== 200 || !body.ok) {
          send({ type: "error", status: answer.status, ...body });
          return;
        }
        if (!heard)
          send({ type: "heard", spoken: body.spoken, draft: body.english, language: body.language });
        send({
          type: "written",
          english: body.english,
          spoken: body.spoken,
          language: body.language,
          servedBy: body.servedBy,
        });
      } catch (e) {
        console.error("Dictation piece failed:", e instanceof Error ? e.message : e);
        send({ type: "error", status: 502, ok: false, error: "The transcription service did not answer." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      /* nginx on the droplet buffers proxied responses by default, which
         would hold `heard` back until `written` — the overlap this exists for. */
      "X-Accel-Buffering": "no",
    },
  });
}
