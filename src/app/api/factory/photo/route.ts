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
  const build = request.headers.get("x-factory-client") ?? "unknown build";
  const fc = await factoryContext();
  if (!fc) {
    console.warn("[factory] photo refused: not signed in", JSON.stringify({ build }));
    return NextResponse.json({ error: "Please sign in again." }, { status: 403 });
  }
  /* A body that is not a form — cut off mid-upload, or sent wrong — is
     answered with a reason, never a crash the phone would read as no network. */
  let form: FormData;
  try {
    form = await request.formData();
  } catch (e) {
    console.warn("[factory] photo refused: unreadable upload", JSON.stringify({ who: fc.user.id, build, why: e instanceof Error ? e.message : String(e) }));
    return NextResponse.json({ error: "The photo did not arrive whole. Send it again." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    console.warn("[factory] photo refused: no file", JSON.stringify({ who: fc.user.id, build }));
    return NextResponse.json({ error: "No photo was sent." }, { status: 400 });
  }
  const res = await createAttachment({
    filename: file.name || "truck.jpg",
    bytes: new Uint8Array(await file.arrayBuffer()),
    declaredType: file.type,
    accepted: ["image/jpeg", "image/png", "image/webp"],
  });
  if (!res.ok) {
    console.warn("[factory] photo refused", JSON.stringify({ who: fc.user.id, build, name: file.name, type: file.type, bytes: file.size, why: res.error }));
    return NextResponse.json({ error: res.error }, { status: 400 });
  }
  return NextResponse.json({ id: res.data.id });
}
