import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Run `vercel env pull` to fetch it from the linked project.",
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
    // A distant database means each query holds a connection for ~300 ms, so a
    // small pool serialises work that was written to run in parallel.
    max: 20,
    prepare: false,
  });

if (process.env.NODE_ENV !== "production") globalForDb.__mahekSql = sql;

export const db = drizzle(sql, { schema });
export { schema, sql };
