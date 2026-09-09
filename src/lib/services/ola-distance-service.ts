import "server-only";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { readSecret } from "@/lib/secrets";
import { batchMatrix, legKey, pairKey, type LatLng } from "@/lib/road-legs";

/* ---------------------------------------------------------------------------
 * Ola Maps' Distance Matrix — road metres and driving seconds between points.
 *
 * The route engine is straight-line by design and its own comment defends
 * that: the phone is offline in a market lane and a route that arrives beats
 * one that is optimal. That holds for ORDERING stops and fails for BUDGETING a
 * day. Mumbai to Pune is 141 km by road against about 120 in a straight line,
 * and inside a city beat the gap is proportionally worse because every lane
 * bends — a day planned on straight-line minutes runs out of hours, which is
 * the one planning error that costs a salesman his evening.
 *
 * SO THE SERVER ASKS, NEVER THE HANDSET. This is the whole architecture of it.
 * The phone has no connection to spend and no key to spend it with; it goes on
 * ordering stops with its own pure engine and shows road figures only where
 * they arrived through the ordinary pull. A day is walkable the moment it is
 * picked and sharpens when there is signal. Nothing on the phone ever waits.
 *
 * EVERY FAILURE IS AN ABSENT LEG, never a thrown error and never a zero. No
 * key, a timeout, a 400, an answer that is not SUCCESS — all of them leave the
 * pair out of the returned map, and the caller falls back to the straight line
 * it has always drawn. That is the same shape `snapToRoad` uses next door, and
 * for the same reason: a map line that fails when asked is worse than one
 * never offered.
 *
 * COST. The ceiling is 50 elements per request, origins × destinations, and it
 * was found rather than read off a spec — see `road-legs.ts` for the
 * measurements. A day of 25 stops is 13 requests; two salesmen planning 25
 * days a month is about 650 against a free tier of 100,000. The cache is what
 * keeps it there over time: a beat is walked again and again, and the second
 * plan of the same shops costs nothing.
 * ------------------------------------------------------------------------- */

const MATRIX_URL = "https://api.olamaps.io/routing/v1/distanceMatrix";
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * How long a cached leg is trusted.
 *
 * Roads change slowly and a shop does not move, so this is long. It is not
 * forever because a new flyover or a closed lane genuinely changes a beat, and
 * a figure nobody ever re-checks is one nobody can correct.
 */
const CACHE_TTL_DAYS = 90;

export type RoadLeg = { metres: number; seconds: number };

type MatrixResponse = {
  status?: string;
  rows?: { elements?: { distance?: number; duration?: number; status?: string }[] }[];
};

/**
 * Road legs for a rectangle of points, from the cache and then from Ola.
 *
 * The returned map is keyed by `pairKey`. A pair that is absent has no road
 * answer and the caller must use its own straight-line one — absence is the
 * signal, so no caller can mistake a failure for a zero-length leg.
 *
 * `budget` caps how many requests one call may spend. It exists because this
 * runs on a schedule as well as on a click: a job handed a thousand shops
 * should not empty a month's free tier in one pass, and a caller that wants
 * everything can ask again tomorrow with the cache already half full.
 */
export async function roadLegs(
  origins: readonly LatLng[],
  destinations: readonly LatLng[],
  budget = 40,
): Promise<Map<string, RoadLeg>> {
  const out = new Map<string, RoadLeg>();
  if (!origins.length || !destinations.length) return out;

  /* ------------------------------------------------------------ the cache */
  const keys = new Set<string>();
  for (const o of origins) for (const d of destinations) keys.add(pairKey(o, d));

  const cached = await db.execute<{ fromKey: string; toKey: string; metres: number; seconds: number }>(sql`
    select from_key as "fromKey", to_key as "toKey", metres, seconds
      from road_legs
     where fetched_at > now() - ${`${CACHE_TTL_DAYS} days`}::interval
  `);
  for (const row of cached as unknown as { fromKey: string; toKey: string; metres: number; seconds: number }[]) {
    const key = `${row.fromKey}>${row.toKey}`;
    if (keys.has(key)) out.set(key, { metres: row.metres, seconds: row.seconds });
  }

  /* Anything still wanted. A point whose every leg is cached is dropped from
     the rectangle entirely, which is what makes the second plan of a beat free
     rather than merely cheap. */
  const wantedOrigins = origins.filter((o) =>
    destinations.some((d) => legKey(o) !== legKey(d) && !out.has(pairKey(o, d))),
  );
  const wantedDestinations = destinations.filter((d) =>
    wantedOrigins.some((o) => legKey(o) !== legKey(d) && !out.has(pairKey(o, d))),
  );
  if (!wantedOrigins.length || !wantedDestinations.length) return out;

  const apiKey = await readSecret("olamaps.apiKey");
  if (!apiKey) return out;

  /* -------------------------------------------------------------- and Ola */
  const batches = batchMatrix(wantedOrigins, wantedDestinations).slice(0, budget);
  const fresh: { fromKey: string; toKey: string; metres: number; seconds: number }[] = [];

  for (const batch of batches) {
    const params = new URLSearchParams({
      origins: batch.origins.map((p) => `${p.lat},${p.lng}`).join("|"),
      destinations: batch.destinations.map((p) => `${p.lat},${p.lng}`).join("|"),
      api_key: apiKey,
    });

    let body: MatrixResponse;
    try {
      const response = await fetch(`${MATRIX_URL}?${params}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      body = (await response.json()) as MatrixResponse;
    } catch {
      /* One bad batch is some missing legs, not a failed plan. The rest of the
         rectangle is still worth having. */
      continue;
    }
    if (!body.rows?.length) continue;

    body.rows.forEach((row, i) => {
      const origin = batch.origins[i];
      if (!origin) return;
      row.elements?.forEach((el, j) => {
        const destination = batch.destinations[j];
        if (!destination) return;
        /* A per-element status that is not OK is a leg Ola could not route —
           an island, a point in the sea. Absent, like every other failure. */
        if (el.status && el.status !== "OK") return;
        if (typeof el.distance !== "number" || typeof el.duration !== "number") return;
        if (legKey(origin) === legKey(destination)) return;

        const leg = { metres: Math.round(el.distance), seconds: Math.round(el.duration) };
        out.set(pairKey(origin, destination), leg);
        fresh.push({ fromKey: legKey(origin), toKey: legKey(destination), ...leg });
      });
    });
  }

  if (fresh.length) await writeLegs(fresh);
  return out;
}

/**
 * Written after the answer is already in hand, and never allowed to fail it.
 *
 * The cache is an optimisation; a plan that could not be saved is still a
 * correct plan. A write error here must not throw away figures the caller has
 * already paid Ola for.
 */
async function writeLegs(
  legs: { fromKey: string; toKey: string; metres: number; seconds: number }[],
): Promise<void> {
  try {
    const values = sql.join(
      legs.map(
        (l) =>
          sql`(${`rl_${randomUUID().slice(0, 12)}`}, ${l.fromKey}, ${l.toKey}, ${l.metres}, ${l.seconds}, now())`,
      ),
      sql`, `,
    );
    await db.execute(sql`
      insert into road_legs (id, from_key, to_key, metres, seconds, fetched_at)
      values ${values}
      on conflict (from_key, to_key) do update
        set metres = excluded.metres,
            seconds = excluded.seconds,
            fetched_at = excluded.fetched_at
    `);
  } catch {
    /* Nothing to do about it and nothing lost — the legs are in the answer. */
  }
}
