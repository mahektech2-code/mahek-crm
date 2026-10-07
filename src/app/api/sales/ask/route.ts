import { NextResponse } from "next/server";
import { z } from "zod";
import { listUserApps } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { askTeamStream, warmTeamAsk, type AskEvent } from "@/lib/services/team-ask-service";

/* ---------------------------------------------------------------------------
 * "Ask about the team", as a stream.
 *
 * A route rather than a server action because the answer is STREAMED: the
 * drawer shows each read as it is made ("Leave Mahesh took this year") and the
 * answer's words as they are written, so a manager watches it work instead of
 * staring at a spinner. One JSON object per line.
 *
 * Behind the Sales Dashboard grant here, and behind `team.report` and the
 * person's own scope and screens inside the service — the route is a URL, so
 * it asks for itself rather than trusting the button that calls it.
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
  if (!(await listUserApps(user.id)).includes("sales")) {
    return NextResponse.json({ ok: false, error: "The Sales Dashboard is not on your account." }, { status: 403 });
  }

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Type a question first." }, { status: 400 });

  // Opening the drawer: build this person's context now, before they type.
  if (parsed.data.warm) {
    await warmTeamAsk();
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
      await askTeamStream(question, parsed.data.history, emit);
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
