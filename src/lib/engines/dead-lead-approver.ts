/* ---------------------------------------------------------------------------
 * WHO DECIDES A DEAD REQUEST — the Org Chart rule, PURE.
 *
 * `users.employee_id` → `employee_reporting.manager_id` → the manager
 * employee's linked user. The data fetching is in
 * `services/lead-dead-service.ts`; this file only decides, from facts handed to
 * it, and it NEVER substitutes a different person. Every way of failing names
 * what an administrator has to correct on the Org Chart, because a request that
 * silently went to somebody else is worse than one that did not go at all.
 * ------------------------------------------------------------------------- */

export type ApproverFacts = {
  requesterUserId: string;
  /** `users.employee_id` of the requester, or null where the account is not linked to an employee. */
  requesterEmployeeId: string | null;
  /** `employee_reporting.manager_id` for that employee, or null where none is set. */
  managerEmployeeId: string | null;
  /** The manager employee's row, where one exists. */
  managerEmployee: { id: string; name: string; active: boolean } | null;
  /** The MahekOne accounts linked to the manager employee (normally one). */
  managerUsers: Array<{ id: string; name: string; active: boolean; canDecide: boolean }>;
};

export type ApproverDecision =
  | { ok: true; approverUserId: string; approverName: string; approverEmployeeId: string }
  | { ok: false; code: ApproverFailure; message: string };

export type ApproverFailure =
  | "requester_not_linked"
  | "no_manager"
  | "manager_inactive"
  | "manager_no_account"
  | "manager_account_disabled"
  | "manager_ambiguous"
  | "manager_cannot_decide"
  | "self_manager";

const FIX = "An administrator has to correct the Org Chart before this can be sent.";

export function decideApprover(f: ApproverFacts): ApproverDecision {
  if (!f.requesterEmployeeId) {
    return {
      ok: false,
      code: "requester_not_linked",
      message: `Your MahekOne account is not linked to an employee record, so your reporting manager cannot be found. ${FIX}`,
    };
  }
  if (!f.managerEmployeeId) {
    return {
      ok: false,
      code: "no_manager",
      message: `You have no reporting manager on the Org Chart. ${FIX}`,
    };
  }
  if (f.managerEmployeeId === f.requesterEmployeeId) {
    return {
      ok: false,
      code: "self_manager",
      message: `The Org Chart lists you as your own manager. ${FIX}`,
    };
  }
  const manager = f.managerEmployee;
  if (!manager) {
    return {
      ok: false,
      code: "manager_inactive",
      message: `Your reporting manager's employee record could not be found. ${FIX}`,
    };
  }
  if (!manager.active) {
    return {
      ok: false,
      code: "manager_inactive",
      message: `Your reporting manager, ${manager.name}, is no longer active. ${FIX}`,
    };
  }
  const users = f.managerUsers;
  if (users.length === 0) {
    return {
      ok: false,
      code: "manager_no_account",
      message: `Your reporting manager, ${manager.name}, has no MahekOne account. ${FIX}`,
    };
  }
  /* Two linked accounts is an ambiguity this rule refuses to resolve by
     guessing — the Org Chart has to say which one. */
  if (users.length > 1) {
    return {
      ok: false,
      code: "manager_ambiguous",
      message: `More than one MahekOne account is linked to your reporting manager, ${manager.name}, so it is not clear who should decide. ${FIX}`,
    };
  }
  const [u] = users;
  if (u.id === f.requesterUserId) {
    return {
      ok: false,
      code: "self_manager",
      message: `The Org Chart lists you as your own manager. ${FIX}`,
    };
  }
  if (!u.active) {
    return {
      ok: false,
      code: "manager_account_disabled",
      message: `Your reporting manager's account, ${u.name}, is disabled. ${FIX}`,
    };
  }
  if (!u.canDecide) {
    return {
      ok: false,
      code: "manager_cannot_decide",
      message: `Your reporting manager, ${u.name}, does not hold the access needed to decide lead requests. ${FIX}`,
    };
  }
  return { ok: true, approverUserId: u.id, approverName: u.name, approverEmployeeId: manager.id };
}
