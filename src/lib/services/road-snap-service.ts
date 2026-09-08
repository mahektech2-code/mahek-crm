import "server-only";
import { readSecret } from "@/lib/secrets";
import { metresBetween } from "@/lib/geo";

/* ---------------------------------------------------------------------------
 * Ola Maps' Snap-to-Road, called for the Live map's trail line only.
 *
 * The raw fixes in `mbos_positions` stay the untouched source of truth — this
 * never writes anything, and is re-derivable from them at any time exactly
 * like every other engine reading in this codebase. What it returns is a
 * second, disposable geometry: the SAME trail laid onto the road network —
 * one snapped point per real fix, never more — for the LINE the map draws,
 * and nothing downstream of a position (the buying-cycle engine, an
 * activity's recorded location, anything) ever reads this — only
 * `street-map.tsx`'s LineString does.
 *
 * `enhancePath` is deliberately never sent. It sounds like the setting a
 * caller wants — a smoother line — and what it actually does is interpolate
 * ola's OWN GUESS at how you would drive between two fixes that are not
 * close together, along roads its routing engine picked rather than roads
 * anybody was seen on: a batch of 50 real fixes came back as 82 points with
 * it set, 50 without. Ordinary sampling gaps make this fire constantly, and
 * what it draws is a plausible-looking detour with the same visual weight as
 * a real fix — a manager reported roads a route had never gone near, and the
 * shape of the trail was reading as a prediction while looking like a
 * record. Without it, Ola still nudges a real fix onto the nearest road —
 * genuine drift correction — but invents no path between two fixes that
 * were never that close; a gap in the real trail stays a straight line
 * between two real points, which is the same honest gap the raw trail
 * already drew.
 *
 * Batched at Ola Maps' own ceiling per request — 50 points, not the 100 the
 * endpoint's own naming suggests. That was found, not read off a spec: every
 * call past the first batch of an ordinary working day's trail came back 400
 * Bad Request with no field named in the answer, `snapToRoad` treats any
 * failure as "nothing to improve" and returns null, and the raw, un-snapped
 * trail is what a manager has always seen as a result — silently, because
 * that fallback is also what a genuine outage looks like. A trail of 51
 * fixes or fewer was never affected, which is short enough that it went
 * unnoticed until a manager asked why a selected trail still cut through
 * buildings.
 *
 * Called for ONE salesman's ONE day at a time, on demand, when a manager
 * selects them on the Live map — never for the whole team on every
 * thirty-second poll, which is what `tracksForDay` answers and what draws
 * the "today" view before anybody has picked a name. Snapping all of that on
 * every poll would multiply into dozens of external calls a tab makes on its
 * own, for lines nobody is looking at yet.
 * ------------------------------------------------------------------------- */

const OLAMAPS_MAX_POINTS_PER_REQUEST = 50;
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
 * One output point per input point, always — see the file header for why
 * `enhancePath` is never sent. Anything else would be Ola's routing engine
 * inventing a path between two fixes rather than relocating a real one.
 *
 * Null covers every way this can fail to help — no key set, fewer than two
 * points to draw a line between, a network error, a non-200, an answer that
 * is not `SUCCESS`. The caller's fallback is always the same: draw the raw
 * trail, which is what the map has always done and never breaks by drawing.
 * A microphone that fails when pressed is worse than one never offered, and
 * the same is true of a map line.
 */
/**
 * The road ACTUALLY TAKEN between a run of fixes, rather than the fixes joined
 * up.
 *
 * `enhancePath` was removed in #251 and this brings it back deliberately and
 * narrowly, because the objection it was removed for is real and is about
 * DISTANCE BETWEEN FIXES rather than about the option: it "invents no path
 * between two fixes that were never that close", and "ordinary sampling gaps
 * make this fire constantly". Both were true of a trail whose fixes could be
 * minutes apart.
 *
 * Two things changed. Fixes are three seconds apart now, so consecutive ones
 * are METRES apart and there is no room between them for a routing engine to
 * pick a road nobody was on. And the caller hands this one confident RUN at a
 * time — `splitTrailByGaps` has already cut the day at every hop long enough
 * to be a real absence, and those stay straight dashed lines drawn from the
 * raw fixes. So the guess is confined to the space between two points a few
 * metres apart, which is not a guess.
 *
 * `downsampleForPath` is what makes it affordable: a day of five thousand
 * fixes is a hundred requests at fifty a batch, and at three-second sampling
 * most of those fixes are within a stride of their neighbour. Thinning to a
 * point every `PATH_ANCHOR_METRES` keeps every corner — the anchors are
 * chosen by distance travelled, so a turn always has one either side of it —
 * and hands Ola the shape rather than the noise.
 *
 * Returns null exactly as `snapToRoad` does, and the caller's fallback is the
 * same: draw the raw fixes, which is what the map has always done.
 */
const PATH_ANCHOR_METRES = 20;

function downsampleForPath(points: LatLng[]): LatLng[] {
  if (points.length <= 2) return points;
  const kept: LatLng[] = [points[0]];
  for (const p of points.slice(1, -1)) {
    const last = kept[kept.length - 1];
    if (metresBetween(last.lat, last.lng, p.lat, p.lng) >= PATH_ANCHOR_METRES) kept.push(p);
  }
  kept.push(points[points.length - 1]);
  return kept;
}

export async function roadPathFor(points: LatLng[]): Promise<LatLng[] | null> {
  return callSnap(downsampleForPath(points), true);
}

export async function snapToRoad(points: LatLng[]): Promise<LatLng[] | null> {
  return callSnap(points, false);
}

async function callSnap(points: LatLng[], enhancePath: boolean): Promise<LatLng[] | null> {
  if (points.length < 2) return null;

  const apiKey = await readSecret("olamaps.apiKey");
  if (!apiKey) return null;

  const snapped: LatLng[] = [];

  /*
   * BATCHES OVERLAP BY ONE POINT, and that one point is the whole join.
   *
   * They used to be cut edge to edge — `slice(i, i + 50)`, then 50 to 100 —
   * so Ola was asked to snap two halves of one walk with no knowledge of each
   * other. Each half is snapped correctly and they meet at nothing: the last
   * point of one and the first of the next are different fixes on different
   * sides of a corner, and what lands on the map is a notch, a little hook
   * past the turn, or a step sideways in the middle of a straight road. It
   * looks exactly like a bug in the line and is really a bug in the seam.
   *
   * Sharing the boundary point means both requests see it, both snap it to
   * the same place, and the second batch drops its copy — so the two halves
   * are joined at a point they agree on rather than butted together at two
   * they never compared.
   */
  const step = OLAMAPS_MAX_POINTS_PER_REQUEST - 1;

  for (let i = 0; i < points.length; i += step) {
    const batch = points.slice(i, i + OLAMAPS_MAX_POINTS_PER_REQUEST);
    if (i > 0 && batch.length < 2) break;
    if (batch.length < 2) {
      // A final batch of one point cannot be snapped on its own; carried
      // through raw rather than dropped, so the line still reaches its end.
      snapped.push(batch[0]);
      continue;
    }

    const path = batch.map((p) => `${p.lat},${p.lng}`).join("|");
    const url =
      `${SNAP_URL}?points=${encodeURIComponent(path)}&api_key=${encodeURIComponent(apiKey)}` +
      (enhancePath ? "&enhancePath=true" : "");

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

    /* The first point of every batch after the first is the previous batch's
       last, already in `snapped`. */
    const fresh = i > 0 ? body.snapped_points.slice(1) : body.snapped_points;
    for (const sp of fresh) snapped.push({ lat: sp.location.lat, lng: sp.location.lng });

    if (i + OLAMAPS_MAX_POINTS_PER_REQUEST >= points.length) break;
  }

  return snapped;
}
