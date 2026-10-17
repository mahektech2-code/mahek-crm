import { NextResponse } from "next/server";
import { readSecret } from "@/lib/secrets";
import { bearerMatches } from "@/lib/website-cms/bearer";
import { isMediaId } from "@/lib/website-cms/media-types";
import { readMedia } from "@/lib/website-cms/media-service";

/**
 * The bytes of an uploaded website image, for the public site's own proxy
 * (`/cms-media/<id>/<name>` on mahekindia.com). Same bearer as the content
 * route; the id is a random token validated before it touches the database, and
 * only `upload` entries that are not deleted are ever returned.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const secret = await readSecret("website.cmsReadSecret");
  if (!secret) return NextResponse.json({ ok: false, error: "Not configured." }, { status: 503 });
  if (!bearerMatches(request, secret)) return NextResponse.json({ ok: false, error: "Not authorised." }, { status: 401 });

  const { id } = await context.params;
  if (!isMediaId(id)) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });

  const media = await readMedia(id);
  if (!media) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });

  const etag = media.hash ? `"${media.hash.slice(0, 32)}"` : null;
  if (etag && request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return new Response(media.bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": media.contentType,
      "content-length": String(media.bytes.byteLength),
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=0, must-revalidate",
      ...(etag ? { etag } : {}),
    },
  });
}
