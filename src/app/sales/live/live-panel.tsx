"use client";

import * as React from "react";
import { dwellStops, type DwellStop } from "@/lib/engines/dwell";
import { trailMetres } from "@/lib/engines/trail-trips";
import type { ActivityPoint, LastKnown, TrackPoint } from "@/lib/services/sales-service";
import type { HandsetThresholds } from "@/lib/handset-health";
import { TeamList } from "./map-canvas";
import { StreetMap } from "./street-map";
import { useLiveFeed, type LiveMode } from "./use-live-feed";

/**
 * How often the "how long ago" sentences on the team panel are recomputed.
 *
 * `nowMs` used to arrive from the server on every poll, so the clock those
 * sentences are measured against moved because the whole page was re-rendered.
 * Nothing re-renders the page now, and a screen that says "quiet for 4 min" for
 * the rest of the afternoon is worse than one that never said it. Thirty
 * seconds because every threshold it feeds is in minutes — a finer tick would
 * repaint the panel to change nothing. It is not configuration: it changes no
 * figure, only when a figure catches up with itself.
 */
const CLOCK_TICK_MS = 30_000;

/**
 * The map and the list beside it, sharing who is picked — and now sharing the
 * feed that keeps them both current.
 *
 * Neither half can hold the selection alone and stay the other's source of
 * truth for it, so it lives here, above both — clicking a name in the list
 * flies the map to them, clicking the same name again gives the map back to
 * the whole team. `page.tsx` keys this whole panel on the day and the view,
 * for the same reason `StreetMap` is keyed: a change of either is a different
 * map, not a prop the map should react to in place.
 *
 * **IT IS TOLD NOW, RATHER THAN ASKING.** This used to run `router.refresh()`
 * every thirty seconds, which re-ran the whole Server Component — every
 * salesman's trail, every mark on it, the team read, and a serialisation of all
 * of it — whether or not one fix had arrived. Handsets upload every few
 * seconds, so that poll had become the binding constraint on the word "live": a
 * pin could be half a minute behind the phone however fast the phone sent. A
 * connection stays open instead and the server pushes what has arrived; see
 * `use-live-feed.ts` for the transport and `api/sales/live/stream` for why it
 * is Server-Sent Events and how the scope is kept honest on a request that
 * outlives the moment it was made.
 *
 * **A past day never subscribes.** It has nothing left to arrive, so the feed
 * settles and this is exactly the component it was before.
 *
 * **What the map is HANDED is what changes, and nothing else.** The props
 * below are the same props they always were — the difference is that they now
 * change during the life of the mount rather than only at first paint. That is
 * `StreetMap`'s business and deliberately not this file's: it redraws into the
 * sources it already has when the data it is handed moves, so nothing here
 * reaches into a map or rebuilds one. Handing it fresh data is the whole of
 * this component's part in it.
 *
 * **The derived halves are recomputed HERE, from the merged trail.** `page.tsx`
 * used to work out the distance and the dwell stops on the server, once per
 * poll, and there is no poll any more. Both are pure engines — `trailMetres`
 * and `dwellStops` — so the browser runs the same two functions over the same
 * points and gets the same answers; deriving them on the server would mean the
 * line grew while the figure beside it did not, which is the frozen-map bug in
 * a different costume.
 */
export function LivePanel({
  day,
  rows,
  tracks,
  activity,
  gapMetres,
  dwellRadiusMetres,
  dwellMinMinutes,
  tripBreakMinutes,
  staleAfterSeconds,
  view,
  isToday,
  olaMapsKey,
  olaKeysSpent,
  handsetThresholds,
  nowMs,
  cursorMs,
  pushSeconds,
  pollSeconds,
}: {
  day: string;
  rows: LastKnown[];
  tracks: Map<string, TrackPoint[]>;
  activity: ActivityPoint[];
  /** Metres apart before a hop is drawn as an honest gap — see `trail-gaps.ts`. */
  gapMetres: number;
  dwellRadiusMetres: number;
  dwellMinMinutes: number;
  tripBreakMinutes: number;
  staleAfterSeconds: number;
  view: "now" | "today";
  isToday: boolean;
  /** What the Live map calls quiet and calls low — both configuration. */
  handsetThresholds: HandsetThresholds;
  /** Read on the server: the clock may not be read during render. */
  nowMs: number;
  /**
   * The server's own clock as the props above were read, and the point the feed
   * carries on from. It is the SERVER's — a browser a few minutes fast would
   * otherwise skip every fix that landed in the gap.
   */
  cursorMs: number;
  pushSeconds: number;
  pollSeconds: number;
  /** Read once, server-side, in `page.tsx` — see `street-map.tsx`'s doc comment. */
  olaMapsKey: string | null;
  /** With no key: whether every key held has run out, or none is set at all. */
  olaKeysSpent: boolean;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const { frame, mode } = useLiveFeed({
    day,
    view,
    isToday,
    initial: { rows, tracks, activity, cursorMs },
    pushSeconds,
    pollSeconds,
  });

  /*
   * The clock the team panel measures its silences against.
   *
   * Read in an interval and never during render — the React Compiler rules this
   * codebase runs under forbid the second, and it is the right rule here for an
   * ordinary reason too: a component that read `Date.now()` as it drew would
   * produce a different answer on every unrelated repaint.
   */
  const [clockMs, setClockMs] = React.useState(nowMs);
  React.useEffect(() => {
    if (!isToday) return;
    const id = setInterval(() => setClockMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [isToday]);

  /* Recomputed only when the trail actually moved: `mergeLiveDelta` hands back
     the same Map where a tick brought nothing, which is what makes this cheap
     enough to sit in a component that also redraws on a selection click. */
  const derived = React.useMemo(() => {
    const distanceMetres = new Map<string, number>();
    const dwells = new Map<string, DwellStop[]>();
    for (const [id, points] of frame.tracks) {
      /* ONE DEFINITION, shared with the line the map draws — see `trailMetres`. */
      distanceMetres.set(id, trailMetres(points));
      dwells.set(id, dwellStops(points, dwellRadiusMetres, dwellMinMinutes));
    }
    return { distanceMetres, dwells };
  }, [frame.tracks, dwellRadiusMetres, dwellMinMinutes]);

  const toggle = React.useCallback((id: string) => {
    setSelectedId((current) => (current === id ? null : id));
  }, []);

  /*
   * FULL SCREEN IS A LAYOUT AND NOT A BROWSER MODE.
   *
   * The browser's own fullscreen would take the tab bar with it, which is more
   * than anybody asked for, and it owns the Escape key — so the shop record a
   * pin opens could not be closed with Escape without also throwing the map out
   * of fullscreen. This gives the map the window instead: the whole panel goes
   * fixed, the map fills it and the team list stays beside it, because the
   * point of the screen is still which salesman, and a map you cannot pick a
   * name on is a picture. It lives HERE rather than in the map for the same
   * reason the selection does — both halves are laid out by this component,
   * and neither can own a fact the other has to read.
   */
  const [fullscreen, setFullscreen] = React.useState(false);

  React.useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      /* The shop record drawer closes on Escape itself, and it is drawn ABOVE
         the fullscreen panel — so Escape with one open means "close the thing
         on top", not "give the window back". Leaving both to fire would close
         a drawer and drop the map out of fullscreen in one keystroke, which is
         a control nobody can aim. */
      if (document.querySelector('[role="dialog"]')) return;
      setFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-50 grid grid-cols-1 gap-3 bg-canvas p-3 lg:grid-cols-[minmax(0,1fr)_clamp(280px,30%,360px)]"
          : "grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_clamp(280px,30%,360px)]"
      }
    >
      <StreetMap
        day={day}
        rows={frame.rows}
        tracks={frame.tracks}
        activity={frame.activity}
        dwells={derived.dwells}
        gapMetres={gapMetres}
        dwellRadiusMetres={dwellRadiusMetres}
        tripBreakMinutes={tripBreakMinutes}
        staleAfterSeconds={staleAfterSeconds}
        view={view}
        fullscreen={fullscreen}
        onToggleFullscreen={() => setFullscreen((on) => !on)}
        selectedId={selectedId}
        apiKey={olaMapsKey}
        keysSpent={olaKeysSpent}
      />
      {/* The list scrolls WITHIN the window in fullscreen rather than pushing
          the page down: the panel is fixed to the viewport, so anything taller
          than it would simply be unreachable. `min-h-0` is what lets a grid
          child shrink enough to scroll at all. */}
      <div className={"flex flex-col gap-2 " + (fullscreen ? "min-h-0 overflow-y-auto" : "")}>
        {isToday ? <FeedMode mode={mode} pollSeconds={pollSeconds} /> : null}
        <TeamList
          rows={frame.rows}
          distanceMetres={view === "today" ? derived.distanceMetres : null}
          selectedId={selectedId}
          onSelect={toggle}
          thresholds={handsetThresholds}
          nowMs={clockMs}
          isToday={isToday}
        />
      </div>
    </div>
  );
}

/**
 * WHICH OF THE TWO THIS SCREEN IS DOING, said in one line.
 *
 * A map claiming to be live and a map that has quietly stopped look identical,
 * which is the failure the whole change was made to end — so swapping a silent
 * poll for a silent stream would have been no gain. There are exactly three
 * things worth saying and none of them is a green tick on a healthy screen: the
 * discipline the team panel already keeps is that a row with nothing wrong says
 * nothing at all, so "live" is drawn as quietly as possible and the two states
 * that are NOT live are the ones that carry words.
 */
function FeedMode({ mode, pollSeconds }: { mode: LiveMode; pollSeconds: number }) {
  if (mode === "settled") return null;
  if (mode === "live") {
    return (
      <p className="flex items-center gap-1.5 px-1 text-[12px] text-muted">
        <span className="block size-1.5 flex-none rounded-full bg-[#1D7A45]" />
        Live — positions arrive as the handsets send them.
      </p>
    );
  }
  if (mode === "connecting") {
    return <p className="px-1 text-[12px] text-muted">Connecting to the live feed…</p>;
  }
  return (
    <p className="px-1 text-[12px] text-[#8A5A00]">
      The live connection could not be held open here, so this screen is asking every{" "}
      {pollSeconds} seconds instead. Everything below is still current to within that.
    </p>
  );
}
