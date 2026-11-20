import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { grantAppWithDefaultModules, rederiveAccountLevel } from "./app-provisioning";

/* ---------------------------------------------------------------------------
 * EVERYBODY HOLDS HRMS, AS AN ASSOCIATE (`npm run jobs -- hrms-for-everyone`).
 *
 * The Access dialog starts every person with HRMS ticked (`startingDraft` in
 * `app/admin/access-section.tsx`): it is where somebody checks in, asks for
 * leave and reads their own payslip. Accounts set up before that rule, or by a
 * path that never drew the dialog, hold everything else and no HRMS. This
 * gives each of them HRMS at associate level with its default screens — the
 * same grant the dialog would have made — and an audit row each.
 *
 * Who it skips, and says so:
 *  - an inactive account, or one whose HRMS record is not active (the
 *    dialog refuses those too — access is for active employees);
 *  - an account linked to no HRMS record: `setAccess` refuses HRMS there,
 *    because HRMS works out the person's team and manager from that record.
 *    Link them on Manage access first, and the next run picks them up;
 *  - an account marked "not an employee": no record to read.
 *
 * Idempotent: an account that already holds HRMS, at any level, is never
 * touched, so a second run writes nothing. `--dry-run` lists and writes nothing.
 * ------------------------------------------------------------------------- */

export type HrmsBackfill = {
  granted: { id: string; name: string }[];
  skipped: { unlinked: string[]; notEmployee: string[]; inactiveRecord: string[] };
};

type Row = { id: string; name: string; employeeId: string | null; notEmployee: boolean; employeeStatus: string | null; sheetStatus: string | null };

export async function hrmsForEveryone(opts: { dryRun?: boolean } = {}): Promise<HrmsBackfill> {
  const rows = (await db.execute(sql`
    select u.id, u.name, u.employee_id as "employeeId", u.not_employee as "notEmployee",
           e.status as "employeeStatus", e.sheet_status as "sheetStatus"
      from users u
      left join employees e on e.id = u.employee_id
     where u.active
       and not exists (select 1 from app_access a where a.user_id = u.id and a.app = 'hrms')
     order by u.name
  `)) as unknown as Row[];

  const out: HrmsBackfill = { granted: [], skipped: { unlinked: [], notEmployee: [], inactiveRecord: [] } };
  for (const r of rows) {
    if (r.notEmployee) out.skipped.notEmployee.push(r.name);
    else if (!r.employeeId) out.skipped.unlinked.push(r.name);
    else if (r.employeeStatus !== "active" || r.sheetStatus === "withdrawn") out.skipped.inactiveRecord.push(r.name);
    else out.granted.push({ id: r.id, name: r.name });
  }
  if (opts.dryRun) return out;

  const written: { id: string; name: string }[] = [];
  for (const p of out.granted) {
    const done = await db.transaction(async (tx) => {
      /* Asked again inside the write: a person given HRMS by hand while this ran keeps what they were given. */
      const [held] = (await tx.execute(sql`select 1 from app_access where user_id = ${p.id} and app = 'hrms' limit 1`)) as unknown as unknown[];
      if (held) return false;
      await grantAppWithDefaultModules(tx, { userId: p.id, app: "hrms", grantedById: null, level: "associate" });
      const accountLevel = await rederiveAccountLevel(tx, p.id);
      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        /* A terminal wears no hat: nobody is recorded, as `app:grant` records it. */
        actorId: null,
        action: "access.hrms-for-everyone",
        entityType: "user",
        entityId: p.id,
        afterState: { detail: "granted hrms as associate (hrms-for-everyone)", accountLevel } as never,
      });
      return true;
    });
    if (done) written.push(p);
  }
  return { ...out, granted: written };
}

export function hrmsForEveryoneReport(r: HrmsBackfill, dryRun: boolean): string {
  const s = r.skipped;
  return [
    `${dryRun ? "dry run: " : ""}${r.granted.length} ${r.granted.length === 1 ? "account" : "accounts"} ${dryRun ? "would be given" : "given"} HRMS as associate`,
    s.unlinked.length ? `${s.unlinked.length} skipped, not linked to an HRMS record` : "",
    s.inactiveRecord.length ? `${s.inactiveRecord.length} skipped, HRMS record not active` : "",
    s.notEmployee.length ? `${s.notEmployee.length} skipped, marked not an employee` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
