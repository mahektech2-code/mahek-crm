import { metresBetween } from "../geo";

/**
 * A GAP IN THE TRAIL, AND WHETHER A ROAD MAY BE GUESSED ACROSS IT — PURE, no
 * I/O, no key, no network.
 *
 * Where fixes exist the Live map already draws the road: `roadPathFor` hands a
 * dense run to Ola's Snap-to-Road and what comes back hugs the lane. The
 * straight lines left on the map are not failures of that — they are the
 * stretches with NO FIXES AT ALL, cut out by `mbos.location.trailGapMeters`,
 * and `snap-trail/route.ts` has never sent one to Ola. It draws the crow's
 * flight between the two ends and dashes it, which says honestly that nothing
 * is known about the middle.
 *
 * WHAT CHANGED IS THAT A SHORT GAP IS NOT THE SAME KIND OF ABSENCE AS A LONG
 * ONE. A man whose handset went quiet for ninety seconds under a flyover was
 * travelling the whole time and there is very nearly one way he can have got
 * from the fix before to the fix after; drawing that as a line through three
 * blocks of buildings is not honesty, it is a picture nobody can read. A man
 * whose handset was off from lunch until the evening — and the real days on
 * this book carry single gaps of 437, 456, 498 and 999 minutes — could have
 * been anywhere, and a road drawn across that would be an invention with the
 * same shape as a record.
 *
 * SO THIS ENGINE IS THE LINE BETWEEN THE TWO, and it holds the whole of the
 * argument for where that line sits. Nothing here fetches anything: it answers
 * whether a gap may be routed at all, whether the answer that came back is
 * believable, and how to join a routed stretch to the recorded fixes either
 * side of it. The fetching is `ola-directions-service.ts`, and the drawing is
 * the route handler and `street-map.tsx`.
 *
 * AND A ROUTED GAP IS NEVER PROMOTED TO EVIDENCE. It keeps the gap's own
 * dashed, casing-less, half-opacity treatment — the one thing this map must
 * not do is let a guess look like a reading — it says so in words on the
 * hover, and its length is never added to the distance a salesman is measured
 * on. That is enforced in the route handler; it is stated here because this is
 * the file somebody reads when they wonder what the dashed road means.
 */

export type LatLng = { lat: number; lng: number };

/** `[lng, lat]`, GeoJSON's order — what the map's LineString is drawn from. */
export type Coord = [number, number];

/**
 * The ceilings above which a gap is left as an honest straight line.
 *
 * Both are configuration — `mbos.location.gapRouteMaxMinutes` and
 * `mbos.location.gapRouteMaxKm` — and both have to hold. A gap is routable
 * only where the two ends are close enough in TIME and in SPACE that there was
 * never really a choice about what happened in between.
 */
export type GapRouteLimits = {
  maxMinutes: number;
  maxKm: number;
};

export type GapEnds = {
  from: LatLng;
  to: LatLng;
  fromMs: number;
  toMs: number;
};

export type GapVerdict =
  | { route: true; straightMetres: number; minutes: number }
  /**
   * `tooLong` is a stretch of TIME nobody can account for and `tooFar` is a
   * distance; they are named apart because they are different answers to a
   * manager asking why one dashed line follows a road and the one beside it
   * does not, and because a future screen may want to say which.
   */
  | { route: false; why: "tooLong" | "tooFar" | "notAGap"; straightMetres: number; minutes: number };

/**
 * May a road be guessed across this gap?
 *
 * THE TIME CEILING IS THE LOAD-BEARING ONE. At the sampling this app uses a
 * fix arrives every few seconds, so a gap of a few minutes is a tunnel, a lift
 * shaft, a signal shadow or an Android battery manager reaping the tracker
 * mid-ride — in every one of those the man was travelling continuously and the
 * road he took is very nearly determined by its two ends. Past that it stops
 * being determined: given twenty minutes he can have parked, walked somewhere,
 * had a conversation and come back, and the two endpoints would look exactly
 * the same as if he had driven straight between them. A guess drawn there is a
 * guess about a period somebody might be asked to account for, which is the
 * one place on this map a guess must not be drawn.
 *
 * THE DISTANCE CEILING IS THE CHEAP SECOND CHECK. It catches the case the
 * clock cannot: a handset that went quiet in Nagpur and spoke again in Wardha
 * a few minutes later did not travel, it lost and regained a signal across a
 * batch upload, and routing eighty kilometres of highway between two readings
 * minutes apart would draw a journey nobody made.
 *
 * `notAGap` covers the two ends being the same place — a handset that stopped
 * and restarted where it stood. There is no road to draw between a point and
 * itself, and asking for one is a paid request for a line of zero length.
 */
export function gapVerdict(gap: GapEnds, limits: GapRouteLimits): GapVerdict {
  const straightMetres = metresBetween(gap.from.lat, gap.from.lng, gap.to.lat, gap.to.lng);
  const minutes = Math.max(0, gap.toMs - gap.fromMs) / 60_000;

  if (straightMetres <= 0) return { route: false, why: "notAGap", straightMetres, minutes };
  if (minutes > limits.maxMinutes) return { route: false, why: "tooLong", straightMetres, minutes };
  if (straightMetres > limits.maxKm * 1_000) {
    return { route: false, why: "tooFar", straightMetres, minutes };
  }
  return { route: true, straightMetres, minutes };
}

/**
 * Is the road that came back believable as the road he took?
 *
 * A routing engine always answers. Asked for a route across a river with no
 * bridge for fifteen kilometres it returns the fifteen kilometres, perfectly
 * correctly, and drawing that across a ninety-second gap would put a salesman
 * on the far bank of a town he never crossed. The check is the SAME distance
 * ceiling the gap itself was measured against rather than a second number:
 * whatever a reader decided a routable gap may span, a routed answer longer
 * than that is not a stretch this map is willing to assert.
 *
 * A road answer SHORTER than the crow's flight is impossible and means the
 * geometry was misread — refused for the same reason, and by the same rule
 * that the snapped path is refused when it collapses.
 */
export function routeIsBelievable(
  straightMetres: number,
  roadMetres: number,
  limits: GapRouteLimits,
): boolean {
  if (!Number.isFinite(roadMetres) || roadMetres <= 0) return false;
  if (roadMetres > limits.maxKm * 1_000) return false;
  /* A metre of slack: a road that runs exactly along the crow's flight is a
     straight road, and floating-point arithmetic over two spellings of the
     same line must not be what refuses it. */
  return roadMetres >= straightMetres - 1;
}

/**
 * A routed stretch, pinned to the fixes either side of it.
 *
 * Ola routes between the nearest ROAD POINTS to what it was asked about, so
 * the polyline that comes back starts and ends a few metres off the two real
 * fixes — a doorway is not on the carriageway. Drawn as returned, the dashed
 * stretch would neither start where the recorded line stopped nor end where
 * the next one begins, and what is on screen is two small holes at exactly the
 * two places somebody is looking to see whether the line joins up.
 *
 * So the real ends are always the ends. Ola's own first and last points are
 * dropped where they sit within `SEAM_METRES` of them — that is the ordinary
 * case and keeping both would leave a visible stutter of two points a stride
 * apart — and kept otherwise, because where Ola started properly far away that
 * distance is real and hiding it would draw the road as reaching a doorway it
 * does not reach.
 */
const SEAM_METRES = 15;

export function joinGapPath(from: LatLng, to: LatLng, routed: readonly LatLng[]): Coord[] {
  const middle = routed.filter((p, i) => {
    if (i === 0) return metresBetween(p.lat, p.lng, from.lat, from.lng) > SEAM_METRES;
    if (i === routed.length - 1) return metresBetween(p.lat, p.lng, to.lat, to.lng) > SEAM_METRES;
    return true;
  });
  return [
    [from.lng, from.lat],
    ...middle.map((p) => [p.lng, p.lat] as Coord),
    [to.lng, to.lat],
  ];
}

/**
 * Google's encoded-polyline format, which is what Ola answers routes in.
 *
 * It lives in this engine rather than beside the fetch because it is pure and
 * because it is the half that can be WRONG SILENTLY: a decoder off by a factor
 * of ten answers with a well-formed line in the Bay of Bengal, which no type
 * check and no HTTP status will ever notice. Precision 5 is the classic
 * encoding and what Ola's `overview_polyline` uses; the parameter is here so a
 * caller that finds otherwise has somewhere to say so rather than a constant
 * to edit.
 *
 * Malformed input answers with whatever decoded cleanly rather than throwing —
 * the caller's fallback for a short line is the same as for none at all, which
 * is the honest straight gap, and a throw inside a map request is worse than a
 * refusal.
 */
export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    const dLat = decodeValue();
    if (dLat === null) break;
    const dLng = decodeValue();
    if (dLng === null) break;
    lat += dLat;
    lng += dLng;
    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;

  function decodeValue(): number | null {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) return null;
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0) return null;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    /* The low bit is the sign, and the value is inverted rather than negated —
       which is why this is `~(result >> 1)` and not `-(result >> 1)`. */
    return result & 1 ? ~(result >> 1) : result >> 1;
  }
}

/**
 * The length of a decoded route, on the ground.
 *
 * Ola reports a distance of its own and this is deliberately not it: the
 * believability check above compares the GEOMETRY that will be drawn against
 * the straight line, and a figure taken from a different field can agree with
 * a polyline that does not. Measuring what is drawn is the only version of
 * that check that cannot pass on a line nobody would accept.
 */
export function pathMetres(points: readonly LatLng[]): number {
  let metres = 0;
  for (let i = 1; i < points.length; i++) {
    metres += metresBetween(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return metres;
}
