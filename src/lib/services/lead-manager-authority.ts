import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers, employeeReporting, employees, users } from "@/db/schema";
import { authorityChain, ownerHasLeft, type AuthorityAccount, type AuthorityEmployee } from "@/lib/engines/manager-authority";

/* ---------------------------------------------------------------------------
 * MANAGER AUTHORITY OVER A LEAVER'S LEADS.
 *
 * When a lead's owner has left, the managers above them on the Org Chart may
 * work the lead without it being transferred. `customers.owner_id` is never
 * touched: ownership moves only when somebody with `lead.assign` moves it.
 *
 * WHAT THIS IS NOT
 *   - Not a permission. Every capability a caller asks (`lead.work`,
 *     `lead.assign`, `lead.verify` …) is still asked; this only answers the
 *     SCOPE question "is this lead mine to touch", the one `assertCustomerInScope`
 *     asks.
 *   - Not a list. Lead lists, the Calling Desk, the handset book, targets and
 *     personal assignment lists are read elsewhere and are unchanged: a leaver's
 *     lead does not land in a manager's personal queue.
 *   - Not for an active owner. Somebody still working their leads keeps the
 *     existing workflow exactly.
 *
 * WHO. The owner's STORED `users.employee_id` only; then the active, single-
 * account managers above that employee on `employee_reporting` (see
 * `engines/manager-authority`). The leaver is read from `users.active` and
 * `employees.status` — never `status_raw` or `sheet_status`. The actor must also
 * hold the CRM Leads module; the Calling Desk is not needed.
 * ------------------------------------------------------------------------- */

type Org = {
  accountOf: Map<string, { active: boolean; employeeId: string | null; name: string }>;
  employees: Map<string, AuthorityEmployee>;
  managerOf: Map<string, string>;
  accountsByEmployee: Map<string, AuthorityAccount[]>;
};

const loadOrg = cache(async (): Promise<Org> => {
  const [accounts, emps, links] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, active: users.active, employeeId: users.employeeId })
      .from(users),
    db.select({ id: employees.id, status: employees.status }).from(employees),
    db
      .select({ employeeId: employeeReporting.employeeId, managerId: employeeReporting.managerId })
      .from(employeeReporting),
  ]);
  const accountsByEmployee = new Map<string, AuthorityAccount[]>();
  for (const a of accounts) {
    if (!a.employeeId) continue;
    const list = accountsByEmployee.get(a.employeeId) ?? [];
    list.push({ userId: a.id, active: a.active });
    accountsByEmployee.set(a.employeeId, list);
  }
  return {
    accountOf: new Map(accounts.map((a) => [a.id, { active: a.active, employeeId: a.employeeId, name: a.name }])),
    employees: new Map(emps.map((e) => [e.id, { status: e.status as AuthorityEmployee["status"] }])),
    managerOf: new Map(links.map((l) => [l.employeeId, l.managerId])),
    accountsByEmployee,
  };
});

export type OwnerAuthority = {
  /** The owner has left (account off, or employee Inactive). */
  gone: boolean;
  ownerName: string | null;
  /** Active managers above them, nearest first, as user ids. */
  managerUserIds: string[];
};

/** Who has authority over this owner's leads. Never throws; an unknown owner gives nobody. */
export async function authorityOverOwner(ownerId: string | null): Promise<OwnerAuthority> {
  const empty: OwnerAuthority = { gone: false, ownerName: null, managerUserIds: [] };
  if (!ownerId) return empty;
  const org = await loadOrg();
  const owner = org.accountOf.get(ownerId);
  if (!owner) return empty;
  const employee = owner.employeeId ? (org.employees.get(owner.employeeId) ?? null) : null;
  const gone = ownerHasLeft({ accountActive: owner.active, employeeStatus: employee?.status ?? null });
  if (!gone) return { gone: false, ownerName: owner.name, managerUserIds: [] };
  const chain = authorityChain({
    ownerEmployeeId: owner.employeeId,
    managerOf: org.managerOf,
    employees: org.employees,
    accountsByEmployee: org.accountsByEmployee,
  });
  return { gone: true, ownerName: owner.name, managerUserIds: chain.ancestors.map((a) => a.userId) };
}

/**
 * MAY THIS PERSON WORK A LEAD OWNED BY THIS LEAVER — the owner has left, the
 * person is an active manager above them on the chart, and holds the CRM Leads
 * module. The owner themself is never their own manager here.
 */
export async function holdsAuthorityOverOwner(actorId: string, ownerId: string | null): Promise<boolean> {
  if (!ownerId || actorId === ownerId) return false;
  const authority = await authorityOverOwner(ownerId);
  if (!authority.gone || !authority.managerUserIds.includes(actorId)) return false;
  const { canOpenModule } = await import("../access");
  return canOpenModule(actorId, "crm.leads");
}

/**
 * THE NOTE A SCREEN OR AN AUDIT ROW CARRIES when somebody is working a lead on
 * a leaver's behalf: null unless the lead is a lead, its owner has left, and
 * this person's only claim on it is the chart above that owner. Read from the
 * lead row, never from anything a client sent.
 */
export async function actingOnBehalfOf(
  customerId: string,
  actorId: string,
): Promise<{ ownerId: string; ownerName: string } | null> {
  const [lead] = await db
    .select({ kind: customers.kind, ownerId: customers.ownerId, deletedAt: customers.deletedAt })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!lead || lead.kind !== "lead" || lead.deletedAt || !lead.ownerId) return null;
  if (!(await holdsAuthorityOverOwner(actorId, lead.ownerId))) return null;
  const { ownerName } = await authorityOverOwner(lead.ownerId);
  return { ownerId: lead.ownerId, ownerName: ownerName ?? "the former owner" };
}
