import { NextResponse } from "next/server";
import { db } from "@/db";
import { studioDesigns } from "@/db/schema";
import { fileStorage } from "@/lib/storage";
import { nameProblem } from "@/lib/studio/domain/template-upload";
import { MAX_UPLOAD_BYTES, newDesignId, normalizeUploadedImage } from "@/lib/studio/designs-service";
import { studioCaller } from "@/lib/studio/http";

/* Uploading artwork for a new design. A route handler rather than a server
   action because the file is often more than the megabyte an action body is
   capped at — and a capped action fails without saying so. The image is
   checked on its bytes, redrawn at the canvas it fits, and stored; the draft
   is private to whoever uploaded it until somebody approves it. */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const caller = await studioCaller("studio.designs");
  if ("response" in caller) return caller.response;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "The file did not arrive whole. Try choosing it again." }, { status: 400 });
  }
  const name = String(form.get("name") ?? "").trim().replace(/\s+/g, " ");
  const np = nameProblem(name);
  if (np) return NextResponse.json({ ok: false, error: `The design name ${np}.` }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "Choose an image to upload." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ ok: false, error: `The file is too large (at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` }, { status: 400 });
  const image = await normalizeUploadedImage(Buffer.from(await file.arrayBuffer()));
  if (!image.ok) return NextResponse.json({ ok: false, error: image.error }, { status: 400 });

  const id = newDesignId(name);
  const stored = await fileStorage.upload({ key: `studio/designs/${id}/background.png`, body: image.data.png, contentType: "image/png" });
  await db.insert(studioDesigns).values({
    id,
    name,
    canvas: image.data.canvas,
    placement: { name, canvas: image.data.canvas, occasion: "anytime", fields: [], messages: [] },
    backgroundRef: stored.ref,
    sourceSha256: image.data.sourceSha256,
    createdById: caller.user.id,
  });
  return NextResponse.json({ ok: true, data: { id } });
}
