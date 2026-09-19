"use client";

import * as React from "react";
import { mergeLiveDelta, type LiveFrame, type LivePosition } from "@/lib/engines/live-feed";
import type { ActivityPoint, LastKnown } from "@/lib/services/sales-service";

/**
 * KEEPING THE LIVE MAP LIVE, WITHOUT ASKING FOR THE DAY AGAIN.
 *
 * The screen used to call `router.refresh()` every thirty seconds, which
 * re-ran the whole Server Component and re-serialised the entire day into the
 * answer. That made the poll the binding constraint on the word "live" — a
 * handset uploading every few seconds could not move a pin faster than the
 * browser next thought to ask — and it billed the server for the whole day on
 * every tick, for every open tab, whether or not one fix had arrived.
 *
 * This subscribes instead. What comes down is what has arrived since the last
 * time this browser was told anything, and `engines/live-feed.ts` folds it into
 * what is already on screen. Nothing here re-derives the day.
 *
 * **Two modes, and the screen says which.** A stream is the ordinary path; a
 * poll of the SAME delta endpoint is what happens when a stream cannot be had.
 * Both are real and neither is a degraded silence: the failure this replaces is
 * a map that has quietly stopped, and swapping one silent failure for another
 * would be no gain at all.
 */
export type LiveMode =
  /** A stream is open and delivering. */
  | "live"
  /** Opening one, or waiting to find out whether it will deliver. */
  | "connecting"
  /** No stream to be had — asking on a cadence instead, and saying so. */
  | "polling"
  /** A past day. Nothing is coming, and nothing should be asked for. */
  | "settled";

type Frame = LiveFrame<LastKnown, ActivityPoint>;

/**
 * HOW MANY FAILED CONNECTIONS BEFORE THE STREAM IS GIVEN UP ON.
 *
 * One failure is ordinary — a laptop lid, a lost signal, the four-minute
 * recycle racing a network change. Two in a row with nothing delivered between
 * them is a proxy, an extension or a network that will not carry this, and
 * retrying a third time is a manager watching a dead map while the browser
 * quietly tries again. It is not configuration: nobody in the office has an
 * opinion about how many times to try, and the numbers it has to be balanced
 * against are the two cadences it already reads.
 */
const GIVE_UP_AFTER = 2;

/** A wire delta, before its timestamps have been made into dates again. */
type WireDelta = {
  cursorMs: number;
  rows: LastKnown[] | null;
  positions: Array<Omit<LivePosition, "at"> & { at: string }>;
  activity: ActivityPoint[];
};

/**
 * A DATE OFF THE WIRE IS A STRING, and this is the one place it stops being
 * one.
 *
 * `at` is what the trail is sorted, deduplicated and drawn by — `.getTime()` on
 * a string is `NaN`, and `NaN` compares false against everything, so the
 * failure is not an error but a trail that simply stops growing. Everything
 * else on these rows is left as it arrived, deliberately: the server-rendered
 * props are already strings too (raw `db.execute` hands timestamps back
 * untouched), so the components below already read them as such, and reviving
 * a field here that is a string on first paint would make two shapes of one
 * row.
 */
function revive(delta: WireDelta) {
  return { ...delta, positions: delta.positions.map((p) => ({ ...p, at: new Date(p.at) })) };
}

export function useLiveFeed({
  day,
  view,
  isToday,
  initial,
  pushSeconds,
  pollSeconds,
}: {
  day: string;
  view: "now" | "today";
  /** A day that has already happened has nothing left to arrive. */
  isToday: boolean;
  /** What the server rendered, and the cursor it rendered as of. */
  initial: Frame;
  pushSeconds: number;
  pollSeconds: number;
}): { frame: Frame; mode: LiveMode } {
  const [frame, setFrame] = React.useState<Frame>(initial);
  const [mode, setMode] = React.useState<LiveMode>(isToday ? "connecting" : "settled");

  /*
   * The cursor is held in a REF and not in state, and the two are different
   * things rather than a shortcut.
   *
   * It is not rendered, and every effect below needs the newest value without
   * being torn down and rebuilt when it moves — a stream that reopened on every
   * delta would reconnect several times a minute and never deliver anything
   * between reconnects. The frame's own `cursorMs` is the rendered copy; this
   * is the one the transport reads.
   */
  const cursor = React.useRef(initial.cursorMs);

  const apply = React.useCallback((wire: WireDelta) => {
    const delta = revive(wire);
    cursor.current = Math.max(cursor.current, delta.cursorMs);
    setFrame((held) => mergeLiveDelta(held, delta));
  }, []);

  React.useEffect(() => {
    if (!isToday) return;

    /*
     * Everything below is torn down and rebuilt together, so one flag closes
     * all of it. Effects in React 19 run twice in development on purpose, and a
     * stream that survived its own cleanup is a second connection nobody can
     * see and the server pays for.
     */
    let stopped = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    /** Once true, the stream is not tried again for the life of this mount. */
    let givenUp = false;

    const url = (path: string) =>
      `/api/sales/live/${path}?day=${day}&view=${view}&since=${cursor.current}`;

    const closeStream = () => {
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = null;
      source?.close();
      source = null;
    };

    const poll = async () => {
      /* A backgrounded tab asking for a map nobody is looking at is the cost
         this whole change exists to remove. */
      if (stopped || document.hidden) return;
      try {
        const res = await fetch(url("delta"), { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        if (!stopped) apply((await res.json()) as WireDelta);
      } catch {
        /* Left to the next tick. A failed ask on a flaky connection is not
           news, and the mode on the screen already says this is the slower
           path. */
      }
    };

    const startPolling = () => {
      if (stopped || pollTimer) return;
      closeStream();
      setMode("polling");
      pollTimer = setInterval(poll, pollSeconds * 1000);
      void poll();
    };

    const startStream = () => {
      if (stopped || givenUp || source) return;
      setMode("connecting");
      const es = new EventSource(url("stream"));
      source = es;

      /*
       * A STREAM THAT OPENS AND SAYS NOTHING IS THE FAILURE TO CATCH.
       *
       * A buffering proxy, an antivirus holding a response until it has seen
       * the end of it, an extension: all of them produce a connection that
       * reports itself perfectly healthy and delivers nothing, which is exactly
       * the silent dead map this change exists to end. The server sends a
       * `hello` before it does any work at all, so anything that has not
       * arrived within the time a poll would have taken is a stream not worth
       * waiting on. The timer is CLEARED by the first thing that arrives rather
       * than checked against a state value: `mode` inside this closure is
       * whatever it was when the connection was opened, and reading it here
       * would be the stale-closure bug that froze the map in the first place,
       * one file along.
       */
      graceTimer = setTimeout(
        () => {
          if (stopped) return;
          givenUp = true;
          startPolling();
        },
        Math.max(pollSeconds, pushSeconds * 2) * 1000,
      );

      es.addEventListener("hello", () => {
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = null;
        failures = 0;
        setMode("live");
      });

      es.addEventListener("delta", (e) => {
        failures = 0;
        setMode("live");
        apply(JSON.parse((e as MessageEvent).data) as WireDelta);
      });

      /* The server closing on its own terms, having said so. EventSource would
         reconnect by itself here, but not before reporting an error — so it is
         closed and reopened deliberately, and the reopen carries the cursor. */
      es.addEventListener("bye", () => {
        closeStream();
        if (!stopped && !document.hidden) startStream();
      });

      es.onerror = () => {
        /* `onerror` fires on an ordinary reconnect as well as on a refusal, so
           the state is what tells them apart: CLOSED means the browser has
           given up on this connection. A 401 or a 403 lands here too, which is
           correct — a signed-out manager should stop asking, and the next
           navigation will land him on the sign-in screen. */
        if (es.readyState !== EventSource.CLOSED) return;
        closeStream();
        failures += 1;
        if (failures >= GIVE_UP_AFTER) {
          givenUp = true;
          startPolling();
        } else if (!stopped && !document.hidden) {
          startStream();
        }
      };
    };

    /*
     * A HIDDEN TAB IS TOLD NOTHING AND ASKS FOR NOTHING.
     *
     * The old poll already skipped a backgrounded tab, and a held-open
     * connection is the version of that mistake that lasts for hours: a manager
     * with the Live map in a tab he opened this morning would otherwise be
     * served a query every few seconds all day for a screen nobody is looking
     * at. Coming back reopens with the cursor, so the gap costs one larger
     * delta and nothing else.
     */
    const onVisibility = () => {
      if (document.hidden) {
        closeStream();
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        setMode("connecting");
      } else if (givenUp) {
        startPolling();
      } else {
        startStream();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    if (!document.hidden) {
      if (typeof EventSource === "undefined") startPolling();
      else startStream();
    }

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      closeStream();
      if (pollTimer) clearInterval(pollTimer);
    };
    /* The cadences and the subject of the stream are the whole of what makes
       one connection different from another. Nothing that moves several times
       a minute belongs here: a transport rebuilt on a state change is a
       connection that reconnects for ever and delivers nothing between. */
  }, [day, view, isToday, pollSeconds, pushSeconds, apply]);

  return { frame, mode };
}
