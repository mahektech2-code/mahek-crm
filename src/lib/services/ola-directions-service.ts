import "server-only";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { readSecret } from "@/lib/secrets";
import { legKey, type LatLng } from "@/lib/road-legs";
import { decodePolyline } from "@/lib/engines/trail-gap-route";

/* ---------------------------------------------------------------------------
 * Ola Maps' Directions — the ROAD BETWEEN two points, as a drawable line.
 *
 * The third Ola caller here and the only one that answers with a GEOMETRY.
 * `road-snap-service.ts` relocates fixes somebody actually produced onto the
 * lane they were produced on; `ola-distance-service.ts` answers how far apart
 * two places are and says nothing about the shape between them. Neither can
 * draw a road across a stretch with no fixes in it, which is what the Live
 * map's dashed gaps are.
 *
 * WHAT COMES BACK IS A GUESS AND THIS FILE NEVER PRETENDS OTHERWISE. Ola
 * answers the route its engine would recommend, not the route anybody took.
 * `trail-gap-route.ts` holds the rules about when that guess is close enough to
 * determined to be worth drawing, and the route handler draws it dashed and
 * says so in words. Nothing here decides any of that: it fetches, it caches,
 * and every failure is a null.
 *
 * EVERY FAILURE IS A NULL — no key, a timeout, a non-200, a status that is not
 * SUCCESS, a polyline that decodes to fewer than two points. The caller's
 * fallback is the straight dashed line the map has drawn since the day it
 * shipped, which is also exactly what an outage looks like. That is the shape
 * both neighbours use and for the same reason: a map line that fails when
 * asked is worse than one never offered.
 *
 * COST, which is the reason the cache exists rather than an optimisation on
 * top of it. Ola's tier here is 100,000 requests a month and Snap-to-Road is
 * already spending it. A gap's two ends NEVER CHANGE once the day is past —
 * the fixes either side of it are written and done — so the same gap asked
 * about a second time is the same answer, and the answers recur across days
 * too: the stretch from a man's house to the first shop of the morning is the
 * same two endpoints every morning of the week. Keyed on the rounded
 * coordinate pair exactly as `road_legs` is, so a fix taken eleven metres from
 * yesterday's is not a fresh bill.
 * ------------------------------------------------------------------------- */

const DIRECTIONS_URL = "https://api.olamaps.io/routing/v1/directions";
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * How long a cached route is trusted.
 *
 * The same ninety days `road_legs` keeps, for the same reason and deliberately
 * the same number: roads change slowly, and a geometry nobody ever re-fetches
 * is one that cannot be corrected when a flyover opens.
 */
const CACHE_TTL_DAYS = 90;

export type RoadRoute = {
  /** In Ola's order — `{lat, lng}`. The engine turns it round for the map. */
  path: LatLng[];
  /** Ola's own figure, kept for a reader; the engine measures the geometry. */
  metres: number;
};

type DirectionsResponse = {
  status?: string;
  routes?: {
    overview_polyline?: string | { points?: string };
    legs?: { distance?: number | { value?: number } }[];
  }[];
};

/**
 * The road from one point to another, from the cache and then from Ola.
 *
 * Null is every kind of no — see the header. A caller must never read null as
 * "there is no road there": it means only that this map has nothing better to
 * draw than the line it already drew.
 */
export async function roadRouteBetween(from: LatLng, to: LatLng): Promise<RoadRoute | null> {
  const fromKey = legKey(from);
  const toKey = legKey(to);
  /* A point and itself round to one key. There is no road to ask for, and
     asking would be a paid request for a line of zero length. */
  if (fromKey === toKey) return null;

  const cached = await readCached(fromKey, toKey);
  if (cached) return cached;

  const apiKey = await readSecret("olamaps.apiKey");
  if (!apiKey) return null;

  const params = new URLSearchParams({
    origin: `${from.lat},${from.lng}`,
    destination: `${to.lat},${to.lng}`,
    api_key: apiKey,
  });

  let body: DirectionsResponse;
  try {
    /* POST WITH NO BODY, which is how this endpoint is specified — everything
       it takes rides in the query string. It reads like a mistake and is not;
       a GET here answers 405. */
    const response = await fetch(`${DIRECTIONS_URL}?${params}`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    body = (await response.json()) as DirectionsResponse;
  } catch {
    return null;
  }

  if (body.status && body.status !== "SUCCESS") return null;
  const route = body.routes?.[0];
  if (!route) return null;

  /* Two spellings in the wild — a bare string, and Google's `{points}` object
     that several engines copy. Reading both costs a line and saves a silent
     null on a deployment where the answer changed shape. */
  const encoded =
    typeof route.overview_polyline === "string"
      ? route.overview_polyline
      : route.overview_polyline?.points;
  if (!encoded) return null;

  const path = decodePolyline(encoded);
  /* A line of one point is not a line. The caller's fallback is the straight
     one, which is better than a dashed dot. */
  if (path.length < 2) return null;

  const metres = legMetres(route);
  const answer = { path, metres };
  await writeRoute(fromKey, toKey, encoded, metres);
  return answer;
}

/**
 * The distance Ola puts on the route, in metres, in either of its two shapes.
 *
 * Zero where it said nothing. That is not a failure — the believability check
 * measures the DRAWN GEOMETRY rather than this, deliberately, because a figure
 * from one field can agree with a polyline from another and still describe a
 * different road. This is carried for a reader, not for a decision.
 */
function legMetres(route: NonNullable<DirectionsResponse["routes"]>[number]): number {
  let metres = 0;
  for (const leg of route.legs ?? []) {
    const d = typeof leg.distance === "number" ? leg.distance : leg.distance?.value;
    if (typeof d === "number" && Number.isFinite(d)) metres += d;
  }
  return Math.round(metres);
}

async function readCached(fromKey: string, toKey: string): Promise<RoadRoute | null> {
  try {
    const rows = await db.execute<{ polyline: string; metres: number }>(sql`
      select polyline, metres
        from trail_gap_routes
       where from_key = ${fromKey}
         and to_key = ${toKey}
         and fetched_at > now() - ${`${CACHE_TTL_DAYS} days`}::interval
       limit 1
    `);
    const row = (rows as unknown as { polyline: string; metres: number }[])[0];
    if (!row) return null;
    const path = decodePolyline(row.polyline);
    if (path.length < 2) return null;
    return { path, metres: row.metres };
  } catch {
    /* A cache that cannot be read is a cache miss, never a failed map. */
    return null;
  }
}

/**
 * Written after the answer is in hand, and never allowed to fail it.
 *
 * The route is already paid for and already correct; a write error costs one
 * repeated request tomorrow and must not cost the line on the screen today.
 * The POLYLINE is stored rather than the decoded points: it is what Ola sent,
 * it is a tenth of the size, and re-decoding it on read means the decoder is
 * exercised by every cache hit rather than only by a fresh fetch.
 */
async function writeRoute(
  fromKey: string,
  toKey: string,
  polyline: string,
  metres: number,
): Promise<void> {
  try {
    await db.execute(sql`
      insert into trail_gap_routes (id, from_key, to_key, polyline, metres, fetched_at)
      values (${`gr_${randomUUID().slice(0, 12)}`}, ${fromKey}, ${toKey}, ${polyline}, ${metres}, now())
      on conflict (from_key, to_key) do update
        set polyline = excluded.polyline,
            metres = excluded.metres,
            fetched_at = excluded.fetched_at
    `);
  } catch {
    /* Nothing lost — the route is in the answer. */
  }
}
