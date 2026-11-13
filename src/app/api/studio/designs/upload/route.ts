import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, studioDesigns } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { fileStorage } from "@/lib/storage";
import { isUniqueViolation } from "@/lib/studio/db-errors";
import { nameProblem } from "@/lib/studio/domain/template-upload";
import { MAX_UPLOAD_BYTES, newDesignId, normalizeUploadedImage, sniffImageFormat } from "@/lib/studio/designs-service";
import { studioCaller } from "@/lib/studio/http";

/* Uploading artwork for a new design, or new artwork for a new VERSION of a
   published one (`revisesId`). A route handler rather than a server action
   because the file is often more than the megabyte an action body is capped at
   — and a capped action fails without saying so. The image is checked on its
   bytes, redrawn at the canvas it fits, and stored; the draft is private to
   whoever uploaded it until it is published.

   THE ORIGINAL IS KEPT. The file as it arrived (JPG, PNG or WebP) goes to file
   storage beside the normalised background the renderer uses, and its
   reference is on the design, so what somebody uploaded is never lost to the
   redrawing. If it cannot be kept the upload fails — a design whose source is
   gone is a design that cannot be remade.

   THE ROW AND ITS AUDIT ENTRY ARE ONE TRANSACTION, and the files are removed
   only when the database has no row for this design. Whatever fails after the
   design row is committed can therefore never delete the files it points at. */

export const dynamic = "force-dynamic";

const EXT = { png: "png", jpeg: "jpg", webp: "webp" } as const;
const TYPE = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;

export async function POST(request: Request) {
  const caller = await studioCaller("studio.designs");
  if ("response" in caller) return caller.response;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "The file did not arrive whole. Try choosing it again." }, { status: 400 });
  }
  const revisesId = String(form.get("revisesId") ?? "").trim();
  let target: typeof studioDesigns.$inferSelect | null = null;
  if (revisesId) {
    const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, revisesId)).limit(1);
    const approver = await canOpenModule(caller.user.id, "studio.approve");
    if (!row || (row.createdById !== caller.user.id && !approver)) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
    if (row.status !== "approved") return NextResponse.json({ ok: false, error: "Only a published design can have a new version." }, { status: 400 });
    target = row;
  }
  const name = (target ? target.name : String(form.get("name") ?? "")).trim().replace(/\s+/g, " ");
  const np = nameProblem(name);
  if (np) return NextResponse.json({ ok: false, error: `The design name ${np}.` }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "Choose an image to upload." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ ok: false, error: `The file is too large (at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` }, { status: 400 });
  const bytes = Buffer.from(await file.arrayBuffer());
  const image = await normalizeUploadedImage(bytes);
  if (!image.ok) return NextResponse.json({ ok: false, error: image.error }, { status: 400 });
  const format = sniffImageFormat(bytes);
  if (!format) return NextResponse.json({ ok: false, error: "Only PNG, JPG or WebP images can be uploaded." }, { status: 400 });
  if (target && image.data.canvas !== target.canvas) {
    return NextResponse.json({ ok: false, error: "New artwork for a new version must have the same shape as the design it replaces. Upload a new design instead, or use artwork of the same proportions." }, { status: 400 });
  }

  const id = newDesignId(name);
  const keys: string[] = [];
  try {
    const source = await fileStorage.upload({ key: `studio/designs/${id}/source.${EXT[format]}`, body: bytes, contentType: TYPE[format] });
    keys.push(source.ref);
    const stored = await fileStorage.upload({ key: `studio/designs/${id}/background.png`, body: image.data.png, contentType: "image/png" });
    keys.push(stored.ref);
    await db.transaction(async (tx) => {
      await tx.insert(studioDesigns).values({
        id,
        name,
        canvas: image.data.canvas,
        placement: target ? target.placement : { name, canvas: image.data.canvas, occasion: "anytime", fields: [], messages: [] },
        backgroundRef: stored.ref,
        sourceSha256: image.data.sourceSha256,
        sourceRef: source.ref,
        sourceFormat: format,
        createdById: caller.user.id,
        revisesId: target ? target.id : null,
        revisesVersion: target ? target.version : null,
      });
      if (target) {
        await tx.insert(auditLog).values({ id: `aud_${id}`, actorId: caller.user.id, action: "studio.design.revision_started", entityType: "studio_design", entityId: target.id, afterState: { name, fromVersion: target.version, draft: id, newArtwork: true } as never });
      }
    });
  } catch (e) {
    /* The files go ONLY if the database has no row for this design. A commit that succeeded and then reported an error (a dropped
       connection) must never cost a saved design its artwork; the unreachable files of a failed upload are removed. */
    const [saved] = await db.select({ id: studioDesigns.id }).from(studioDesigns).where(eq(studioDesigns.id, id)).limit(1).catch(() => [undefined]);
    if (saved) return NextResponse.json({ ok: true, data: { id } });
    for (const ref of keys) await fileStorage.remove(ref).catch(() => undefined);
    if (isUniqueViolation(e)) return NextResponse.json({ ok: false, error: "You already have an open new version of this design. Open it from your uploads to continue." }, { status: 409 });
    console.error("[studio] upload failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "The upload could not be stored. Try again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, data: { id } });
}
