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
  const jar = await cookies();
  const chosen = jar.get(SCOPE_COOKIE)?.value;
  // Managers carry few accounts of their own, so the team is the useful default.
  if (chosen === "mine") return "mine";
  return "team";
}

export async function getDensity(): Promise<"comfortable" | "compact"> {
  const jar = await cookies();
  return jar.get(DENSITY_COOKIE)?.value === "compact" ? "compact" : "comfortable";
}

export function scopeLabel(scope: Scope, user: User): string {
  return scope === "team" ? "Whole team" : `${user.name}'s book`;
}

export const SCOPE_COOKIE_NAME = SCOPE_COOKIE;
export const DENSITY_COOKIE_NAME = DENSITY_COOKIE;
