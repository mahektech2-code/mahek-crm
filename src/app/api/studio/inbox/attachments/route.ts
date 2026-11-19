import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { studioForwards } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { studioCaller } from "@/lib/studio/http";
import { previewEnabled } from "@/lib/studio/inbox-preview";
import { previewAssetsOf } from "@/lib/studio/inbox-preview-assets";
import { listPosters } from "@/lib/studio/service";

/* What the Inbox's poster picker offers: the viewer's own made posters (My
   posters) and the pictures they uploaded to forward. Both are the viewer's
   own — the same lists those screens show, nothing wider. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const caller = await studioCaller("studio.inbox");
  if ("response" in caller) return caller.response;
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") === "forwards" ? "forwards" : "posters";
  const page = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1));
  /* LOCAL PREVIEW: generic labelled sample pictures — nothing from the database, so no real customer's name appears. */
  if (previewEnabled()) {
    const items = previewAssetsOf(kind === "forwards" ? "forward" : "poster").map((a) => ({ id: a.id, title: a.title, sub: a.sub, at: null, thumb: `/api/studio/inbox/preview-asset?id=${a.id}` }));
    return NextResponse.json({ ok: true, kind, canForwards: true, page: 1, pageCount: 1, items });
  }
  if (kind === "forwards") {
    if (!(await canOpenModule(caller.user.id, "studio.forward"))) return NextResponse.json({ ok: true, kind, items: [], canForwards: false });
    const rows = await db
      .select({ id: studioForwards.id, title: studioForwards.title, createdAt: studioForwards.createdAt })
      .from(studioForwards)
      .where(eq(studioForwards.createdById, caller.user.id))
      .orderBy(desc(studioForwards.createdAt))
      .limit(60);
    return NextResponse.json({ ok: true, kind, canForwards: true, items: rows.map((r) => ({ id: r.id, title: r.title, at: r.createdAt, thumb: `/api/studio/forwards/${encodeURIComponent(r.id)}/image?thumb=1` })) });
  }
  const list = await listPosters({ whose: "mine", page });
  return NextResponse.json({
    ok: true,
    kind,
    canForwards: await canOpenModule(caller.user.id, "studio.forward"),
    page: list.page,
    pageCount: list.pageCount,
    items: list.rows.map((r) => ({ id: r.id, title: r.company, sub: `${r.templateName} · ${r.language}`, at: r.createdAt, thumb: `/api/studio/posters/${encodeURIComponent(r.id)}/image?format=jpeg` })),
  });
}
