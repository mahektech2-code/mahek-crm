import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, users } from "@/db/schema";
import { managerNameByEmployeeName } from "@/lib/services/org-service";

/* ---------------------------------------------------------------------------
 * WHICH SALESMEN A PERSON MANAGES — one answer, from the reporting lines that
 * already exist, so nothing here invents a team.
 *
 * A salesman is on somebody's team when ANY of the existing three says so:
 *
 *   • he reports to them — `users.reports_to_id`, the line the scope resolver
 *     reads for a manager's team;
 *   • the Org Chart names them as his manager — `employee_reporting`, read by
 *     name through `managerNameByEmployeeName`, the same map the nightly
 *     Sales Manager pass fills the seat from;
 *   • he works a book that sits under their Sales Manager seat —
 *     `customers.sales_manager_id`, which is what the Sales Manager desk is
 *     drawn from.
 *
 * An administrator manages every salesman, as an administrator's team is the
 * whole company everywhere else. Only active holders of the Salesman App are
 * ever returned. The person themself is NOT in the list: recording one's own
 * visit needs no team.
 *
 * Asked by the Log a visit dialog to draw its dropdown AND by the action to
 * refuse a name outside it — a dropdown is a convenience, not a permission.
 * ------------------------------------------------------------------------- */
export async function managedSalesmen(user: {
  id: string;
  name: string;
  role: string;
}): Promise<{ id: string; name: string }[]> {
  const field = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .innerJoin(appAccess, eq(appAccess.userId, users.id))
    .where(sql`${appAccess.app} = 'field' and ${users.active} = true`);

  if (user.role === "admin") return field.filter((f) => f.id !== user.id);

  const ids = new Set<string>();

  /* 1. They report to this person. */
  const direct = await db.select({ id: users.id }).from(users).where(eq(users.reportsToId, user.id));
  for (const r of direct) ids.add(r.id);

  /* 2. The Org Chart names this person as their manager. */
  const me = user.name.trim().toLowerCase();
  const chart = await managerNameByEmployeeName();
  for (const f of field) {
    const manager = chart.get(f.name.trim().toLowerCase());
    if (manager && manager.trim().toLowerCase() === me) ids.add(f.id);
  }

  /* 3. They work a book under this person's Sales Manager seat. */
  const seated = await db.execute<{ id: string | null }>(sql`
    select distinct coalesce(c.sales_am_id, c.owner_id) as id
      from customers c
     where c.sales_manager_id = ${user.id}
  `);
  for (const r of seated) if (r.id) ids.add(r.id);

  return field.filter((f) => ids.has(f.id) && f.id !== user.id);
}
