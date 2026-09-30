import { NextResponse } from "next/server";
import { hrmsContext } from "@/lib/hrms/access";
import { createAttachment } from "@/lib/services/attachment-service";

/**
 * Upload one file for an HRMS form: stored unparented, its id goes back to
 * the form, and the record binds it when it saves — a save is never held up
 * by an upload, and an abandoned form's files are swept.
 */
export async function POST(request: Request) {
  const ctx = await hrmsContext();
  if (!ctx.level) return NextResponse.json({ error: "HRMS is not on your account." }, { status: 403 });
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
      : { accepted: ["image/jpeg", "image/png", "application/pdf", "audio/mpeg", "audio/mp4"] }),
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ id: res.data.id });
}
