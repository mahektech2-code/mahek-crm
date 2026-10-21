import { after, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { readUpload, startUpload } from "@/lib/services/bank-statement-service";

/**
 * Upload a bank's statement PDF on Accounts → Bank statement management. A
 * route handler rather than a server action, because a statement PDF is past
 * the 1 MB a server action takes.
 *
 * The PDF is stored and the answer goes back at once; the AI reading runs
 * after it (`after`), so the screen can show its progress and the person can
 * close the window. The password, where the bank locked the PDF, is used for
 * that one reading and never stored.
 */
export const maxDuration = 300;

export async function POST(request: Request) {
  const user = await requireUser();
  if (!(await canOpenModule(user.id, "accounts.bank-statements"))) {
    return NextResponse.json({ error: "Bank statement management is not on your account." }, { status: 403 });
  }
  const form = await request.formData();
  const file = form.get("file");
  const accountId = String(form.get("accountId") ?? "");
  const password = String(form.get("password") ?? "").trim() || null;
  const note = String(form.get("note") ?? "").trim() || null;
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose the statement PDF." }, { status: 400 });
  const res = await startUpload({ accountId, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()), note });
  if (!res.ok) return NextResponse.json({ error: res.error, fieldErrors: res.fieldErrors ?? [] }, { status: res.code === "not_permitted" ? 403 : 400 });
  const uploadId = res.data.id;
  after(() => readUpload(uploadId, password));
  return NextResponse.json({ id: uploadId });
}
