import { NextResponse } from "next/server";
import { erpContext, previewRefusal } from "@/lib/erp/access";
import { createAttachment } from "@/lib/services/attachment-service";

/**
 * Upload one file for an ERP form. The file is stored unparented and its id
 * goes back to the form; the record binds it when it saves (the house rule —
 * a save is never held up by an upload, and an abandoned form's files are
 * swept). Videos are accepted here, by their bytes, and nowhere else.
 */
export async function POST(request: Request) {
  const ctx = await erpContext();
  if (!ctx.level) return NextResponse.json({ error: "The ERP is not on your account." }, { status: 403 });
  if (ctx.viewingAs) return NextResponse.json({ error: previewRefusal(ctx.viewingAs) }, { status: 403 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file was sent." }, { status: 400 });
  const video = form.get("kind") === "video";
  const res = await createAttachment({
    filename: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
    declaredType: file.type,
    ...(video
      ? { accepted: ["video/mp4", "video/webm"], asVideo: true }
      : { accepted: ["image/jpeg", "image/png", "application/pdf"] }),
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ id: res.data.id });
}
