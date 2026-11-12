import fs from "node:fs";
import { studioCaller, imageResponse, notFound } from "@/lib/studio/http";
import { getStudioRegistry } from "@/lib/studio/registry-service";

/* A design's preview picture — the shipped preview.png of a built-in design,
   or the one drawn at approval for an uploaded one. Any version that exists,
   current or archived, because a poster made last year shows the design it
   was made from. */

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await studioCaller(null);
  if ("response" in caller) return caller.response;
  const { id } = await ctx.params;
  const version = new URL(request.url).searchParams.get("v") ?? undefined;
  const registry = await getStudioRegistry();
  const t = registry.getVersion(id, version) ?? registry.get(id);
  if (!t) return notFound();
  try {
    return imageResponse(fs.readFileSync(t.previewPath), "image/png", { cache: version ? "immutable" : "private-short" });
  } catch {
    return notFound();
  }
}
