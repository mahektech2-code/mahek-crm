import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getCurrentUser } from "@/lib/auth";
import { whatsappLevel } from "@/lib/access";
import { resolveScope, scopedToUsers, scopedUserIds } from "@/lib/access-control";
import { threadKeyOf, waBus, type WaLiveEvent } from "@/lib/wa-live";

/**
 * THE WHATSAPP CHAT IS TOLD, RATHER THAN ASKED — the same shape as the Live
 * map's stream (`api/sales/live/stream`, which carries the full argument):
 * Server-Sent Events, plain HTTP, the browser reconnects by itself, and the
 * stream ends itself after a few minutes so no proxy in front of it ever has
 * to. `text/event-stream` is excluded from Caddy's compression already.
 *
 * What travels is only WHICH conversation moved — never the words. The screen
 * then re-reads that thread through the same scoped read as everything else.
 *
 * SCOPE IS RESOLVED HERE, INSIDE THE REQUEST, and handed to every event: an
 * event fires minutes from now in no request at all, and asking for the
 * session there would fail. Each event is checked against it before a byte is
 * sent: a customer in this person's book, or — for a number on nobody's
 * book — this person sees the whole book. Anything else is not mentioned.
 */
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
/** Short enough that no proxy deadline is ever reached; the browser reopens. */
const LIFE_MS = 4 * 60_000;
/** A comment line now and then, so an idle connection is never read as dead. */
const PING_MS = 20_000;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "signed out" }, { status: 401, ...NO_STORE });
  if ((await whatsappLevel(user.id)) === "none") {
    return NextResponse.json({ error: "not yours" }, { status: 403, ...NO_STORE });
  }

  const ids = scopedUserIds((await resolveScope()).scope);
  const scope = scopedToUsers(ids);
  const mayHear = async (e: WaLiveEvent): Promise<boolean> => {
    if (!e.customerId) return ids === null;
    if (!scope) return true;
    const rows = await db.execute(sql`
      select 1 from customers where customers.id = ${e.customerId} and (${scope}) limit 1
    `);
    return rows.length > 0;
  };

  const bus = waBus();
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          stop();
        }
      };
      const onEvent = (e: WaLiveEvent) => {
        void mayHear(e).then((yes) => {
          const key = threadKeyOf(e);
          if (yes && key) write(`event: wa\ndata: ${JSON.stringify({ key })}\n\n`);
        }, () => {});
      };
      const ping = setInterval(() => write(": ping\n\n"), PING_MS);
      const ender = setTimeout(() => {
        write(`event: bye\ndata: {}\n\n`);
        stop();
      }, LIFE_MS);
      function stop() {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        clearTimeout(ender);
        bus.off("event", onEvent);
        try {
          controller.close();
        } catch {
          /* Already closed by the browser going away. */
        }
      }
      cleanup = stop;
      bus.on("event", onEvent);
      request.signal.addEventListener("abort", stop);
      // Sent before anything else, so the browser knows at once that the
      // stream delivers; and a short retry, because a chat that is five
      // seconds behind after a reconnect is not live.
      write(`retry: 2000\n\nevent: hello\ndata: {}\n\n`);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      "Content-Encoding": "identity",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
