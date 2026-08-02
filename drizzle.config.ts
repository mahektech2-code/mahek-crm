import type { Config } from "drizzle-kit";
import { loadEnv } from "./src/lib/load-env";

loadEnv();

/**
 * Migrations live in ./drizzle and are committed. They are what keeps every
 * developer's local database in step — `push` is fine solo, but a team needs a
 * shared, ordered history.
 */
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;
