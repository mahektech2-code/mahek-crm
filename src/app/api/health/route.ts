import { NextResponse } from "next/server";
import { sql as raw } from "drizzle-orm";
import { db } from "@/db";

/* ---------------------------------------------------------------------------
 * IS THIS DEPLOYMENT ACTUALLY WORKING.
 *
 * The uptime monitor used to ask for the home page and treat any answer as
 * health. That proves Caddy is listening and Next is running, and says nothing
 * at all about the thing most likely to be wrong: whether the app can reach
 * its database. On a single droplet those are genuinely separate — Postgres
 * can be down, out of connections, or mid-restore while the app happily serves
 * a login form to anybody who asks.
 *
 * So this asks the database a question and reports the answer honestly. A page
 * that renders while the database is unreachable is not "up"; it is a sign-in
 * screen that will refuse every sign-in.
 *
 * NO AUTHENTICATION, by necessity — the monitor has no account. So it must
 * leak nothing: no version strings, no connection details, no row counts, no
 * configuration. Whether the database answers is a fact about the deployment;
 * how many customers are in it is a fact about the business.
 * ------------------------------------------------------------------------- */

// Never cached and never prerendered. A cached health check is a health check
// that reports the state of some earlier moment, which is worse than none.
export const dynamic = "force-dynamic";

/**
 * A ceiling, so a hung database gives a fast NO rather than a slow nothing.
 * Betterstack's own request timeout is 30s; answering "unhealthy" in two beats
 * being killed at thirty, because the first is a signal and the second is
 * indistinguishable from the host being gone.
 */
const DB_TIMEOUT_MS = 5_000;

export async function GET() {
  const startedAt = Date.now();

  let dbOk = false;
  try {
    await Promise.race([
      // The cheapest possible question that still crosses the pool, the
      // socket, and the server's ability to answer. `select 1` costs nothing
      // and this runs roughly eighty times an hour across four regions.
      db.execute(raw`select 1`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), DB_TIMEOUT_MS),
      ),
    ]);
    dbOk = true;
  } catch {
    // Deliberately swallowed. The monitor needs a status code, not a stack
    // trace, and the reason belongs in the container logs where it already is.
    dbOk = false;
  }

  const body = {
    ok: dbOk,
    database: dbOk ? "up" : "down",
    // Round-trip to the database in milliseconds. Useful on a 1 GiB box, where
    // the first symptom of memory pressure is this number climbing long before
    // anything actually fails.
    databaseMs: Date.now() - startedAt,
  };

  // 503 rather than 200-with-a-sad-body: monitors and load balancers read the
  // STATUS CODE, and a body nobody parses is a health check that never fires.
  return NextResponse.json(body, {
    status: dbOk ? 200 : 503,
    headers: { "cache-control": "no-store, max-age=0" },
  });
}
