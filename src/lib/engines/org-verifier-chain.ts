/**
 * WHO, ON THE ORG CHART, VERIFIES A SALESMAN'S LEAD — pure.
 *
 * Starting at a Salesman's EMPLOYEE record, walk `employee_reporting` upward
 * (employee id → manager employee id) and answer with the nearest manager who
 * can actually be sent the verification: an employee still on the books, with
 * exactly one MahekOne account, that account active, and able to verify.
 *
 * NOTHING HERE GUESSES. Identity arrives as employee ids — the caller reads
 * `users.employee_id`, which is said, never matched by name — and the walk
 * refuses in words rather than choosing:
 *
 *   subject_unmapped     the Salesman's account names no employee record
 *   subject_unknown      it names one that is not on the books
 *   no_manager           nobody is recorded above him
 *   cycle                the chain loops back on itself
 *   ambiguous_account    two accounts claim one employee — no way to say which
 *   chain_exhausted      managers exist, none of them can be sent it
 *   creator_is_verifier  the first person who could verify it is the person who
 *                        raised it, so they may not — the caller decides what
 *                        then happens (the desk verifier), not this walk
 *
 * A manager who is a leaver, or has no account, or has one that is inactive or
 * cannot verify, is SKIPPED and the walk continues to their own manager: the
 * line above somebody who cannot act is still the same reporting line, and it
 * must still pass every check. What is never skipped is a LOOP or an ambiguity.
 *
 * It performs no I/O and takes the answers to "can this account verify" as an
 * argument, so the whole decision runs in a unit test.
 */

export type ChainEmployee = {
  /** Still on the books: not a leaver and not withdrawn from the sheet. */
  onTheBooks: boolean;
};

export type ChainAccount = {
  userId: string;
  active: boolean;
  /** `lead.verify`, or the Sales Manager seat — whatever the caller accepts as able to verify. */
  canVerify: boolean;
};

export type SkippedManager = {
  employeeId: string;
  reason: "left" | "no_account" | "inactive" | "cannot_verify";
};

export type OrgVerifierResult =
  | {
      ok: true;
      verifierUserId: string;
      verifierEmployeeId: string;
      /** 1 = the Salesman's own manager. */
      depth: number;
      skipped: SkippedManager[];
    }
  | {
      ok: false;
      code:
        | "subject_unmapped"
        | "subject_unknown"
        | "no_manager"
        | "cycle"
        | "ambiguous_account"
        | "chain_exhausted"
        | "creator_is_verifier";
      message: string;
      skipped: SkippedManager[];
      /** Set for `creator_is_verifier`: the account that would have been chosen. */
      wouldBeUserId?: string;
    };

const MAX_DEPTH = 25;

export function resolveOrgVerifier(input: {
  /** The Salesman's employee id, from `users.employee_id`; null where the account names none. */
  subjectEmployeeId: string | null;
  /** employee id → their manager's employee id. */
  managerOf: ReadonlyMap<string, string>;
  employees: ReadonlyMap<string, ChainEmployee>;
  /** employee id → every account claiming that employee (the schema allows one). */
  accountsByEmployee: ReadonlyMap<string, readonly ChainAccount[]>;
  /** Who raised the lead. The nearest eligible manager being them is its own outcome. */
  creatorUserId?: string | null;
  /** Never chosen: the subject themself, and anyone else the caller rules out. */
  excludeUserIds?: ReadonlySet<string>;
}): OrgVerifierResult {
  const skipped: SkippedManager[] = [];
  const fail = (
    code: Extract<OrgVerifierResult, { ok: false }>["code"],
    message: string,
    wouldBeUserId?: string,
  ): OrgVerifierResult => ({ ok: false, code, message, skipped, wouldBeUserId });

  const subject = input.subjectEmployeeId;
  if (!subject) {
    return fail(
      "subject_unmapped",
      "The Salesman's account is not linked to an employee record, so the org chart cannot say who he reports to.",
    );
  }
  if (!input.employees.has(subject)) {
    return fail(
      "subject_unknown",
      "The Salesman's linked employee record is not in the employee master, so the org chart cannot place him.",
    );
  }

  const visited = new Set<string>([subject]);
  let current = subject;

  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    const managerId = input.managerOf.get(current);
    if (!managerId) {
      return depth === 1
        ? fail("no_manager", "Nobody is recorded above the Salesman on the org chart.")
        : fail(
            "chain_exhausted",
            "Everybody above the Salesman on the org chart is unable to verify (left, no active account, or no verification permission).",
          );
    }
    if (visited.has(managerId)) {
      return fail("cycle", "The org chart loops back on itself above the Salesman, so it cannot be followed.");
    }
    visited.add(managerId);
    current = managerId;

    const employee = input.employees.get(managerId);
    if (!employee || !employee.onTheBooks) {
      skipped.push({ employeeId: managerId, reason: "left" });
      continue;
    }

    const accounts = input.accountsByEmployee.get(managerId) ?? [];
    if (accounts.length === 0) {
      skipped.push({ employeeId: managerId, reason: "no_account" });
      continue;
    }
    if (accounts.length > 1) {
      return fail(
        "ambiguous_account",
        "More than one MahekOne account is linked to a manager on the Salesman's reporting line, so it cannot be said which of them verifies.",
      );
    }
    const account = accounts[0];
    if (!account.active) {
      skipped.push({ employeeId: managerId, reason: "inactive" });
      continue;
    }
    if (!account.canVerify) {
      skipped.push({ employeeId: managerId, reason: "cannot_verify" });
      continue;
    }
    if (input.excludeUserIds?.has(account.userId)) {
      /* The Salesman himself can only reach here through a loop that `visited`
         already refused; any other excluded account is simply not a candidate. */
      continue;
    }
    if (input.creatorUserId && account.userId === input.creatorUserId) {
      return fail(
        "creator_is_verifier",
        "The person who raised this lead is the manager who would verify it, so they cannot.",
        account.userId,
      );
    }
    return { ok: true, verifierUserId: account.userId, verifierEmployeeId: managerId, depth, skipped };
  }

  return fail("cycle", "The org chart above the Salesman is deeper than any real reporting line and cannot be followed.");
}
