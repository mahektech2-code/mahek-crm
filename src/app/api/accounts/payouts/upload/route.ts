import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { createAttachment } from "@/lib/services/attachment-service";

/**
 * Upload one vendor invoice — a photograph or a PDF. A route handler rather
 * than a server action, because a server action's body stops at 1 MB and a
 * scanned tax invoice is routinely more. The file is stored unparented and its
 * id goes back to the form; the invoice row binds it when it saves, and only a
 * file this person uploaded.
 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (!(await canOpenModule(user.id, "accounts.payouts"))) {
    return NextResponse.json({ error: "Vendor payouts is not on your account." }, { status: 403 });
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file was sent." }, { status: 400 });
  const res = await createAttachment({
    filename: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
    declaredType: file.type,
    accepted: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ id: res.data.id });
}
