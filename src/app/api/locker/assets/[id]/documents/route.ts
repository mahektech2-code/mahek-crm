import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { ACCEPTED_UPLOAD_TYPES } from "@/lib/file-types";
import { recordDocument } from "@/lib/actions/locker-assets";
import { canReadLockerAsset } from "@/lib/locker/register-service";
import { createAttachment } from "@/lib/services/attachment-service";

/* ---------------------------------------------------------------------------
 * A SCAN OF A LOCKER ASSET — a route handler rather than a server action,
 * because a licence PDF is routinely past the 1 MB an action body may carry.
 * The bytes are hashed (SHA-256) as they are stored; `?bind=0` stores the
 * file unparented, for the renewal completion form to bind to the NEW
 * version it creates.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in again — your session has ended." }, { status: 401 });
  const { id } = await params;
  if (!(await canReadLockerAsset(user.id, id))) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "The file did not arrive whole. Try choosing it again." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "No file arrived." }, { status: 400 });
  const created = await createAttachment({ filename: file.name || "document.pdf", bytes: new Uint8Array(await file.arrayBuffer()), declaredType: file.type, accepted: ACCEPTED_UPLOAD_TYPES, maxSizeMb: 20 });
  if (!created.ok) return NextResponse.json({ ok: false, error: created.error }, { status: 400 });
  if (new URL(request.url).searchParams.get("bind") === "0") return NextResponse.json({ ok: true, data: { id: created.data.id } });
  const bound = await recordDocument(id, created.data.id);
  if (!bound.ok) return NextResponse.json({ ok: false, error: bound.error }, { status: 400 });
  return NextResponse.json({ ok: true, data: { id: created.data.id }, message: bound.message });
}
