/**
 * Which addresses the workday lock keeps shut, and where it may send somebody
 * back to. Pure, so `requireUser` (server) and the launcher (browser) read the
 * same rule. See AGENTS.md, "The workday clock".
 */

/** A page the lock keeps shut: everything but the launcher (where the lock is drawn), sign-in and the API. */
export function lockGuardsPage(path: string | null | undefined): boolean {
  if (!path || !path.startsWith("/")) return false;
  const bare = path.split("?")[0];
  if (bare === "/apps" || bare.startsWith("/apps/")) return false;
  if (bare === "/api" || bare.startsWith("/api/")) return false;
  if (bare === "/login" || bare.startsWith("/login/")) return false;
  return true;
}

/** The `next` address the launcher may follow once the day is unlocked: a page on this site, never another site. */
export function safeNext(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  if (!lockGuardsPage(next)) return null;
  return next;
}
