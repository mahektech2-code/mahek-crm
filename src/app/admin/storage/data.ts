import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/** The two figures the storage summary does not carry: the database's own size, and what the sweeps took in the last day. */
export async function storageExtras(): Promise<{ databaseBytes: number; sweptDay: number }> {
  const [r] = (await db.execute<{ db: number; swept: number }>(sql`
    select pg_database_size(current_database())::float8 as db,
           (select count(*)::int from attachments where purged_at >= now() - interval '24 hours') as swept`)) as unknown as {
    db: number;
    swept: number;
  }[];
  return { databaseBytes: Number(r?.db ?? 0), sweptDay: Number(r?.swept ?? 0) };
}
