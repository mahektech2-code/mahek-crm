/**
 * WHO, ON THE ORG CHART, HAS MANAGER AUTHORITY OVER A LEAVER'S LEADS — pure.
 *
 * When a lead's owner has left, the managers above them on the Org Chart may
 * work their leads, nearest first, as many levels up as the chart goes. This
 * walks `employee_reporting` upward from the owner's EMPLOYEE record and names
 * every manager who may act, in order. It performs no I/O.
 *
 * FAIL CLOSED, in the same places the verifier walk refuses
 * (`org-verifier-chain`):
 *
 *   - the owner has no stored employee link   -> nobody (the caller never
 *     starts the walk; a name or email match is a guess, and authority is not
 *     given on a guess)
 *   - a manager who has left, or whose status is not plainly Active, is
 *     SKIPPED and the walk goes on to THEIR manager — the line above somebody
 *     who cannot act is still the same reporting line
 *   - a manager with no account, or whose only account is inactive, is skipped
 *     the same way
 *   - TWO accounts claiming one manager employee: the walk STOPS there. Nobody
 *     at or above that rung is named, because it cannot be said which of the
 *     two is the manager. Those already collected below it stand.
 *   - a LOOP in the chart: nobody at all. A chart that loops back on itself
 *     cannot be trusted at any rung.
 *
 * Authority is not ownership and not a permission: it only answers "is this
 * person above that owner on the chart". Every capability a caller already
 * demands is still demanded.
 */

export type AuthorityEmployee = {
  /** `employees.status` — the authoritative word. `status_raw` and `sheet_status` are not read. */
  status: "active" | "inactive" | "unknown";
};

export type AuthorityAccount = { userId: string; active: boolean };

export type Ancestor = { employeeId: string; userId: string };

export type AuthorityChain = {
  ancestors: Ancestor[];
  /** Why the walk stopped early, where it did: for a screen or a log, never for a decision. */
  stoppedBy: "cycle" | "ambiguous" | null;
};

const MAX_DEPTH = 25;

export function authorityChain(input: {
  /** The owner's employee id, from the STORED `users.employee_id`; null where there is none. */
  ownerEmployeeId: string | null;
  /** employee id -> their manager's employee id. */
  managerOf: ReadonlyMap<string, string>;
  employees: ReadonlyMap<string, AuthorityEmployee>;
  /** employee id -> EVERY account that names that employee, active or not. */
  accountsByEmployee: ReadonlyMap<string, readonly AuthorityAccount[]>;
}): AuthorityChain {
  const none: AuthorityChain = { ancestors: [], stoppedBy: null };
  const owner = input.ownerEmployeeId;
  if (!owner || !input.employees.has(owner)) return none;

  const ancestors: Ancestor[] = [];
  const visited = new Set<string>([owner]);
  let current = owner;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const managerId = input.managerOf.get(current);
    if (!managerId) return { ancestors, stoppedBy: null };
    if (visited.has(managerId)) return { ancestors: [], stoppedBy: "cycle" };
    visited.add(managerId);
    current = managerId;

    const employee = input.employees.get(managerId);
    if (!employee || employee.status !== "active") continue;

    const accounts = input.accountsByEmployee.get(managerId) ?? [];
    if (accounts.length === 0) continue;
    if (accounts.length > 1) return { ancestors, stoppedBy: "ambiguous" };
    const account = accounts[0]!;
    if (!account.active) continue;
    ancestors.push({ employeeId: managerId, userId: account.userId });
  }
  return { ancestors, stoppedBy: null };
}

/**
 * HAS THE OWNER LEFT. The account is switched off, or the linked employee is
 * plainly Inactive on `employees.status`. Either is enough: HRMS deactivation
 * does both, and a sign-in disabled by hand is also a person whose leads nobody
 * is working. A missing employee is NOT "left" — nothing is known — so a lead
 * whose owner has no account at all is never opened up by this.
 */
export function ownerHasLeft(input: {
  accountActive: boolean | null;
  employeeStatus: AuthorityEmployee["status"] | null;
}): boolean {
  if (input.accountActive === null) return false;
  return input.accountActive === false || input.employeeStatus === "inactive";
}
