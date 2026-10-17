import "server-only";
import { cookies } from "next/headers";
import { isManager } from "./auth";
import type { User } from "@/db/schema";
import type { AppId } from "./apps";
import { levelInApp, requestHat } from "./access-control";

export type Scope = "mine" | "team";

const SCOPE_COOKIE = "mahekone_scope";

/**
 * WHETHER THIS PERSON IS A MANAGER *HERE*.
 *
 * `isManager(user)` reads `users.role`, which is the widest level held in ANY
 * app — so a telecaller who was also made a manager of Reports, or of HRMS,
 * was drawn the My book / Team switch in the CRM, shown the team dashboard and
 * the team EOD, and had the CRM's badges counted team-wide. Seniority in one
 * app is not seniority in another.
 *
 * So the level is read off the grant for the app being asked about: the one
 * named, where a caller knows (the CRM's own badge counts are the CRM's even
 * when the launcher asks for them), and otherwise the app the request is in,
 * from the header the proxy writes. Only where neither exists — a job, a test
 * — does the account's own level stand, which is the old answer exactly.
 */
export async function managesHere(user: User, app?: AppId): Promise<boolean> {
  if (app) {
    const level = await levelInApp(user, app);
    return level !== null && level !== "associate";
  }
  const hat = await requestHat(user);
  if (hat) return hat.role !== "associate";
  return isManager(user);
}

/**
 * Managers can flip every screen between their own book and the whole team's.
 * Associates are always scoped to themselves — the cookie cannot widen it.
 *
 * "Manager" means a manager of THIS app — see `managesHere`. `scopeForUser`
 * reads this for the narrowing preference only after it has decided the level
 * itself, from the same grant, so the two cannot disagree inside a request.
 */
export async function getScope(user: User, app?: AppId): Promise<Scope> {
  if (!(await managesHere(user, app))) return "mine";
  // Managers carry few accounts of their own, so the team is the useful
  // default — including outside a request, where there is no cookie to read.
  const chosen = await readCookie(SCOPE_COOKIE);
  return chosen === "mine" ? "mine" : "team";
}

/**
 * This cookie is a display preference, not a permission — nothing here can
 * widen what a user may read. Outside a request (jobs, scripts, tests) there is
 * no jar, and falling back to the default is correct rather than fatal.
 */
async function readCookie(name: string): Promise<string | undefined> {
  try {
    return (await cookies()).get(name)?.value;
  } catch {
    return undefined;
  }
}

export function scopeLabel(scope: Scope, user: User): string {
  return scope === "team" ? "Whole team" : `${user.name}'s book`;
}

export const SCOPE_COOKIE_NAME = SCOPE_COOKIE;
