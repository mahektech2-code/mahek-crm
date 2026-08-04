import "server-only";
import { cookies } from "next/headers";
import { isManager } from "./auth";
import type { User } from "@/db/schema";

export type Scope = "mine" | "team";

const SCOPE_COOKIE = "mahekone_scope";
const DENSITY_COOKIE = "mahekone_density";

/**
 * Managers can flip every screen between their own book and the whole team's.
 * Telecallers are always scoped to themselves — the cookie cannot widen it.
 */
export async function getScope(user: User): Promise<Scope> {
  if (!isManager(user)) return "mine";
  // Managers carry few accounts of their own, so the team is the useful
  // default — including outside a request, where there is no cookie to read.
  const chosen = await readCookie(SCOPE_COOKIE);
  return chosen === "mine" ? "mine" : "team";
}

export async function getDensity(): Promise<"comfortable" | "compact"> {
  return (await readCookie(DENSITY_COOKIE)) === "compact" ? "compact" : "comfortable";
}

/**
 * These two cookies are display preferences, not permissions — nothing here can
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
export const DENSITY_COOKIE_NAME = DENSITY_COOKIE;
