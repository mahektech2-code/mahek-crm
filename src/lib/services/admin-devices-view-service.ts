import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * The counts on the Handsets screen's tabs: everybody who can sign in to the
 * Salesman App, and every factory phone that has ever reported. Read once per
 * page; the tables themselves re-read live.
 */
export async function fleetCounts(): Promise<{ field: number; factory: number }> {
  const [row] = (await db.execute<{ field: number; factory: number }>(sql`
    select
      (select count(*)::int from users u join app_access a on a.user_id = u.id and a.app = 'field' where u.active) as field,
      (select count(*)::int from factory_devices) as factory`)) as unknown as Array<{ field: number; factory: number }>;
  return { field: row?.field ?? 0, factory: row?.factory ?? 0 };
}
