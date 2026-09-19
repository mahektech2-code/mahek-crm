import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { getConfig } from "@/lib/config/store";
import { liveDeltaFor, managerScope } from "@/lib/services/sales-service";

/**
 * THE LIVE MAP IS TOLD, RATHER THAN ASKED.
 *
 * It used to poll: every thirty seconds the browser called `router.refresh()`
 * and the whole Server Component ran again — the team read, both trail reads,
 * the activity read and a full serialisation of all of it, for every open tab,
 * whether or not a single fix had arrived. Handsets upload every few seconds,
 * so the POLL had become the binding constraint on the word "live": a pin could
 * be half a minute behind the phone no matter how fast the phone sent.
 *
 * ── WHY SERVER-SENT EVENTS ────────────────────────────────────────────────
 *
 * Nothing flows upward. The browser has nothing to tell this server about a map
 * it is watching, so a WebSocket buys a second protocol, an upgrade handshake
 * Caddy has to be trusted to pass, a library, a ping/pong keepalive somebody
 * has to write, and reconnection logic somebody has to write again — to carry
 * traffic in one direction. SSE is plain HTTP with a content type: no
 * dependency, no upgrade, and the browser reconnects by itself, carrying
 * `Last-Event-ID` so nothing is missed across the gap.
 *
 * And it is frugal, which on this box is not a preference. The whole of
 * MahekOne runs on one droplet with one vCPU and 961 MB, most of it already
 * spoken for, so the thing to compare is not "a connection versus no
 * connection" — it is this against what it replaced. A watching manager used to
 * cost a full page render every thirty seconds; he now costs one small indexed
 * query every few seconds and one team read on the cadence the page used to run
 * at. Fewer queries, far less CPU, no RSC serialisation, and the only new cost
 * is an idle socket.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────
 *
 * A stream must not become a way to watch salesmen a manager cannot otherwise
 * see, and this file gets that right in three deliberate steps.
 *
 * **The `sales` grant is asked FIRST**, exactly as `book-pins` does one
 * directory along, and for the reason `attachment-service.ts` records in
 * blood: `managerScope` is VACUOUS for anybody with no `region` row — it
 * answers "national, sees everybody" — and nearly every plain field salesman
 * has none. A route leaning on it alone hands the whole company's positions to
 * anyone signed in. The grant decides whether there is a screen for this at
 * all; the scope only narrows what that screen shows.
 *
 * **The module is checked too**, not just the app: `/sales/live` has its own
 * layout guard on `sales.live`, and a stream is a URL. Somebody narrowed out of
 * the Live map must not be able to subscribe to it.
 *
 * **The scope is resolved ONCE, inside the request, and handed to every tick.**
 * This is the part that would be easy to get wrong. `managerScope` reads the
 * session through `requireUser`, which reads the request's cookies — and a tick
 * firing two minutes from now runs in no request at all. Asking there would
 * either throw or, far worse, fall into that function's own `catch`, which
 * answers `national: true` on the reasoning that a caller with no session is a
 * script or a job. The narrowing would fail OPEN. So it is resolved here, while
 * there is still a request to read, and `liveDeltaFor` takes it as its first
 * and required argument.
 *
 * A short connection life is the other half of that: a stream lives minutes,
 * not hours, so a revoked session or a changed territory is picked up on the
 * next reconnect rather than being honoured for an afternoon.
 *
 * ── WHAT WE COULD NOT VERIFY ──────────────────────────────────────────────
 *
 * Caddy sits in front of this. Two things in its configuration bear on a
 * long-lived response and only one of them could be settled from the
 * repository:
 *
 *   `reverse_proxy … transport http { read_timeout 300s }` — whatever exactly
 *   that deadline applies to, a response that never ends is the one shape that
 *   can run into it. That is answered by NEVER RUNNING THAT LONG:
 *   `mbos.location.liveStreamMinutes` is capped at four, the server closes the
 *   stream itself, and the browser opens another. A connection that ends on our
 *   own terms cannot be cut on somebody else's.
 *
 *   `encode zstd gzip` — a compressor that buffers would hold every event until
 *   it had a block worth flushing, and the map would go dead with the
 *   connection reading as perfectly healthy. Caddy is believed to pass Flush
 *   through, but that is belief and not something this repository can show. So
 *   `text/event-stream` is excluded from `encode` in the Caddyfile, the
 *   response declares `Content-Encoding: identity` and `Cache-Control:
 *   no-transform` as well, and — because an antivirus, a corporate proxy or a
 *   browser extension can buffer just as effectively as a web server — the
 *   client gives up on a stream that delivers nothing and falls back to asking.
 *   See `use-live-feed.ts`; the screen says which of the two it is doing.
 */
export const dynamic = "force-dynamic";
/** No static optimisation, no Node fetch cache: this response is a connection. */
export const fetchCache = "force-no-store";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "signed out" }, { status: 401, ...NO_STORE });

  /* The `sales` GRANT and the `sales.live` module together, in that order —
     see `canOpenModule`. Asking `listUserModules` alone answers "every module"
     for somebody who holds none of the app. */
  if (!(await canOpenModule(user.id, "sales.live"))) {
    return NextResponse.json({ error: "not yours" }, { status: 403, ...NO_STORE });
  }

  const params = new URL(request.url).searchParams;
  const day = params.get("day") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ error: "no day" }, { status: 400, ...NO_STORE });
  }
  const withActivity = params.get("view") === "today";

  /*
   * THE BROWSER'S OWN CURSOR WINS OVER THE QUERY STRING.
   *
   * `Last-Event-ID` is what EventSource replays after a drop, and it is the
   * whole reason a reconnect loses nothing: the URL was fixed when the stream
   * was opened and says how far the page had been told at first paint, while
   * the header says how far this browser has actually been told. Reading the
   * URL alone would re-send an hour of a day on every reconnect; reading it
   * only where the header is absent is the first connection.
   */
  const resumed = Number(request.headers.get("last-event-id"));
  const asked = Number(params.get("since"));
  const startCursor = Number.isFinite(resumed) && resumed > 0
    ? resumed
    : Number.isFinite(asked) && asked > 0
      ? asked
      : null;

  /* Resolved inside the request — see the note above. Never inside a tick. */
  const scope = await managerScope();

  /*
   * Read once for the life of the connection rather than on every tick.
   *
   * A cadence changed on the Settings screen takes effect on the next
   * reconnect, which is at most `liveStreamMinutes` away — and `getConfig`
   * caches for thirty seconds anyway, so re-reading per tick would mostly be
   * re-reading the same cached object while adding a database round trip to the
   * one path that exists to be cheap.
   */
  const config = await getConfig();
  const pushMs = config["mbos.location.livePushSeconds"] * 1000;
  const teamMs = config["mbos.location.liveTeamSeconds"] * 1000;
  const lifeMs = config["mbos.location.liveStreamMinutes"] * 60_000;

  const encoder = new TextEncoder();
  let cursorMs = startCursor;
  let lastTeamMs = 0;
  /* One tick at a time. On one vCPU a team read can outlast a push interval,
     and intervals do not queue politely — they pile up, and the pile is what
     takes a small box down. */
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ender: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const stop = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        if (ender) clearTimeout(ender);
        try {
          controller.close();
        } catch {
          /* Already closed by the client going away. Nothing to do and nothing
             worth logging: a manager closing a tab is not an error. */
        }
      };

      const send = (event: string, data: unknown, id?: number) => {
        if (closed) return;
        try {
          const frame = id === undefined ? sse(event, data) : `id: ${id}\n${sse(event, data)}`;
          controller.enqueue(encoder.encode(frame));
        } catch {
          stop();
        }
      };

      /* The client goes away far more often than it disconnects cleanly — a
         closed tab, a laptop lid, a lost connection. `request.signal` is the
         only one of those that reaches us. */
      request.signal.addEventListener("abort", stop);

      /*
       * How long the browser waits before reconnecting, and it is deliberately
       * not the default. EventSource retries after three seconds unless told
       * otherwise, which on a deployment that closes every stream after four
       * minutes is a reconnect storm waiting for a busy afternoon; matched to
       * the push cadence it is one reconnect where a tick would have been.
       */
      send("hello", {
        pushSeconds: config["mbos.location.livePushSeconds"],
        teamSeconds: config["mbos.location.liveTeamSeconds"],
        streamMinutes: config["mbos.location.liveStreamMinutes"],
      });
      controller.enqueue(encoder.encode(`retry: ${pushMs}\n\n`));

      const tick = async () => {
        if (closed || busy) return;
        busy = true;
        try {
          const now = Date.now();
          /* The first tick of a RESUMED connection is not a team read: the
             browser already has the rows and the gap it is catching up on is
             measured in seconds. A reconnect that always re-read the team
             would make a flaky connection the most expensive kind. */
          const withTeam = cursorMs === null || now - lastTeamMs >= teamMs;
          const delta = await liveDeltaFor(scope, {
            day,
            sinceMs: cursorMs,
            withActivity,
            withTeam,
          });
          if (withTeam) lastTeamMs = now;
          cursorMs = delta.cursorMs;
          /* The id IS the cursor, which is what makes `Last-Event-ID` worth
             reading at the top of this file: the browser replays from exactly
             where it was told up to, with no state of its own to keep. */
          send("delta", delta, delta.cursorMs);
        } catch (err) {
          /* A failed read is not a reason to take the connection down — the
             next tick is six seconds away and the database is on the same
             machine. It IS a reason to say so: a map that silently stopped
             updating is the failure this whole change exists to end. */
          send("trouble", { message: err instanceof Error ? err.message : "read failed" });
        } finally {
          busy = false;
        }
      };

      await tick();
      timer = setInterval(tick, pushMs);

      /*
       * The stream ends itself, and that is a feature rather than a limit.
       *
       * It bounds what a proxy in front of this can cut, it bounds how long a
       * revoked session can go on being honoured, and it bounds what one
       * forgotten tab can hold — a browser left open over a weekend reconnects
       * a few hundred times instead of holding one socket and one closure for
       * sixty hours. The client is told so it can say "reconnecting" rather
       * than showing a map that has quietly stopped.
       */
      ender = setTimeout(() => {
        send("bye", { reason: "cycling" });
        stop();
      }, lifeMs);
    },
    cancel() {
      if (timer) clearInterval(timer);
      if (ender) clearTimeout(ender);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      /* `no-transform` asks every hop not to recompress; `identity` is what
         Caddy's `encode` looks at before deciding to compress at all. Both,
         plus the Caddyfile's own exclusion, because a buffered stream fails
         silently and looks exactly like a working one. */
      "Cache-Control": "no-cache, no-store, no-transform",
      "Content-Encoding": "identity",
      Connection: "keep-alive",
      /* nginx's spelling of the same request. Not in front of this deployment
         today; one line against the day something is. */
      "X-Accel-Buffering": "no",
    },
  });
}
