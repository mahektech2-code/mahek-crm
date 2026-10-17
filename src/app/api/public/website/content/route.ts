import { NextResponse } from "next/server";
import { readSecret } from "@/lib/secrets";
import { bearerMatches } from "@/lib/website-cms/bearer";
import { currentBundle } from "@/lib/website-cms/service";

/* ---------------------------------------------------------------------------
 * What mahekindia.com reads: the website's content as one JSON document.
 *
 * Server to server. A bearer secret is the whole of its authority
 * (`website.cmsReadSecret`, set under Admin → Integrations, via lib/secrets.ts —
 * the same pattern as /api/public/enquiries), and it fails closed: with no
 * secret configured the answer is 503, never an open door.
 *
 *   GET /api/public/website/content          the PUBLISHED snapshots only
 *   GET /api/public/website/content?draft=1  the working copies, for previews
 *
 * Never cached: the public site decides how long to keep it and is told when to
 * drop it. The body is built by `lib/website-cms/bundle.ts`, which is where the
 * rules about what is live live.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const secret = await readSecret("website.cmsReadSecret");
  if (!secret) return NextResponse.json({ ok: false, error: "Not configured." }, { status: 503 });
  if (!bearerMatches(request, secret)) return NextResponse.json({ ok: false, error: "Not authorised." }, { status: 401 });

  const draft = new URL(request.url).searchParams.get("draft") === "1";
  try {
    const bundle = await currentBundle(draft);
    return NextResponse.json(bundle, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("[api/public/website/content] failed to build the bundle:", e);
    return NextResponse.json({ ok: false, error: "Could not read the content right now." }, { status: 502 });
  }
}
