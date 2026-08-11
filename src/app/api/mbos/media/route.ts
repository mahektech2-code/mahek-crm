import { NextResponse } from "next/server";
import { authenticate } from "@/lib/services/mbos-service";
import { storeMbosMedia } from "@/lib/actions/mbos";

/* ---------------------------------------------------------------------------
 * One file — PROTOCOL.md §4.
 *
 * A SEPARATE queue from the records, deliberately: the parent syncs first with
 * its media pending, so 840 KB of shop photographs never delays a payment. The
 * server side of that is simply that this is its own endpoint with its own
 * idempotency, rather than an item type on `/sync`.
 *
 * Re-POSTing the same `clientId` is resumable and not a second copy. The bytes
 * go through the existing attachment subsystem — MBOS does not build its own
 * (brief §1.1) — and the type is sniffed from the bytes, because an extension
 * and a declared MIME both come from the same untrusted place.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

/** A photograph on a 2G upload is not a ten-second request. */
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
   * Native's `FormData` — which has no `get` — wins the global. This names the
   * two methods actually used rather than asserting the DOM type, so the cast
   * cannot quietly cover a real mistake about what a form entry is. */
  type MultipartForm = { get(name: string): unknown };
  const form = (await request
    .formData()
    .catch(() => null)) as MultipartForm | null;
  if (!form) {
    return NextResponse.json(
      { ok: false, error: "That upload was not readable as a multipart form." },
      { status: 400 },
    );
  }

  const clientId = String(form.get("clientId") ?? "");
  const kind = String(form.get("kind") ?? "");
  const entityId = form.get("entityId");
  const file = form.get("file");

  if (!clientId || !kind) {
    return NextResponse.json(
      {
        ok: false,
        error: "An upload needs its clientId and its kind — without them it cannot be deduped or filed.",
      },
      { status: 400 },
    );
  }
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "No file was attached to that upload." },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await storeMbosMedia(auth.principal, {
    clientId,
    kind,
    entityId: typeof entityId === "string" ? entityId : undefined,
    filename: file.name || `${kind}.bin`,
    bytes,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    attachmentId: result.attachmentId,
    // Said plainly, because "already had it" and "stored it" are different
    // facts about a queue the handset is trying to drain.
    deduped: result.deduped,
  });
}
