import { eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { publicDocument } from "@/lib/erp/order-tracking";
import { fileStorage } from "@/lib/storage";

/**
 * A DOCUMENT THROUGH THE CUSTOMER'S TRACKING LINK — the invoice PDF or the LR
 * copy. No sign-in: the token decides, and it opens only this order's file,
 * only once it is available, and never the invoice on a delivery party's view.
 * Anything else answers the same 404, so the link cannot be used to ask what exists.
 */
export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response("This document is not available.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" } });

export async function GET(_req: Request, { params }: { params: Promise<{ token: string; kind: string }> }) {
  const { token, kind } = await params;
  const doc = await publicDocument(token, kind);
  if (!doc) return NOT_FOUND();
  const [row] = await db.select().from(attachments).where(eq(attachments.id, doc.id));
  if (!row || row.status !== "available") return NOT_FOUND();
  try {
    const bytes = await fileStorage.read(row.storedRef);
    return new Response(bytes, {
      headers: {
        "content-type": row.contentType,
        "content-length": String(row.sizeBytes),
        "content-disposition": `inline; filename="${encodeURIComponent(row.filename)}"`,
        "cache-control": "private, no-store",
        "x-robots-tag": "noindex",
      },
    });
  } catch {
    return new Response("The document could not be read.", { status: 502 });
  }
}
