import { NextResponse } from "next/server";
import { z } from "zod";
import { listUserApps } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { erpContext } from "@/lib/erp/access";

/* ---------------------------------------------------------------------------
 * Ask the ERP, in the shared Ask AI drawer's stream format.
 *
 * The ERP's answer is not SQL over views: its tools call each SCREEN'S OWN
 * LOADER as the asker, so money and cost the person may not see are already
 * gone (`lib/erp/ai-ask.ts`). That engine answers whole rather than word by
 * word, so this route sends one step while it reads, the answer, and the
 * records it read as links the drawer draws under it.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const body = z.object({
  question: z.string().trim().max(1000).optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(8000) }))
    .max(20)
    .default([]),
  warm: z.boolean().optional(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in again." }, { status: 401 });
  if (!(await listUserApps(user.id)).includes("erp")) {
    return NextResponse.json({ ok: false, error: "The ERP is not on your account." }, { status: 403 });
  }
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Type a question first." }, { status: 400 });
  if (parsed.data.warm) return NextResponse.json({ ok: true });
  const question = parsed.data.question ?? "";
  if (!question) return NextResponse.json({ ok: false, error: "Type a question first." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: object) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          /* the drawer was closed */
        }
      };
      const started = Date.now();
      emit({ type: "step", text: "Reading the ERP screens you can open" });
      try {
        const ctx = await erpContext();
        if (!ctx.level) emit({ type: "error", message: "The ERP is not on your account." });
        else {
          const { askErp } = await import("@/lib/erp/ai-ask");
          const r = await askErp(ctx, question, parsed.data.history);
          if (!r.ok) emit({ type: "error", message: r.error });
          else {
            emit({ type: "delta", text: r.answer.answer });
            if (r.answer.records.length) emit({ type: "links", links: r.answer.records });
            emit({ type: "done", queries: r.answer.records.length, dbQueries: r.answer.records.length, cached: false, ms: Date.now() - started });
          }
        }
      } catch (e) {
        console.error("Ask the ERP failed:", e instanceof Error ? e.message : e);
        emit({ type: "error", message: "The question could not be answered just now. Try the screens, or ask again in a minute." });
      }
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
