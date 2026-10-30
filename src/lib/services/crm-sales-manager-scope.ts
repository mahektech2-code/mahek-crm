import { cache } from "react";
import { headers } from "next/headers";
import { eq, sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import { users } from "@/db/schema";
import { managerNameByEmployeeName } from "./org-service";

import { CRM_SALES_MANAGER_WORKSPACE, WORKSPACE_HEADER } from "@/proxy";
import type { ManagerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * THE CRM SALES MANAGER'S SCOPE — one rule, for reads and for writes.
 *
 * `/crm/leads/sales-manager` draws the same pipeline `/sales-lead-pipeline`
 * does, but it is a different job held through a different app, and the two
 * cannot share a scope:
 *
 *   - `managerScope()` is territory-based, and is NATIONAL for a manager with
 *     no `region` row. A CRM Sales Manager has none, so reading through it
 *     would show them every lead in the company. (It reads the level now — an
 *     associate is narrowed to their own book — but a seat is not a level, and
 *     a CRM manager holding this seat would still be read as national.)
 *   - `users.reports_to_id` is the write side's team line, and no active field
 *     user has one in production.
 *
 * What production DOES carry is `customers.sales_manager_id` — the seat that
 * says which Sales Manager a lead answers to. This workspace's whole scope is
 * that column equalling the signed-in person, and nothing else:
 *
 *   - a lead with an owner and NO sales manager is not in anybody's scope,
 *   - a lead with neither is not in anybody's scope,
 *   - an administrator is not narrowed at all.
 *
 * Neither of the last two is assigned or "fixed" by this: they stay where they
 * are until somebody names a Sales Manager for them.
 *
 * **It travels on the request, not through an argument.** Scope is resolved
 * inside services that take none, and `assertCustomerInScope` is called from
 * a dozen action files. `src/proxy.ts` names the workspace from the URL
 * (stripping anything the client sent), and a server action POSTs to the URL
 * it was rendered from — so the read that draws a lead and the write that
 * acts on it resolve the SAME scope. That is the whole point: a lead you can
 * see is a lead you can act on.
 *
 * **It narrows only this workspace.** Nothing here touches `managerScope()`
 * for any other route, so the Sales Dashboard, the Live map and the attendance
 * photograph checks read exactly what they read before.
 * ------------------------------------------------------------------------- */

/** Test seam, like `setTestUser`: a test has no request to carry a header. */
let testWorkspace: string | null = null;
export function setTestWorkspace(workspace: string | null) {
  if (process.env.NODE_ENV !== "test") return;
  testWorkspace = workspace;
}

export async function inCrmSalesManagerWorkspace(): Promise<boolean> {
  if (testWorkspace !== null) return testWorkspace === CRM_SALES_MANAGER_WORKSPACE;
  try {
    if ((await headers()).get(WORKSPACE_HEADER) === CRM_SALES_MANAGER_WORKSPACE) return true;
  } catch {
    /* No request — a job or a test. Not this workspace. */
    return false;
  }
  return holdsSeatWithoutAllLeads();
}

/**
 * A CRM SALES MANAGER WHO WAS NEVER GIVEN ALL LEADS, anywhere in the CRM.
 *
 * The unified lead record lives at `/crm/leads/[id]`, behind `crm.leads`
 * and wider than their book. Somebody granted only `crm.sales-manager` is let
 * onto that one record (its layout asks any of the lead modules) but must stay
 * narrowed to their seat there exactly as they are under
 * `/crm/leads/sales-manager` — so that request is treated as being IN the
 * workspace, for reads and for writes alike, and the seat scope follows them.
 * It asks the CRM only: the Sales Dashboard keeps the scope it always had.
 * An administrator is never narrowed, and anybody holding `crm.leads` keeps
 * the scope that module has always carried.
 */
const holdsSeatWithoutAllLeads = cache(async (): Promise<boolean> => {
  try {
    const { requestAppId } = await import("../access-control");
    if ((await requestAppId()) !== "crm") return false;
    const [{ requireUser }, { canOpenModule }] = await Promise.all([import("../auth"), import("../access")]);
    const user = await requireUser();
    if (isAdminUser(user)) return false;
    return (
      (await canOpenModule(user.id, "crm.sales-manager")) && !(await canOpenModule(user.id, "crm.leads"))
    );
  } catch {
    return false;
  }
});

/** An administrator is not narrowed by a seat: they run the system. */
export function isAdminUser(user: { role: string }): boolean {
  return user.role === "admin";
}

/**
 * The `ManagerScope` the shared lead services read inside this workspace.
 *
 * Administrator: national, no seat clause — every lead, assigned or not.
 * Anybody else: `salesManagerId` set, and `leadsVisible` turns that into
 * `sales_manager_id = <them>`. `salesmanIds` stays null because the lists that
 * read it (who a lead can be reassigned to) are pickers of people, not of leads.
 *
 * THAT NULL IS NOT "NATIONAL", and a check about ONE PERSON must not read it
 * so. A photograph read or a day's verdict that asked `salesmanIds === null`
 * would hand this seat every salesman's evidence. `scopeCovers` in
 * `sales-gate.ts` is the one reading of a scope for a single person, and it
 * answers no wherever `salesManagerId` is set.
 */
export function crmSalesManagerScopeFor(user: { id: string; role: string }): ManagerScope {
  if (isAdminUser(user)) return { national: true, regions: [], salesmanIds: null };
  return { national: false, regions: [], salesmanIds: null, salesManagerId: user.id };
}

/**
 * THE PEOPLE WHO ANSWER TO THIS SALES MANAGER, plus the manager themself.
 *
 * The seat (`sales_manager_id`) is filled by a nightly name match, so a new
 * lead, a reassigned one, or a salesman whose name is spelt differently on the
 * HR sheet sat outside the manager's book — and a manager who holds salesmen
 * could not see, filter or work their leads. A lead owned by anybody on this
 * list is therefore in the manager's book as well as one carrying their seat.
 *
 * "Under" is read the way the rest of the product reads it: the account's
 * `reports_to_id`, the org chart, or the employee sheet's own "reports to"
 * column. It can only ADD leads, and only ones owned by their own people.
 */
export const teamOwnerIdsFor = cache(async function teamOwnerIdsFor(
  userId: string,
  userName: string,
): Promise<string[]> {
  const mine = userName.trim().toLowerCase();
  const [managerNameOf, accounts, sheet] = await Promise.all([
    managerNameByEmployeeName(),
    db
      .select({ id: users.id, name: users.name, reportsToId: users.reportsToId })
      .from(users)
      .where(eq(users.active, true)),
    db.execute<{ name: string }>(sql`
      select name from employees where status = 'active' and lower(trim(reports_to)) = ${mine}
    `) as unknown as Promise<{ name: string }[]>,
  ]);
  const sheetNames = new Set(sheet.map((r) => r.name.trim().toLowerCase()));
  const ids = new Set<string>([userId]);
  for (const a of accounts) {
    const n = a.name.trim().toLowerCase();
    if (
      a.reportsToId === userId ||
      managerNameOf.get(n)?.trim().toLowerCase() === mine ||
      sheetNames.has(n)
    ) {
      ids.add(a.id);
    }
  }
  return [...ids];
});

/**
 * `and (<alias>.sales_manager_id = <them> or <alias>.owner_id in <their team>)`
 * for queries that join `customers` but were narrowed by SALESMAN rather than
 * by lead (the sample desk, the nurture schedule). Empty for every other scope,
 * so those queries are unchanged everywhere else.
 */
export function inSalesManagersBook(scope: ManagerScope, alias = "c"): SQL {
  if (!scope.salesManagerId) return sql``;
  const seat = sql`${sql.raw(alias)}.sales_manager_id = ${scope.salesManagerId}`;
  const team = scope.teamOwnerIds ?? [];
  if (!team.length) return sql`and ${seat}`;
  const owners = sql.join(team.map((i) => sql`${i}`), sql`, `);
  return sql`and (${seat} or ${sql.raw(alias)}.owner_id in (${owners}))`;
}

/**
 * The write-side rule, the same one as the read clause above: a lead is in
 * scope when its Sales Manager is the signed-in person, or the person is an
 * administrator. Missing information fails closed — a caller that did not pass
 * the seat cannot prove the lead is theirs.
 */
export function leadInSalesManagersBook(
  customer: { salesManagerId?: string | null; ownerId?: string | null } | null,
  user: { id: string; role: string },
  teamOwnerIds: readonly string[] = [],
): boolean {
  if (isAdminUser(user)) return true;
  if (!customer) return false;
  if (customer.salesManagerId && customer.salesManagerId === user.id) return true;
  return !!customer.ownerId && teamOwnerIds.includes(customer.ownerId);
}
