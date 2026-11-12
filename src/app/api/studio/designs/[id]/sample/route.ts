import { NextResponse } from "next/server";
import { canOpenModule } from "@/lib/access";
import { fileStorage } from "@/lib/storage";
import { parsePlacement } from "@/lib/studio/domain/template-upload";
import { previewDraft, stageDraftBackground } from "@/lib/studio/designs-service";
import { studioCaller, notFound } from "@/lib/studio/http";
import { getDesignRow } from "@/lib/studio/service";

/* The placement drawn with sample text, and what the drawing found. Sent the
   placement the editor is holding, so somebody sees a change before saving
   it. Answers JSON with the picture inline: the editor needs the problems and
   the picture in one answer, and they must describe the same placement. */

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const caller = await studioCaller("studio.designs");
  if ("response" in caller) return caller.response;
  const { id } = await ctx.params;
  const row = await getDesignRow(id);
  if (!row) return notFound();
  if (row.createdById !== caller.user.id && !(await canOpenModule(caller.user.id, "studio.approve"))) return notFound();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = row.placement;
  }
  const parsed = parsePlacement(body ?? row.placement);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.message }, { status: 400 });
  if (parsed.draft.canvas !== row.canvas) return NextResponse.json({ ok: false, error: "The canvas size comes from the uploaded image and cannot be changed." }, { status: 400 });
  const backgroundPath = stageDraftBackground(id, Buffer.from(await fileStorage.read(row.backgroundRef)));
  const pv = await previewDraft({ id, placement: parsed.draft, backgroundPath });
  return NextResponse.json({
    ok: true,
    data: {
      image: `data:image/png;base64,${pv.png.toString("base64")}`,
      errors: [...pv.check.errors.map((e) => e.message), ...pv.render.errors],
      warnings: [...pv.check.warnings.map((e) => e.message), ...pv.render.warnings],
    },
  });
}
