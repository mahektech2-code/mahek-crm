import { NextResponse } from "next/server";
import { factoryContext } from "@/lib/factory/server";
import { createAttachment } from "@/lib/services/attachment-service";

/**
 * The loaded-truck photograph, uploaded the moment it is taken. It is bound to
 * the job when the job is saved (`lib/factory/post.ts`); one taken and never
 * sent is swept with every other unbound file after the orphan window.
 * A route rather than a server action: a phone photograph is past the 1 MB
 * action body limit.
 */
export async function POST(request: Request) {
  const fc = await factoryContext();
  if (!fc) return NextResponse.json({ error: "Please sign in again." }, { status: 403 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No photo was sent." }, { status: 400 });
  const res = await createAttachment({
    filename: file.name || "truck.jpg",
    bytes: new Uint8Array(await file.arrayBuffer()),
    declaredType: file.type,
    accepted: ["image/jpeg", "image/png", "image/webp"],
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ id: res.data.id });
}
