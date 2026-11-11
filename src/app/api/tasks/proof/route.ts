import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { ACCEPTED_UPLOAD_TYPES } from "@/lib/file-types";
import { createAttachment } from "@/lib/services/attachment-service";

/* ---------------------------------------------------------------------------
 * ONE SCREENSHOT FOR CLOSING A TASK, stored unparented.
 *
 * A route handler and not a server action, for the reason every upload here is
 * one: Next caps an action's body at a megabyte, and a phone screenshot is
 * often more. The file is bound to the task only when `closeTask` accepts the
 * close — and only if THIS person uploaded it — so an abandoned close leaves an
 * orphan for the nightly sweep and nothing else.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in again — your session has ended." }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "The file did not arrive whole. Try choosing it again." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "No file arrived." }, { status: 400 });

  const created = await createAttachment({
    filename: file.name || "screenshot.png",
    bytes: new Uint8Array(await file.arrayBuffer()),
    declaredType: file.type,
    accepted: ACCEPTED_UPLOAD_TYPES,
  });
  if (!created.ok) return NextResponse.json({ ok: false, error: created.error }, { status: 400 });
  return NextResponse.json({ ok: true, data: { id: created.data.id, filename: file.name } });
}
