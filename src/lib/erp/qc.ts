import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { SfgQc } from "./engines/trace";
import type { TestResults } from "./engines/sfg-tests";
import type { Ex } from "./stock";

/** Every SFG lot's QC verdict. A lot missing from the map is Pending. */
export type SfgQcVerdict = { status: SfgQc; note: string | null; tests: TestResults; by: string | null; at: string | null };

export async function sfgQcMap(ex: Ex = db): Promise<Map<string, SfgQcVerdict>> {
  const rows = (await ex.execute(sql`
    select q.lot_code as lot, q.status, q.note, q.tests, u.name as by, q.decided_at::text as at
      from erp_sfg_qc q left join users u on u.id = q.decided_by_id
  `)) as unknown as (SfgQcVerdict & { lot: string })[];
  return new Map(rows.map((r) => [r.lot, { status: r.status, note: r.note, tests: r.tests ?? {}, by: r.by, at: r.at }]));
}

export async function sfgQcOf(lot: string, ex: Ex = db): Promise<SfgQc> {
  const rows = (await ex.execute(sql`select status from erp_sfg_qc where lot_code = ${lot}`)) as unknown as { status: SfgQc }[];
  return rows[0]?.status ?? "Pending";
}

/**
 * Records a QC decision on a lot, with the Testing list's checks as answered.
 * The verdict is a row per lot, rewritten; the audit log keeps every one.
 */
export async function setSfgQc(ex: Ex, lot: string, status: SfgQc, note: string | null, byId: string, tests: TestResults = {}): Promise<void> {
  await ex.execute(sql`
    insert into erp_sfg_qc (lot_code, status, note, tests, decided_by_id, decided_at, updated_at)
    values (${lot}, ${status}, ${note}, ${JSON.stringify(tests)}::jsonb, ${byId}, now(), now())
    on conflict (lot_code) do update set status = excluded.status, note = excluded.note, tests = excluded.tests, decided_by_id = excluded.decided_by_id, decided_at = excluded.decided_at, updated_at = now()
  `);
}
