import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/* ---------------------------------------------------------------------------
 * WHICH APP THIS REQUEST IS FOR, named once, at the edge of the request.
 *
 * `app_access.role` is the role a grant is held under — Vikram is a manager in
 * the CRM and a clerk in Accounts — and until now that decided CAPABILITIES
 * only. Scope read `users.role`, the DERIVED widest role somebody holds
 * anywhere, so granting one manager hat on one app widened what that person
 * could READ on every other app, the calling book included.
 *
 * Resolving it needs to know which app is being asked, and `resolveScope()` is
 * called from seventy-three places that have no idea. Threading an argument
 * through all of them would be seventy-three chances to pass the wrong one, and
 * the one that got it wrong would fail OPEN.
 *
 * So the app is derived from the URL exactly once, here, and travels on the
 * request as a header. Every server component, server action and route handler
 * in that request reads the same answer through `headers()`, and nothing has to
 * be passed anything.
 *
 * A server action POSTs to the URL it was rendered from, so it lands in the
 * same app as the screen that offered it — which is what makes this correct for
 * writes and not only for reads.
 * ------------------------------------------------------------------------- */

/** The header the app id travels on. Read by `requestAppId()`. */
export const APP_HEADER = "x-mahek-app";

/**
 * URL prefix → app id. The `field` app is deliberately absent: it is MBOS's
 * handset, it has no browser route, and the API the handset actually calls
 * carries its own principal from a bearer token rather than from a path.
 */
const APP_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["/crm", "crm"],
  ["/accounts", "accounts"],
  ["/orders", "accounts"], // the old slug, still redirected
  ["/sales", "sales"],
  ["/people", "people"],
  ["/reports", "reports"],
  ["/hrms", "hrms"],
  ["/admin", "admin"],
  ["/founder", "founder"],
  ["/enquiries", "enquiries"],
];

export function appFor(pathname: string): string | null {
  for (const [prefix, app] of APP_ROUTES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return app;
  }
  return null;
}

export function proxy(request: NextRequest) {
  const app = appFor(request.nextUrl.pathname);

  const headers = new Headers(request.headers);
  /*
   * STRIPPED FIRST, ALWAYS.
   *
   * This header decides how far somebody can see, and it arrives from the
   * internet. A request carrying its own `x-mahek-app: admin` must not be
   * believed — deleting it before the route match means the only value any
   * handler can ever read is the one this function wrote.
   */
  headers.delete(APP_HEADER);
  if (app) headers.set(APP_HEADER, app);

  return NextResponse.next({ request: { headers } });
}

export const config = {
  /*
   * Everything except the static tree. The header has to be present on API
   * routes and server-action POSTs too, not only on page renders, or a write
   * would resolve its scope differently from the screen that offered it.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
