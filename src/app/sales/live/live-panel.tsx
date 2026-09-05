"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import type { ActivityPoint, LastKnown, TrackPoint } from "@/lib/services/sales-service";
import { TeamList } from "./map-canvas";
import { StreetMap } from "./street-map";

/** How often today's view asks the server for a fresh read while the tab is open. */
const POLL_MS = 30_000;

/**
 * The map and the list beside it, sharing who is picked.
 *
 * Neither half can hold the selection alone and stay the other's source of
 * truth for it, so it lives here, above both — clicking a name in the list
 * flies the map to them, clicking the same name again gives the map back to
 * the whole team. `page.tsx` keys this whole panel on the day and the view,
 * for the same reason `StreetMap` used to be keyed directly: a change of
 * either is a different map, not a prop the map should react to in place.
 *
 * **Today polls; a past day never does.** `router.refresh()` re-runs the
 * Server Component on the same URL, which is the whole point — a manager
 * watching this screen used to see nobody move until they reloaded the page
 * themselves, which for a check-in that had already landed server-side read
 * as "the map is broken" rather than "the map hasn't been asked again yet".
 * A day that already happened has nothing left to arrive, so polling it would
 * be a request every thirty seconds for an answer that cannot change.
 */
export function LivePanel({
  rows,
  tracks,
  activity,
  staleAfterSeconds,
  view,
  isToday,
}: {
  rows: LastKnown[];
  tracks: Map<string, TrackPoint[]>;
  activity: ActivityPoint[];
  staleAfterSeconds: number;
  view: "now" | "today";
  isToday: boolean;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const router = useRouter();

  React.useEffect(() => {
    if (!isToday) return;
    const id = setInterval(() => {
      // A backgrounded tab refreshing every thirty seconds is a request
      // nobody is there to see the answer to.
      if (!document.hidden) router.refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [isToday, router]);

  const toggle = React.useCallback((id: string) => {
    setSelectedId((current) => (current === id ? null : id));
  }, []);

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_clamp(280px,30%,360px)]">
      <StreetMap
        rows={rows}
        tracks={tracks}
        activity={activity}
        staleAfterSeconds={staleAfterSeconds}
        view={view}
        selectedId={selectedId}
      />
      <TeamList rows={rows} selectedId={selectedId} onSelect={toggle} />
    </div>
  );
}
