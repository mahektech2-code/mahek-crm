import { NextResponse } from "next/server";
import { authenticate } from "@/lib/services/mbos-service";
import { transcribeRequest } from "@/lib/dictation-requests";
import { sniffContentType } from "@/lib/file-types";

/* ---------------------------------------------------------------------------
 * A salesman speaking into a text box — PROTOCOL: not a queued record.
 *
 * This is deliberately NOT the outbox and deliberately NOT the media queue.
 * Both of those exist because a record must survive having no signal; this
 * one cannot, because its whole point is that the person READS what came back
 * before it goes anywhere near a form. A dictation that arrived tomorrow
 * would be a note nobody checked.
 *
 * So it is a plain request with a plain answer, and the handset draws no
 * microphone where there is nothing to answer it — the same rule the CRM's
 * own follows one screen further up.
 *
 * NOTHING IS STORED. No `attachments` row, no blob key, no id to fetch it back
 * by. The visit's voice note is a different thing and stays a different thing:
 * that one IS a record of what a customer said, kept until the office has
 * written it out. This is a keyboard.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
/* A minute of speech going up a 2G link, then two provider calls. */
export const maxDuration = 120;

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, code: auth.code, error: auth.error },
      { status: auth.status },
    );
  }

  /* The repository compiles the Expo app alongside this one, and React
   * Native's `FormData` — which has no `get` — wins the global. Named rather
   * than asserted, exactly as `api/mbos/media` does. */
  type MultipartForm = { get(name: string): unknown };
  const form = (await request.formData().catch(() => null)) as MultipartForm | null;
  if (!form) {
    return NextResponse.json(
      { ok: false, error: "That recording was not readable as a multipart form." },
      { status: 400 },
    );
  }

  const file = form.get("audio");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ ok: false, error: "No recording arrived." }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  /*
   * SNIFFED, not believed. The handset labels its own recordings `audio/m4a`,
   * which names no container Sarvam recognises — and the extension there is
   * the one place a media type is genuinely load bearing, since the service
   * refuses the part before it reads a byte. The bytes say `audio/mp4`, which
   * is the truth and is also what Sarvam can take. The house rule that a file
   * is validated on its bytes rather than its name pays for itself here for
   * the second reason rather than the first.
   */
  const actual = sniffContentType(bytes);
  if (!actual?.startsWith("audio/")) {
    return NextResponse.json(
      { ok: false, error: "That recording did not arrive as audio." },
      { status: 415 },
    );
  }

  const claimed = Number(form.get("seconds"));

  const answer = await transcribeRequest({
    audio: bytes,
    mediaType: actual,
    seconds: claimed,
  });

  return NextResponse.json(answer.body, { status: answer.status });
}
