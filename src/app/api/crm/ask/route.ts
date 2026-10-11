import { NextResponse } from "next/server";
import { z } from "zod";
import { listUserApps } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { askCrmStream, warmCrmAsk, type AskEvent } from "@/lib/services/team-ask-service";

/* ---------------------------------------------------------------------------
 * Ask the CRM, as a stream — the CRM's twin of `/api/sales/ask`.
 *
 * Behind the CRM grant here, and behind the asker's own book (`resolveScope`)
 * and CRM screens inside the service. The app is named from the page that
 * calls it (the proxy reads a same-host Referer for /api routes), so a manager
 * asks as the CRM manager they are on the CRM, not as whatever they are
 * elsewhere.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  if (!(await listUserApps(user.id)).includes("crm")) {
    return NextResponse.json({ ok: false, error: "The CRM is not on your account." }, { status: 403 });
  }

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Type a question first." }, { status: 400 });

  // Opening the drawer: build this person's context now, before they type.
  if (parsed.data.warm) {
    await warmCrmAsk();
    return NextResponse.json({ ok: true });
  }

  const question = parsed.data.question ?? "";
  if (!question) return NextResponse.json({ ok: false, error: "Type a question first." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AskEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          /* the drawer was closed; the answer finishes and is dropped */
        }
      };
      await askCrmStream(question, parsed.data.history, emit);
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
