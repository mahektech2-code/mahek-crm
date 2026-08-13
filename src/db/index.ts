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
    prepare: false,
  });

if (process.env.NODE_ENV !== "production") globalForDb.__mahekSql = sql;

export const db = drizzle(sql, { schema });
export { schema, sql };
