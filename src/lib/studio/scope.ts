import "server-only";
import { cache } from "react";
import { isPlatformAdmin, levelInApp, scopeForUser, type RequestScope } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";

/* ---------------------------------------------------------------------------
 * WHAT THE STUDIO READS, resolved from the person's STUDIO grant — not from a
 * request header.
 *
 * `resolveScope` learns which app a request is in from a header the proxy
 * writes off the URL. A job, a script or a request that arrives some other way
 * has none, and then falls back to the account's widest level anywhere: an
 * unrelated manager's hat would widen the Studio. A rule about who may see
 * customers cannot depend on that, so every Studio read asks here, and the
 * answer comes from the grant itself.
 *
 *   - a platform administrator: the whole book (`scopeForUser` says so);
 *   - a Studio admin or manager: themselves and their reports, never the company;
 *   - everybody else: their own book.
 *   - no Studio grant at all: their own book, which the module checks then refuse.
 * ------------------------------------------------------------------------- */
export const resolveStudioScope = cache(async function resolveStudioScope(): Promise<RequestScope> {
  const user = await requireUser();
  const level = (await levelInApp(user, "studio")) ?? "associate";
  /* Only a PLATFORM administrator reads the company's book from the Studio, whatever level their Studio grant carries.
     Admin of the Studio alone is read as a manager - themselves and their reports. This rule is here and nowhere else:
     `scopeForUser` and every other screen's `resolveScope` are unchanged. */
  if (await isPlatformAdmin(user)) return { user, role: "admin", scope: { kind: "all", userIds: null } };
  return scopeForUser(user, undefined, { app: "studio", role: level === "admin" ? "manager" : level });
});
