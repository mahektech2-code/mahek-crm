import sharp from "sharp";
import { fileStorage } from "@/lib/storage";
import { getForward } from "@/lib/studio/forward-service";
import { imageResponse, notFound, studioCaller } from "@/lib/studio/http";

/* The uploaded poster, exactly as it arrived. Only whoever uploaded it may open it. */
export const dynamic = "force-dynamic";
const TYPE = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;
const EXT = { png: "png", jpeg: "jpg", webp: "webp" } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const caller = await studioCaller("studio.forward");
  if ("response" in caller) return caller.response;
  const { id } = await params;
  const row = await getForward(caller.user.id, id);
  if (!row) return notFound();
  const bytes = Buffer.from(await fileStorage.read(row.sourceRef));
  const search = new URL(request.url).searchParams;
  /* `?thumb=1`: a small preview for the My posters table, so a page of thirty rows is not thirty full-size uploads. */
  if (search.get("thumb") === "1") {
    const small = await sharp(bytes, { limitInputPixels: 36_000_000 }).rotate().resize(160, 160, { fit: "cover" }).jpeg({ quality: 70 }).toBuffer();
    const res = imageResponse(small, "image/jpeg");
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  const download = search.get("download") === "1";
  const type = TYPE[row.format as keyof typeof TYPE];
  const safe = row.title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "poster";
  const res = imageResponse(bytes, type, { download: download ? `${safe}.${EXT[row.format as keyof typeof EXT]}` : null });
  /* An uploaded poster is somebody's own file behind a per-person check. A browser that keeps it (even privately) would show it to the
     next person to sign in on the same machine, so this route alone is never cached. The shared helper is left as it is for every other route. */
  res.headers.set("Cache-Control", "no-store");
  return res;
}
