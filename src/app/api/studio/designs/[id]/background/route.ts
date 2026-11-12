import { canOpenModule } from "@/lib/access";
import { fileStorage } from "@/lib/storage";
import { studioCaller, imageResponse, notFound } from "@/lib/studio/http";
import { getDesignRow } from "@/lib/studio/service";

/* An uploaded design's bare artwork, for the placement editor. Its owner and
   whoever approves designs may open it; for anybody else it does not exist. */

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await studioCaller("studio.designs");
  if ("response" in caller) return caller.response;
  const { id } = await ctx.params;
  const row = await getDesignRow(id);
  if (!row) return notFound();
  if (row.createdById !== caller.user.id && !(await canOpenModule(caller.user.id, "studio.approve"))) return notFound();
  return imageResponse(Buffer.from(await fileStorage.read(row.backgroundRef)), "image/png");
}
