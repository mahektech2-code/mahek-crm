import "server-only";
import { olaGet } from "@/lib/services/ola-key-service";
import {
  downsampleForPath,
  OLA_MAX_POINTS_PER_REQUEST as OLAMAPS_MAX_POINTS_PER_REQUEST,
  type LatLng,
} from "@/lib/engines/snap-plan";

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
 * `enhancePath` IS SENT BY ONE OF THE TWO ENTRY POINTS AND NOT BY THE OTHER,
 * and this paragraph said "never" for both long after that stopped being true.
 * `snapToRoad` does not send it: it relocates a real fix onto the nearest road
 * and invents nothing between two fixes, so it answers one point per point.
 * `roadPathFor` DOES send it, deliberately and narrowly — see its own note for
 * the argument, which is that fixes three seconds apart have no room between
 * them for a routing engine to pick a road nobody was on, and that the caller
 * hands it one confident run at a time with every real absence already cut out
 * as a gap. Its answer has as many points as the road has corners.
 *
 * The objection the option was removed for in #251 stands where it applied: a
 * batch of 50 real fixes minutes apart came back as 82 points with it set, and
 * what it drew between the distant ones was a plausible detour carrying the
 * same visual weight as a record. That is why it is not simply switched on for
 * both, and why a caller reaching for it has to be able to say why the space
 * it is guessing across is too small to guess in.
 *
 * A FAILED BATCH COSTS ITS OWN POINTS AND NOT THE DAY'S. One bad request used
 * to return null for the WHOLE path, so a single 400 near the end of a long
 * walk threw away every batch that had already come back correctly and the
 * manager saw the raw line for all of it. What a failure means is "this stretch
 * could not be improved", which is a statement about that stretch: its own raw
 * points are carried through in place of the snapped ones and the rest of the
 * line keeps its road. Null is still the answer where NOTHING was improved, so
 * the caller's old fallback is untouched — an outage, a missing key and a path
 * too short to snap all behave exactly as they did.
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

const SNAP_URL = "https://api.olamaps.io/routing/v1/snapToRoad";
const REQUEST_TIMEOUT_MS = 8_000;

export type { LatLng };

type OlaMapsSnapResponse = {
  status?: string;
  snapped_points?: { location: { lat: number; lng: number } }[];
};

/**
 * Snaps a trail onto the road network, or returns null.
 *
 * One output point per input point, always: this entry point does not send
 * `enhancePath`, so nothing here is Ola's routing engine inventing a path
 * between two fixes rather than relocating a real one.
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
export async function roadPathFor(points: LatLng[]): Promise<LatLng[] | null> {
  return callSnap(downsampleForPath(points), true);
}

/**
 * THE SAME ROAD, ASKED ABOUT ONLY WHERE IT IS NEW.
 *
 * A day grows at one end. The first eight hours of a trail have not changed
 * since the last time Ola was asked about them, and asking again buys back a
 * road we already hold — while the two minutes of walking since is one
 * request's worth. Snap-to-Road is metered, and re-buying a whole day on every
 * look is what takes one manager watching the Live map past a month's quota on
 * his own. `lib/engines/snap-plan.ts` decides what is new; this fetches it.
 *
 * `seam` IS THE JOIN and is not part of the answer. It is the last raw fix the
 * held path already reaches, sent again here as the first point — so both the
 * held head and this tail are told about one point in common, both snap it to
 * the same place, and this drops its copy on the way out. That is the same
 * answer `callSnap` gives between two batches of one request, and for the same
 * reason: two independently-snapped halves meet at nothing, and what lands on
 * the map is a notch or a little hook past the corner.
 *
 * `enhancePath` means the answer is NOT one point per point — it has as many
 * points as the road has corners — so nothing here may pair it back up with
 * the input by index. Dropping the FIRST point is index-free and is the only
 * positional assumption made: Ola answers in the order it was asked, so the
 * first point out is the first point in, however many follow it.
 *
 * Null exactly as `roadPathFor` answers null, and the caller's fallback is the
 * same: keep the head and draw the new tail raw. A held head is never thrown
 * away because a tail could not be bought.
 */
export async function roadPathTail(
  seam: LatLng,
  tail: LatLng[],
): Promise<LatLng[] | null> {
  const path = await callSnap(downsampleForPath([seam, ...tail]), true);
  if (!path || path.length < 2) return null;
  return path.slice(1);
}

export async function snapToRoad(points: LatLng[]): Promise<LatLng[] | null> {
  return callSnap(points, false);
}

async function callSnap(points: LatLng[], enhancePath: boolean): Promise<LatLng[] | null> {
  if (points.length < 2) return null;

  /* No key is not read for here any more. `olaGet` answers null without asking
     Ola where there is nothing to ask with, so every batch fails the same way
     and `improved` stays false — the identical answer this gave when it read
     the secret itself. */
  const snapped: LatLng[] = [];
  /* Whether ANY batch came back from Ola. See the return below for why. */
  let improved = false;

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

    const onRoad = await snapBatch(batch, enhancePath);
    if (onRoad) improved = true;

    /* The first point of every batch after the first is the previous batch's
       last, already in `snapped` — true of a failed batch too, since its raw
       points carry the same boundary. */
    const fresh = (onRoad ?? batch).slice(i > 0 ? 1 : 0);
    for (const p of fresh) snapped.push(p);

    if (i + OLAMAPS_MAX_POINTS_PER_REQUEST >= points.length) break;
  }

  /* Nothing anywhere on this path could be improved, so there is nothing to
     answer with: the caller draws the raw trail, which is what `snapped` would
     now be a copy of. Saying so plainly is what keeps "a network outage" and
     "a line we bettered" distinguishable to whoever reads the answer. */
  if (!improved) return null;

  return snapped;
}

/**
 * One request's worth, snapped — or null where that stretch could not be.
 *
 * Every way this can fail is the same fact about the same stretch of road and
 * says nothing about the batch before or after it, which is why it is answered
 * here rather than thrown up to abandon the whole path.
 */
async function snapBatch(batch: LatLng[], enhancePath: boolean): Promise<LatLng[] | null> {
  const path = batch.map((p) => `${p.lat},${p.lng}`).join("|");

  /* WHICH KEY THIS IS SPENT ON is `olaGet`'s to decide, and so is what to do
     when Ola says that account has run out — see
     `services/ola-key-service.ts`. What this file does with a failure is
     unchanged, and it is per BATCH: null for this stretch, its own raw points
     carried through, and the rest of the line keeps its road. */
  const body = await olaGet<OlaMapsSnapResponse>(
    (apiKey) =>
      `${SNAP_URL}?points=${encodeURIComponent(path)}&api_key=${encodeURIComponent(apiKey)}` +
      (enhancePath ? "&enhancePath=true" : ""),
    REQUEST_TIMEOUT_MS,
  );
  if (!body || body.status !== "SUCCESS" || !body.snapped_points?.length) return null;

  return body.snapped_points.map((sp) => ({ lat: sp.location.lat, lng: sp.location.lng }));
}
