/**
 * Proposing which HRMS employee an account is — PURE, and it never picks.
 *
 * `users.employeeId` is a deliberate answer somebody gives, and the whole
 * reason it exists is that the guess it replaces is wrong on this book. So the
 * job here is not to be cleverer than that guess. It is to propose only the
 * cases where there is exactly one possible answer, and to hand back everything
 * else — named, with the reason — for a person to settle.
 *
 * THE AMBIGUITY THAT MATTERS RUNS BOTH WAYS. Two payroll rows folding onto one
 * account is the obvious direction: the real book carries `Pritesh Doshi` at
 * ₹50,000 and `Pritesh Bipin Doshi` at ₹10, sharing a company mobile, and
 * choosing between them is choosing what somebody is paid. The reverse — two
 * accounts folding onto one payroll row — is the direction that is easy to miss
 * and worse when it happens, because each account looks unambiguous from its
 * own side and the pair would both claim one salary. `proposeEmployeeLinks`
 * checks both; `matchEmployee` alone can only see the first.
 *
 * Three keys, tried in order of how much they prove:
 *   1. email — the strongest, and absent on 56 of 71 rows in the real sheet
 *   2. mobile, normalised to the last ten digits — the sheet writes `+91 `
 *      prefixes, spaces and the occasional hyphen, and a person is not two
 *      people because of how somebody typed their number
 *   3. name, folded — the weakest, and the one that produces the collisions
 *      above, which is exactly why it is last and why a collision is refused
 *
 * A stronger key WINS OUTRIGHT rather than being combined with a weaker one.
 * An email match that disagrees with a name match is not a conflict to report:
 * it is an email match, and the name is a coincidence of two brothers working
 * in the same firm.
 */

export type EmployeeCandidate = {
  id: string;
  employeeCode: string;
  name: string;
  email: string | null;
  companyMobile: string | null;
  personalMobile: string | null;
};

export type AccountToMatch = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

export type EmployeeMatch =
  | { status: "matched"; employeeId: string; on: "email" | "mobile" | "name"; note: null }
  | { status: "ambiguous"; employeeId: null; on: "email" | "mobile" | "name"; note: string }
  | { status: "unmatched"; employeeId: null; on: null; note: null };

/** The last ten digits, or nothing. Anything shorter cannot identify a person. */
export function phoneKey(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export function emailKey(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  return v.includes("@") ? v : null;
}

/** Trim, collapse the whitespace, uppercase — the same fold the party sheet uses. */
export function nameKey(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

function decide(
  on: "email" | "mobile" | "name",
  hits: EmployeeCandidate[],
  what: string,
): EmployeeMatch | null {
  if (hits.length === 0) return null;
  if (hits.length === 1) {
    return { status: "matched", employeeId: hits[0]!.id, on, note: null };
  }
  return {
    status: "ambiguous",
    employeeId: null,
    on,
    note: `${hits.length} employees share ${what}: ${hits.map((h) => `${h.employeeCode} ${h.name}`).join(", ")}`,
  };
}

export function matchEmployee(
  account: AccountToMatch,
  candidates: readonly EmployeeCandidate[],
): EmployeeMatch {
  const em = emailKey(account.email);
  if (em) {
    const hit = decide("email", candidates.filter((c) => emailKey(c.email) === em), `the email ${em}`);
    if (hit) return hit;
  }

  const ph = phoneKey(account.phone);
  if (ph) {
    const hit = decide(
      "mobile",
      candidates.filter((c) => phoneKey(c.companyMobile) === ph || phoneKey(c.personalMobile) === ph),
      `the number ${ph}`,
    );
    if (hit) return hit;
  }

  const nm = nameKey(account.name);
  if (nm) {
    const hit = decide("name", candidates.filter((c) => nameKey(c.name) === nm), `the name ${account.name}`);
    if (hit) return hit;
  }

  return { status: "unmatched", employeeId: null, on: null, note: null };
}

export type LinkProposal =
  | { account: AccountToMatch; status: "matched"; employeeId: string; on: "email" | "mobile" | "name"; note: null }
  | { account: AccountToMatch; status: "ambiguous"; employeeId: null; on: "email" | "mobile" | "name" | null; note: string }
  | { account: AccountToMatch; status: "unmatched"; employeeId: null; on: null; note: null };

/**
 * Every account at once, so the reverse collision can be seen.
 *
 * An account that matched cleanly on its own is demoted to `ambiguous` if some
 * other account matched the same employee — neither is written, both are
 * reported, and a person decides. Writing either would give one payroll row to
 * two people, which the unique index would then refuse anyway; catching it here
 * means the run says WHICH two accounts rather than dying on a constraint.
 */
export function proposeEmployeeLinks(
  accounts: readonly AccountToMatch[],
  candidates: readonly EmployeeCandidate[],
): LinkProposal[] {
  const first = accounts.map((account) => ({ account, ...matchEmployee(account, candidates) }));

  const claimants = new Map<string, AccountToMatch[]>();
  for (const p of first) {
    if (p.status !== "matched") continue;
    const list = claimants.get(p.employeeId) ?? [];
    list.push(p.account);
    claimants.set(p.employeeId, list);
  }

  return first.map((p): LinkProposal => {
    if (p.status !== "matched") return p as LinkProposal;
    const others = claimants.get(p.employeeId) ?? [];
    if (others.length <= 1) return p as LinkProposal;
    const who = others.map((a) => a.name).join(", ");
    return {
      account: p.account,
      status: "ambiguous",
      employeeId: null,
      on: p.on,
      note: `${others.length} accounts match the same employee (${who}) — one payroll row cannot belong to two people`,
    };
  });
}
