import "server-only";
import { readSecret } from "@/lib/secrets";

/* ---------------------------------------------------------------------------
 * Ola Maps' Snap-to-Road, called for the Live map's trail line only.
 *
 * The raw fixes in `mbos_positions` stay the untouched source of truth — this
 * never writes anything, and is re-derivable from them at any time exactly
 * like every other engine reading in this codebase. What it returns is a
 * second, disposable geometry: the same trail laid onto the road network,
 * for the LINE the map draws, and nothing downstream of a position (the
 * buying-cycle engine, an activity's recorded location, anything) ever reads
 * this — only `street-map.tsx`'s LineString does.
 *
 * Batched at Ola Maps' own 100-point ceiling per request. Called for ONE
 * salesman's ONE day at a time, on demand, when a manager selects them on the
 * Live map — never for the whole team on every thirty-second poll, which is
 * what `tracksForDay` answers and what draws the "today" view before anybody
 * has picked a name. Snapping all of that on every poll would multiply into
 * dozens of external calls a tab makes on its own, for lines nobody is
 * looking at yet.
 * ------------------------------------------------------------------------- */

const OLAMAPS_MAX_POINTS_PER_REQUEST = 100;
const SNAP_URL = "https://api.olamaps.io/routing/v1/snapToRoad";
const REQUEST_TIMEOUT_MS = 8_000;

export type LatLng = { lat: number; lng: number };

type OlaMapsSnapResponse = {
  status?: string;
  snapped_points?: { location: { lat: number; lng: number } }[];
};

/**
 * Snaps a trail onto the road network, or returns null.
 *
 * Null covers every way this can fail to help — no key set, fewer than two
 * points to draw a line between, a network error, a non-200, an answer that
 * is not `SUCCESS`. The caller's fallback is always the same: draw the raw
 * trail, which is what the map has always done and never breaks by drawing.
 * A microphone that fails when pressed is worse than one never offered, and
 * the same is true of a map line.
 */
export async function snapToRoad(points: LatLng[]): Promise<LatLng[] | null> {
  if (points.length < 2) return null;

  const apiKey = await readSecret("olamaps.apiKey");
  if (!apiKey) return null;

  const snapped: LatLng[] = [];

  for (let i = 0; i < points.length; i += OLAMAPS_MAX_POINTS_PER_REQUEST) {
    const batch = points.slice(i, i + OLAMAPS_MAX_POINTS_PER_REQUEST);
    if (batch.length < 2) {
      // A final batch of one point cannot be snapped on its own; carried
      // through raw rather than dropped, so the line still reaches its end.
      snapped.push(batch[0]);
      continue;
    }

    const path = batch.map((p) => `${p.lat},${p.lng}`).join("|");
    const url = `${SNAP_URL}?points=${encodeURIComponent(path)}&enhancePath=true&api_key=${encodeURIComponent(apiKey)}`;

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      return null;
    }
    if (!response.ok) return null;

    let body: OlaMapsSnapResponse;
    try {
      body = (await response.json()) as OlaMapsSnapResponse;
    } catch {
      return null;
    }
    if (body.status !== "SUCCESS" || !body.snapped_points?.length) return null;

    for (const sp of body.snapped_points) snapped.push({ lat: sp.location.lat, lng: sp.location.lng });
  }

  return snapped;
}
