import { NextResponse } from "next/server";
import { studioCaller } from "@/lib/studio/http";
import { previewEnabled } from "@/lib/studio/inbox-preview";
import { isPreviewAsset, previewAssetPng } from "@/lib/studio/inbox-preview-assets";

/* LOCAL PREVIEW only: the generic sample pictures the preview's poster picker
   and sample chats draw. Answers 404 unless the preview gate is open — in a
   deployed build this route does not exist as far as anybody can tell. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const caller = await studioCaller("studio.inbox");
  if ("response" in caller) return caller.response;
  const id = new URL(request.url).searchParams.get("id");
  if (!previewEnabled() || !isPreviewAsset(id)) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  const png = await previewAssetPng(id);
  if (!png) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
