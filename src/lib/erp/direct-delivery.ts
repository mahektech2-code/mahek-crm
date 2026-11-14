import { sql, type SQL } from "drizzle-orm";
import "server-only";
import { db } from "@/db";

/* ---------------------------------------------------------------------------
 * WHICH TRANSPORTERS DELIVER STRAIGHT TO THE SHOP, with no LR — the transporter
 * list's "Delivers without an LR" mark (`erp_transporters.delivers_direct`).
 * Bills, trips and alerts carry the transporter as TEXT, so the mark is read by
 * name: `directNames()` for code that holds rows, `directSql()` for a query
 * that wants it as a column. Mahek Vehicle is direct by its name, in
 * `deliversDirect` (engines/logistics.ts), and needs no mark.
 * ------------------------------------------------------------------------- */

/** The lower-cased names of every transporter marked to deliver without an LR. */
export async function directNames(): Promise<Set<string>> {
  const rows = (await db.execute(sql`select lower(trim(name)) as n from erp_transporters where delivers_direct`)) as unknown as { n: string }[];
  return new Set(rows.map((r) => r.n));
}

/** True where the transporter named by `transporter` is marked to deliver without an LR. */
export function directSql(transporter: SQL): SQL<boolean> {
  return sql<boolean>`exists (select 1 from erp_transporters dtr where dtr.delivers_direct and lower(trim(dtr.name)) = lower(trim(${transporter})))`;
}
