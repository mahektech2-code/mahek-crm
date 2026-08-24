"use client";

import * as React from "react";
import type { ActivityPoint, LastKnown, TrackPoint } from "@/lib/services/sales-service";
import { TeamList } from "./map-canvas";
import { StreetMap } from "./street-map";

/**
 * The map and the list beside it, sharing who is picked.
 *
 * Neither half can hold the selection alone and stay the other's source of
 * truth for it, so it lives here, above both — clicking a name in the list
 * flies the map to them, clicking the same name again gives the map back to
 * the whole team. `page.tsx` keys this whole panel on the day and the view,
 * for the same reason `StreetMap` used to be keyed directly: a change of
 * either is a different map, not a prop the map should react to in place.
 */
export function LivePanel({
  rows,
  tracks,
  activity,
  staleAfterSeconds,
  view,
}: {
  rows: LastKnown[];
  tracks: Map<string, TrackPoint[]>;
  activity: ActivityPoint[];
  staleAfterSeconds: number;
  view: "now" | "today";
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

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
