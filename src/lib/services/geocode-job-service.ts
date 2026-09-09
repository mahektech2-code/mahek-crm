import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { geocodeAddress } from "./ola-geocode-service";

/* ---------------------------------------------------------------------------
 * Putting the shops nobody has stood in onto the map.
 *
 * 503 customers carry an address and no pin. They are absent from the
 * territory map, they cannot be put on a day's route, and the salesman
 * planning that day never sees them — a shop missing from a list is a shop
 * nobody visits and nobody finds out why, which is the silent failure
 * `engines/route.ts` already refuses to allow for unlocated stops.
 *
 * IT NEVER TOUCHES THE FIELD PIN. `gps_lat` is where somebody stood; this
 * writes `geocoded_lat` beside it. A shop that has both keeps both, and every
 * reader prefers the one a salesman captured.
 *
 * BOUNDED PER RUN, because it costs requests. The default leaves the free tier
 * untouched in any practical sense — 503 shops is one afternoon's worth of a
 * hundred-thousand allowance — but a job that could spend without limit is one
 * nobody can safely put on a schedule.
 *
 * A SHOP IS TRIED ONCE. `geocoded_at` is stamped whether or not an answer came
 * back, so a run does not spend its budget re-asking about the same
 * unanswerable addresses every night. Changing the address clears the stamp —
 * that is the one thing that makes it worth asking again.
 * ------------------------------------------------------------------------- */

export type GeocodeRun = {
  attempted: number;
  located: number;
  unanswered: number;
  detail: string;
};

/**
 * Geocode customers that have an address, no pin of either kind, and no
 * previous attempt.
 *
 * Serial rather than parallel, deliberately: this runs unattended against
 * somebody else's rate limit, and twenty concurrent requests is how a free
 * tier turns into a 429 for everything else the deployment does — including
 * the Live map's snap-to-road, which a manager is looking at right now.
 */
export async function geocodeCustomers(limit = 200): Promise<GeocodeRun> {
  const rows = await db.execute<{ id: string; name: string; address: string; city: string | null }>(sql`
    select c.id, c.name, c.address, c.city
      from customers c
     where c.gps_lat is null
       and c.geocoded_at is null
       and coalesce(btrim(c.address), '') <> ''
     order by c.name asc
     limit ${limit}
  `);

  const list = rows as unknown as { id: string; name: string; address: string; city: string | null }[];
  let located = 0;

  for (const row of list) {
    /* The city is appended where the address does not already name it. An
       Indian address without its city geocodes to whichever same-named road
       the engine likes best, and there is one of those in every state. */
    const address = row.address.trim();
    const city = (row.city ?? "").trim();
    const query =
      city && !address.toLowerCase().includes(city.toLowerCase())
        ? `${address}, ${city}`
        : address;

    const hit = await geocodeAddress(query);

    if (hit) {
      located++;
      await db.execute(sql`
        update customers
           set geocoded_lat = ${hit.lat},
               geocoded_lng = ${hit.lng},
               geocoded_precision = ${hit.precision},
               geocoded_query = ${query},
               geocoded_at = now()
         where id = ${row.id}
      `);
    } else {
      /* Stamped anyway. An address the geocoder cannot answer is a fact about
         that address, and re-asking nightly spends the allowance on the one
         set of rows guaranteed not to benefit. */
      await db.execute(sql`
        update customers
           set geocoded_query = ${query}, geocoded_at = now()
         where id = ${row.id}
      `);
    }
  }

  const unanswered = list.length - located;
  return {
    attempted: list.length,
    located,
    unanswered,
    detail: list.length
      ? `${located} of ${list.length} placed on the map, ${unanswered} the geocoder could not answer`
      : "every shop with an address has already been tried",
  };
}
