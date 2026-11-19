import { NextResponse } from "next/server";
import { studioCaller } from "@/lib/studio/http";
import { getForward } from "@/lib/studio/forward-service";
import { previewEnabled } from "@/lib/studio/inbox-preview";
import { isPreviewAsset, previewAssetOf } from "@/lib/studio/inbox-preview-assets";
import { getStudioRegistry } from "@/lib/studio/registry-service";
import { captionFor, getPoster } from "@/lib/studio/service";

/* The caption suggested with a poster, for the picker. Read through the same
   scope checks as the poster itself. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const caller = await studioCaller("studio.inbox");
  if ("response" in caller) return caller.response;
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  if (previewEnabled() && isPreviewAsset(id)) return NextResponse.json({ ok: true, caption: previewAssetOf(id)?.caption ?? "" });
  if (url.searchParams.get("kind") === "forward") {
    const f = await getForward(caller.user.id, id);
    return f ? NextResponse.json({ ok: true, caption: f.caption ?? "" }) : NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  const poster = await getPoster(id);
  if (!poster || poster.removedAt) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  const t = (await getStudioRegistry()).getVersion(poster.templateId, poster.templateVersion);
  return NextResponse.json({ ok: true, caption: (t ? captionFor(poster, t.manifest.category) : null) ?? "" });
}
