import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { writeLockerAudit } from "@/lib/locker/audit";
import { canReadLockerAsset } from "@/lib/locker/register-service";
import { fileStorage } from "@/lib/storage";

/* ---------------------------------------------------------------------------
 * OPENING A LOCKER DOCUMENT — with the tamper check (spec §10, "SHA-256 on
 * upload; any change to a stored file detected and flagged"). The bytes are
 * hashed again on every read; a mismatch is refused and written to the audit
 * as a security event rather than handing over a file that is not the one
 * that was filed. `?check=1` answers the check without the bytes.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; attId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in", { status: 401 });
  const { id, attId } = await params;
  if (!(await canReadLockerAsset(user.id, id))) return new NextResponse("Not found", { status: 404 });
  const [row] = await db.select().from(attachments).where(and(eq(attachments.id, attId), eq(attachments.parentType, "locker_asset")));
  /* The file must belong to this asset or one of its earlier versions, which the page passes as `id` only when it is the asset itself. */
  if (!row || row.status !== "available" || !row.parentId) return new NextResponse("Not found", { status: 404 });
  if (row.parentId !== id && !(await canReadLockerAsset(user.id, row.parentId))) return new NextResponse("Not found", { status: 404 });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fileStorage.read(row.storedRef));
  } catch {
    return new NextResponse("The document could not be read from storage.", { status: 502 });
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const intact = !row.contentHash || row.contentHash === hash;
  const check = new URL(request.url).searchParams.get("check") === "1";
  if (!intact) {
    await writeLockerAudit({
      actorId: user.id,
      actorName: user.name,
      action: "locker.asset.tamper_detected",
      entityType: "locker_asset",
      entityId: row.parentId,
      summary: `TAMPER CHECK FAILED on ${row.filename}: the stored bytes no longer match the hash recorded on upload`,
      security: true,
      detail: { attachmentId: row.id, recorded: row.contentHash, found: hash },
    }).catch(() => {});
  }
  if (check) return NextResponse.json({ intact, recorded: row.contentHash, found: hash });
  if (!intact) return new NextResponse("This file has changed since it was uploaded and is withheld. The change has been recorded for the Locker admin.", { status: 409 });
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": row.contentType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `inline; filename="${encodeURIComponent(row.filename)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
