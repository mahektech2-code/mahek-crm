import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canEditAny } from "@/lib/website-cms/access";
import { isMediaId } from "@/lib/website-cms/media-types";
import { readMedia } from "@/lib/website-cms/media-service";

/**
 * An uploaded website image, for the EDITOR's own thumbnails and previews inside
 * MahekOne. The public site gets the same bytes from the secret-protected
 * `/api/public/website/media/[id]`; this one answers to a signed-in person who
 * holds a Website content module.
 */

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in again." }, { status: 401 });
  if (!(await canEditAny(user.id))) return NextResponse.json({ ok: false, error: "Not permitted." }, { status: 403 });

  const { id } = await context.params;
  if (!isMediaId(id)) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  const media = await readMedia(id);
  if (!media) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });

  return new Response(media.bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": media.contentType,
      "content-length": String(media.bytes.byteLength),
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
    },
  });
}
