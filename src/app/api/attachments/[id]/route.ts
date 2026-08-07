import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { canRead } from "@/lib/services/attachment-service";
import { fileStorage } from "@/lib/storage";

/**
 * §4.2 — the only way to read an attachment's bytes.
 *
 * Files are never served from a guessable URL: a payment proof or a
 * damaged-goods photograph is commercially sensitive. Every read checks the
 * caller can see the PARENT record, so access follows the customer's scope
 * rather than being a rule attachments keep for themselves.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in", { status: 401 });

  // A file somebody may not see and a file that does not exist answer the
  // same way — otherwise this endpoint reports which customers exist.
  if (!(await canRead(id))) {
    return new NextResponse("Not found", { status: 404 });
  }

  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id));
  if (!row) return new NextResponse("Not found", { status: 404 });

  try {
    const bytes = await fileStorage.read(row.storedRef);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": row.contentType,
        "Content-Length": String(row.sizeBytes),
        // inline: a telecaller wants to look at the photograph, not download it.
        "Content-Disposition": `inline; filename="${encodeURIComponent(row.filename)}"`,
        // Private and short-lived: the URL carries no proof of anything, so a
        // shared cache holding it would be handing the file to whoever asks.
        "Cache-Control": "private, max-age=300, no-store",
      },
    });
  } catch {
    return new NextResponse("Attachment could not be read", { status: 502 });
  }
}
