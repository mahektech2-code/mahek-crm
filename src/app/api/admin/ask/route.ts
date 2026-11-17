import { NextResponse } from "next/server";
import { z } from "zod";
import { canFor, isPlatformAdmin } from "@/lib/access-control";
import { voiceSchema } from "@/lib/ask-voice";
import { getCurrentUser } from "@/lib/auth";
import { askDocsStream, type DocsAskEvent } from "@/lib/services/docs-ask-service";
import type { AskEvent } from "@/components/shell/ask-panel";

/* ---------------------------------------------------------------------------
 * THE CONSOLE'S ASK AI. An administrator's questions are about how MahekOne
 * works — where a setting lives, what a job does, why a screen says what it
 * says — so this answers from the documentation (the docs assistant, held to
 * the platform's pages) and speaks the shared Ask panel's stream: the pages it
 * read come back as links. It reads no business data, so nothing here widens
 * what the console already shows.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const body = z.object({
  question: z.string().trim().min(1).max(1000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(8000) }))
    .max(20)
    .default([]),
  voice: voiceSchema,
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in again." }, { status: 401 });
  if (!(await isPlatformAdmin(user)) && !(await canFor(user, "config.write"))) {
    return NextResponse.json({ ok: false, error: "The Admin Console is not on your account." }, { status: 403 });
  }
  const raw = await request.json().catch(() => null);
  /* The drawer warms its endpoint as it opens; there is nothing to warm here. */
  if (raw && typeof raw === "object" && "warm" in raw) return new Response(null, { status: 204 });
  const parsed = body.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Type a question first." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: AskEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          /* the panel was closed */
        }
      };
      const links: Array<{ label: string; href: string }> = [];
      const emit = (e: DocsAskEvent) => {
        if (e.type === "source") {
          if (!links.some((l) => l.href === e.href)) links.push({ label: e.heading ? `${e.title} › ${e.heading}` : e.title, href: e.href });
          return;
        }
        if (e.type === "done") {
          if (links.length) send({ type: "links", links: links.slice(0, 6) });
          send({ type: "done", queries: e.lookups, dbQueries: 0, cached: e.cached, ms: e.ms });
          return;
        }
        send(e);
      };
      await askDocsStream(parsed.data.question, parsed.data.history, null, "platform", emit, parsed.data.voice ?? null);
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
