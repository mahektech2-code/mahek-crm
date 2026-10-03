import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config/store";
import { sniffContentType } from "@/lib/file-types";
import { authenticate } from "@/lib/services/mbos-service";
import { scanLeadImages, type LeadScanImage } from "@/lib/services/lead-scan-service";

/* ---------------------------------------------------------------------------
 * Photographs of a visiting card or a shop board in, the New lead form's
 * details out — PROTOCOL: not a queued record.
 *
 * A plain request for the reason dictation and the visit assistant are: the
 * answer is only worth anything while he is still holding the card, and one
 * that arrived through the outbox tomorrow would fill a form already saved.
 * So it fails without signal and the handset says so; typing still works.
 *
 * NOTHING IS STORED — see `lead-scan-service.ts`.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
/* Three photographs going up a 2G link, then one vision call. */
export const maxDuration = 120;

/* A handset photograph is resized to 1600px and JPEG-compressed before it is
   sent, which lands well under a megabyte; this is the ceiling for one that
   somehow was not, not a size anybody should approach. */
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, code: auth.code, error: auth.error }, { status: auth.status });
  }

  /* React Native's `FormData` — which has no `getAll` — wins the global in a
     repository that compiles the Expo app too. Named, as `api/mbos/media` does. */
  type MultipartForm = { getAll(name: string): unknown[] };
  const form = (await request.formData().catch(() => null)) as MultipartForm | null;
  if (!form) {
    return NextResponse.json({ ok: false, error: "Those photos were not readable as a multipart form." }, { status: 400 });
  }

  const max = (await getConfig())["leadScan.maxImages"];
  const files = form.getAll("image").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return NextResponse.json({ ok: false, error: "No photo arrived." }, { status: 400 });
  }
  if (files.length > max) {
    return NextResponse.json({ ok: false, error: `Up to ${max} photos at a time.` }, { status: 400 });
  }

  const images: LeadScanImage[] = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: "One of those photos is too large to send." }, { status: 413 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    /* SNIFFED, not believed — a file is validated on its bytes, never its name. */
    const type = sniffContentType(bytes);
    if (type !== "image/jpeg" && type !== "image/png") {
      return NextResponse.json({ ok: false, error: "One of those files is not a photo." }, { status: 415 });
    }
    images.push({ bytes, mediaType: type });
  }

  const result = await scanLeadImages(images);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.code === "validation" ? 400 : 422 },
    );
  }
  return NextResponse.json({ ok: true, ...result.data });
}
