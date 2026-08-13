import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local for development; " +
      "in production it is set in /opt/mahekone/.env on the server.",
  );
}

/**
 * Fluid Compute reuses function instances, so the pool is cached on
 * globalThis to survive hot reloads in dev and instance reuse in production.
 */
const globalForDb = globalThis as unknown as {
  __mahekSql?: ReturnType<typeof postgres>;
};

const sql =
  globalForDb.__mahekSql ??
  postgres(connectionString, {
    /*
     * TWENTY WAS A NUMBER ABOUT DISTANCE. With the database in another
     * continent every query held a connection for ~300 ms, so a small pool
     * serialised work that was written to run in parallel and the answer was
     * to open more.
     *
     * On the same machine a query holds its connection for well under a
     * millisecond, so the pool empties as fast as it fills and twenty
     * connections buy nothing — they only cost, at roughly 10 MB of Postgres
     * memory each on a box that has 1 GiB for everything. Ten is ample for
     * eight people, and it leaves headroom under `max_connections=30` for a
     * `psql` session and the nightly job.
     *
     * Tunable rather than fixed, because the right answer moves with the box.
     */
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),

    /*
     * FALSE WAS A NUMBER ABOUT NEON, like the pool size above it. Neon's
     * pooled endpoint is pgbouncer in transaction mode, where a named
     * prepared statement outlives the connection it was prepared on and the
     * next query finds it missing. There is no pgbouncer here — the app talks
     * to Postgres directly over the compose network — so the reason is gone
     * and the cost is not.
     *
     * What it costs is a re-PLAN of every statement on every execution, and
     * the two hottest statements in the app are the queue's customer scan with
     * thirteen correlated subqueries and the EOD query with twenty. Planning
     * those is not free, and nothing about them changes between executions
     * except the parameters.
     *
     * Tunable, and set to `false` if a generic plan ever turns out worse than
     * a per-call one: Postgres switches to a generic plan after five
     * executions, and on a predicate whose selectivity swings with its
     * parameter — a scope that is one telecaller on one call and the whole
     * company on the next — that trade can go the wrong way. It is the kind of
     * thing to watch in `log_min_duration_statement` rather than to assume.
     */
    prepare: process.env.DATABASE_PREPARE !== "false",
  });

if (process.env.NODE_ENV !== "production") globalForDb.__mahekSql = sql;

export const db = drizzle(sql, { schema });
export { schema, sql };
