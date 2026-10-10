import { NextResponse } from "next/server";
import { z } from "zod";
import { listUserApps } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { askDocsStream, type DocsAskEvent } from "@/lib/services/docs-ask-service";

/* ---------------------------------------------------------------------------
 * "Ask the docs", as a stream — one JSON object per line: each lookup as it
 * is made, the sections read, then the answer's words as they are written.
 *
 * Behind the Documentation grant: the route is a URL, so it asks for itself
 * rather than trusting the button that calls it.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.object({
  question: z.string().trim().min(1).max(1000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(8000) }))
    .max(20)
    .default([]),
  place: z
    .object({ app: z.string().max(40), slug: z.string().max(80).nullish(), tab: z.string().max(40).nullish() })
    .nullish(),
  /** One app's documentation, or omitted for all of it. */
  scope: z.string().max(40).nullish(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in again." }, { status: 401 });
  if (!(await listUserApps(user.id)).includes("docs")) {
    return NextResponse.json({ ok: false, error: "The Documentation app is not on your account." }, { status: 403 });
  }

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Type a question first." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: DocsAskEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          /* the panel was closed; the answer finishes and is dropped */
        }
      };
      await askDocsStream(parsed.data.question, parsed.data.history, parsed.data.place ?? null, parsed.data.scope ?? null, emit);
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
