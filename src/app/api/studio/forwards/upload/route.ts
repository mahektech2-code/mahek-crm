import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLog, studioForwards } from "@/db/schema";
import { fileStorage } from "@/lib/storage";
import { titleProblem } from "@/lib/studio/domain/forward";
import { checkFinishedPoster } from "@/lib/studio/forward-image";
import { studioCaller } from "@/lib/studio/http";

/* Uploading a finished poster to forward. A route rather than a server action
   because a poster is often more than an action's one-megabyte body. The row
   and its audit entry are one transaction; the file goes only if there is no row. */

export const dynamic = "force-dynamic";
const EXT = { png: "png", jpeg: "jpg", webp: "webp" } as const;
const TYPE = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;

export async function POST(request: Request) {
  const caller = await studioCaller("studio.forward");
  if ("response" in caller) return caller.response;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "The file did not arrive whole. Try choosing it again." }, { status: 400 });
  }
  const title = String(form.get("title") ?? "").trim().replace(/\s+/g, " ");
  const tp = titleProblem(title);
  if (tp) return NextResponse.json({ ok: false, error: `The poster ${tp}.` }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "Choose an image to upload." }, { status: 400 });
  const checked = await checkFinishedPoster(Buffer.from(await file.arrayBuffer()));
  if (!checked.ok) return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });
  const p = checked.data;
  const id = `fwd_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  let ref: string | null = null;
  try {
    const stored = await fileStorage.upload({ key: `studio/forwards/${id}/poster.${EXT[p.format]}`, body: p.bytes, contentType: TYPE[p.format] });
    ref = stored.ref;
    await db.transaction(async (tx) => {
      await tx.insert(studioForwards).values({ id, createdById: caller.user.id, title, sourceRef: stored.ref, format: p.format, sha256: p.sha256, width: p.width, height: p.height });
      await tx.insert(auditLog).values({ id: `aud_${id}`, actorId: caller.user.id, action: "studio.forward.created", entityType: "studio_forward", entityId: id, afterState: { title, format: p.format, width: p.width, height: p.height } as never });
    });
  } catch (e) {
    if (ref) await fileStorage.remove(ref).catch(() => undefined);
    console.error("[studio] forward upload failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "The upload could not be stored. Try again." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, data: { id } });
}
