import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments, mbosDocuments } from "@/db/schema";
import { authenticate, customerIdsInScope } from "@/lib/services/mbos-service";
import { fileStorage } from "@/lib/storage";

/* ---------------------------------------------------------------------------
 * ONE PUBLISHED DOCUMENT'S FILE, for the handset that was sent its row.
 *
 * No document in the library could ever be opened on a phone. The pull sends
 * each row with its attachment id, and the only way to read an attachment's
 * bytes was `/api/attachments/[id]`, which takes a browser session — a device
 * token cannot pass it. So every row said "Not downloaded" and every tap said
 * to ask the office for something the office had already published.
 *
 * The question asked here is the one the pull already answered when it sent
 * the row: active, published to this person's level and — where it is tagged
 * to named people — to him (an empty list is everybody in both cases), and —
 * where it names a shop — a shop in this person's book.
 * Asked again rather than trusted, because a URL is not a permission. A
 * document he may not see answers exactly like one that does not exist.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, code: auth.code, error: auth.error },
      { status: auth.status },
    );
  }
  const { principal } = auth;
  const { id } = await params;
  const notFound = () =>
    NextResponse.json({ ok: false, error: "That document is not available to you." }, { status: 404 });

  const [doc] = await db
    .select({
      active: mbosDocuments.active,
      attachmentId: mbosDocuments.attachmentId,
      customerId: mbosDocuments.customerId,
      visibleToRoles: mbosDocuments.visibleToRoles,
      visibleToUserIds: mbosDocuments.visibleToUserIds,
    })
    .from(mbosDocuments)
    .where(eq(mbosDocuments.id, id));
  if (!doc?.active || !doc.attachmentId) return notFound();
  if (doc.visibleToRoles.length && !doc.visibleToRoles.includes(principal.role)) return notFound();
  if (doc.visibleToUserIds.length && !doc.visibleToUserIds.includes(principal.user.id)) return notFound();
  if (doc.customerId) {
    const book = await customerIdsInScope(principal);
    if (!book.includes(doc.customerId)) return notFound();
  }

  const [row] = await db.select().from(attachments).where(eq(attachments.id, doc.attachmentId));
  if (!row) return notFound();
  if (row.status === "removed") {
    return NextResponse.json({ ok: false, error: "The office has taken this file down." }, { status: 410 });
  }

  try {
    const bytes = await fileStorage.read(row.storedRef);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": row.contentType,
        "Content-Length": String(row.sizeBytes),
        "Content-Disposition": `attachment; filename="${encodeURIComponent(row.filename)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "The file could not be read just now. Try again." }, { status: 502 });
  }
}
