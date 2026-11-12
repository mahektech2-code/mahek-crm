import { downloadFilename } from "@/lib/studio/domain/caption";
import { studioCaller, imageResponse, notFound } from "@/lib/studio/http";
import { renderRecipe } from "@/lib/studio/render-service";
import { getPoster, recipeOf } from "@/lib/studio/service";

/* A poster, drawn from its recipe. `format=jpeg` for the smaller file a
   WhatsApp chat prefers; `download=1` to save it under a readable name. Who
   may open it is `getPoster`'s answer: whoever made it, and whoever's scope
   takes in the person who did. */

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await studioCaller(null);
  if ("response" in caller) return caller.response;
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "jpeg" ? "jpeg" : "png";
  const poster = await getPoster(id);
  if (!poster) return notFound();
  const drawn = await renderRecipe(recipeOf(poster), format);
  if (!drawn.ok) return new Response(drawn.error, { status: 422, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const name = downloadFilename(poster.templateId, poster.recipient.company, poster.language, drawn.data.format);
  return imageResponse(drawn.data.image, drawn.data.format === "jpeg" ? "image/jpeg" : "image/png", { download: url.searchParams.get("download") ? name : null, cache: "immutable" });
}
