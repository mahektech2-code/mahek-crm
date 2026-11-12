import { downloadFilename } from "@/lib/studio/domain/caption";
import { studioCaller, notFound } from "@/lib/studio/http";
import { renderRecipe } from "@/lib/studio/render-service";
import { getBatch, recipeOf } from "@/lib/studio/service";
import { buildZip, type ZipEntry } from "@/lib/studio/zip";

/* Every poster of a bulk run in one ZIP. They are drawn here, one at a time —
   the renderer's own limiter queues them — so a fifty-poster ZIP takes a
   while and never doubles the memory of the box it runs on. A poster that
   cannot be drawn is left out and named in a text file inside the ZIP rather
   than failing the other forty-nine. */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await studioCaller("studio.bulk");
  if ("response" in caller) return caller.response;
  const { id } = await ctx.params;
  const format = new URL(request.url).searchParams.get("format") === "jpeg" ? "jpeg" : "png";
  const batch = await getBatch(id);
  if (!batch) return notFound();
  const entries: ZipEntry[] = [];
  const failed: string[] = [];
  for (const [i, p] of batch.posters.entries()) {
    const drawn = await renderRecipe(recipeOf(p), format);
    if (!drawn.ok) {
      failed.push(`${p.recipient.company}: ${drawn.error}`);
      continue;
    }
    const file = downloadFilename(p.templateId, p.recipient.company, p.language, drawn.data.format);
    const ext = file.slice(file.lastIndexOf("."));
    const name = `${String(i + 1).padStart(2, "0")}-${file.slice(0, file.lastIndexOf(".")).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 52)}${ext}`;
    entries.push({ name, data: drawn.data.image });
  }
  if (failed.length) entries.push({ name: "not-included.txt", data: new TextEncoder().encode(`These could not be drawn:\n${failed.join("\n")}\n`) });
  if (!entries.length) return new Response("None of these posters could be drawn.", { status: 422 });
  const zip = buildZip(entries);
  return new Response(new Uint8Array(zip), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="posters-${batch.templateId}.zip"`, "Cache-Control": "private, no-store" },
  });
}
