import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { whatsappLevel } from "@/lib/access";
import { getReplyMedia } from "@/lib/services/whatsapp-chat-service";
import { fetchWatiMedia } from "@/lib/wati";

export const dynamic = "force-dynamic";

/**
 * A file a customer sent on WhatsApp — a photograph of a payment slip, a PDF of
 * a statement — streamed from Wati to somebody who may read the conversation.
 *
 * Out of scope and missing answer alike, 404, as the thread does, so this
 * cannot be used to find out which customers wrote. The bytes are never kept:
 * Wati holds the file and this is only the door to it, which is also why the
 * browser may cache the answer — a file somebody sent never changes.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });
  if ((await whatsappLevel(user.id)) === "none") return new NextResponse(null, { status: 404 });

  const { id } = await params;
  let media;
  try {
    media = await getReplyMedia(id);
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  if (!media.ok) return new NextResponse(null, { status: 404 });

  const file = await fetchWatiMedia(media.data.path);
  if (!file.ok) {
    // Wati refusing or unreachable is a fault on the far side, not a missing file.
    return new NextResponse(file.error, { status: file.status === 404 ? 404 : 502 });
  }
  const name = (media.data.path.split("/").pop() ?? "file").replace(/[^A-Za-z0-9._-]/g, "");
  /*
   * DRAWN ONLY WHERE IT CANNOT RUN. A photograph draws and a PDF opens in the
   * browser's own viewer. Anything else a customer sends — and "a document" can
   * be an HTML page — is handed over as bytes to save, never rendered on this
   * site's origin, where it would run with the reader's session.
   */
  const type = file.contentType.split(";")[0].trim().toLowerCase();
  const safe = /^(image\/(jpeg|png|gif|webp)|application\/pdf|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/.test(type);
  return new NextResponse(file.bytes, {
    headers: {
      "Content-Type": safe ? type : "application/octet-stream",
      "Content-Disposition": `${safe ? "inline" : "attachment"}; filename="${name}"`,
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
