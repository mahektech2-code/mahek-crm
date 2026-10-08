/* ---------------------------------------------------------------------------
 * WHO MAY DO WHAT ON THE SALES DASHBOARD AND THE HANDSET — the pure half.
 *
 * PURE, and kept apart from `actions/sales.ts` and `services/sales-service.ts`
 * for the reason every rule file beside it is: the actions are `"use server"`,
 * the service is `server-only` and reads the database, and a permission rule
 * that can only be exercised by standing up a request and a database is a rule
 * nobody tests. Everything here takes what was already read and answers.
 *
 * Four rules, each of which used to be "holding the app is the permission":
 *
 *  - `salesGateRefusal` — the LEVEL and the MODULE behind a Sales Dashboard
 *    action, on top of the grant.
 *  - `scopeStanding` — how far `managerScope` may see, by level.
 *  - `scopeCovers` — whether one salesman is inside a resolved scope, with the
 *    CRM Sales Manager seat read as the narrowing it is rather than as national.
 *  - `handsetSampleRefusal` — which moves a handset may make on a sample.
 * ------------------------------------------------------------------------- */

import type { Role } from "./role-levels";

/**
 * WHAT A SALES DASHBOARD ACTION ASKS OF THE PERSON CALLING IT, beyond the grant.
 *
 * The grant alone was the whole check, and it answered a different question —
 * "were you given the Sales Dashboard" — from the one a decision asks, which is
 * "were you given it as somebody who decides". An associate holding the app to
 * read the team's day could approve leave, release a handset or redraw a
 * manager's patch, because nothing below the layout asked the level. And the
 * module was asked by the LAYOUT only: unticking Holidays took the screen away
 * and left the action that writes a holiday a URL anybody holding the app
 * could post.
 *
 * `modulesAsked` is any-of: a decision reached from several screens — leave is
 * decided on Leave AND on Approvals — opens for whoever holds one of them.
 *
 * Null means allowed; a string is the sentence the refusal carries.
 */
export function salesGateRefusal(input: {
  /** The level held in the Sales Dashboard — null means no grant at all. */
  level: Role | null;
  /** A platform administrator holds every LEVEL by construction — not every grant. */
  platformAdmin: boolean;
  needManager: boolean;
  modulesAsked: readonly string[];
  modulesHeld: readonly string[];
}): string | null {
  /* The grant first, for everybody. A platform administrator holds every
     LEVEL, but the Sales Dashboard is still an app somebody has to be given —
     the layout redirects anybody without it, and so does every action here. */
  if (input.level === null) {
    return "The Sales Dashboard has not been granted to you.";
  }
  if (
    input.needManager &&
    !input.platformAdmin &&
    input.level !== "manager" &&
    input.level !== "admin"
  ) {
    return "That is a decision for a manager of the Sales Dashboard. You hold it as an associate, which lets you read the team's work but not decide on it.";
  }
  if (input.modulesAsked.length && !input.modulesAsked.some((k) => input.modulesHeld.includes(k))) {
    return "The screen this belongs to has not been granted to you on the Sales Dashboard.";
  }
  return null;
}

/**
 * HOW FAR `managerScope` LOOKS, before any territory is read.
 *
 *  - `national`  — everybody. A platform administrator, the founder's desk
 *    (company-wide by decision), and a script with no session.
 *  - `territory` — the regional rule: a manager or an app administrator is
 *    narrowed by their `region` rows, and has none means national.
 *  - `own`       — their own book and nothing else. An associate.
 *
 * THE OWN ARM IS THE FIX. `managerScope` read no level at all, so a plain
 * associate — a telecaller on `/crm/leads`, a salesman given the Sales
 * Dashboard to read his own day — has no `region` row and was answered
 * NATIONAL: every lead in the company, every salesman's trail and every
 * check-in photograph by id. It failed open, silently, for exactly the people
 * the narrowing was never written for.
 *
 * WHICH APP'S LEVEL is read: the app the request is in, where that is the CRM
 * or the Sales Dashboard; anything else — an API route under `/api/sales`, the
 * launcher's badge, `/api/attachments` — names no app and is read against the
 * Sales Dashboard, which is the only app whose screens this scope draws.
 */
export type ScopeStanding = "national" | "territory" | "own";

export function scopeStanding(input: {
  platformAdmin: boolean;
  /** The app on the request (`x-mahek-app`), or null. */
  requestApp: string | null;
  /** Level held in the request's own app — read only for founder/crm/sales. */
  levelInRequestApp: Role | null;
  /** Level held on the Sales Dashboard — the fallback where no app is named. */
  levelInSales: Role | null;
}): ScopeStanding {
  if (input.platformAdmin) return "national";
  if (input.requestApp === "founder" && input.levelInRequestApp !== null) return "national";
  const level =
    input.requestApp === "crm" || input.requestApp === "sales"
      ? input.levelInRequestApp
      : input.levelInSales;
  if (level === "manager" || level === "admin") return "territory";
  return "own";
}

/**
 * IS THIS SALESMAN INSIDE THE SCOPE — for the checks that answer one person at
 * a time: a check-in photograph, a meter reading, a day's verdict.
 *
 * `salesmanIds: null` means national EXCEPT inside the CRM Sales Manager
 * workspace, where `crmSalesManagerScopeFor` leaves it null for a different
 * reason — its narrowing is the `salesManagerId` seat on LEADS, and it has no
 * list of people at all. Reading that null as "everybody" would hand a CRM
 * Sales Manager every salesman's photographs; reading it as nobody is the
 * safe direction, and the photograph checks never run inside that workspace
 * on purpose anyway.
 */
export function scopeCovers(
  scope: { salesmanIds: string[] | null; salesManagerId?: string },
  userId: string,
): boolean {
  if (scope.salesManagerId) return false;
  if (scope.salesmanIds === null) return true;
  return scope.salesmanIds.includes(userId);
}

/**
 * §15's machine, as the HANDSET may walk it.
 *
 * `lead-samples.ts` holds the office's copy and it is not exported — it lives
 * in a `"use server"` file, where only async functions may be. This is the same
 * table, and the difference is the two decisions: `approved` and `rejected` are
 * the answer to "may this stock go out", which is `sample.approve`, and a
 * handset that could send them would let a salesman approve his own trial.
 * Every other move is his to make — he hands it over, the shop confirms it,
 * the trial ends, the verdict comes in, or it is called off.
 *
 * A move to the state the sample is ALREADY in is accepted: an outbox retrying
 * over a bad connection re-sends the same mark, and refusing the second copy of
 * an answer the office already holds would put it in `/rejections` for ever.
 */
const SAMPLE_MOVES: Record<string, readonly string[]> = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["dispatched", "cancelled"],
  dispatched: ["received", "cancelled"],
  received: ["trial_done", "reviewed", "cancelled"],
  trial_done: ["reviewed", "cancelled"],
  reviewed: [],
  rejected: [],
  cancelled: [],
};

export function handsetSampleRefusal(input: {
  from: string;
  to: string | null | undefined;
  canApprove: boolean;
}): string | null {
  const { from, to } = input;
  if (to == null || to === from) return null;
  if ((to === "approved" || to === "rejected") && !input.canApprove) {
    return "Approving or refusing a sample is a manager's decision, made in the office — a handset cannot record it.";
  }
  const next = SAMPLE_MOVES[from];
  if (!next || !next.includes(to)) {
    return `This sample is ${from.replace(/_/g, " ")} in the office, so it cannot be marked ${to.replace(/_/g, " ")} from here.`;
  }
  return null;
}
