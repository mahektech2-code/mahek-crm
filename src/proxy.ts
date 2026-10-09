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
 *
 * A route under `/api/` is shared and its own path names no app, so there the
 * answer is the same-host page that made the call — see `appForApi`.
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
  /* The Sales Manager's lead pipeline. It is the Sales Dashboard's `sales.leads`
     module drawn on its own route, and it has to resolve as that app: without
     this line a request here names NO app, and scope falls back to the widest
     level the account holds anywhere — which is a manager elsewhere and an
     associate on the Sales Dashboard reading (and writing) as a manager. */
  ["/sales-lead-pipeline", "sales"],
  ["/people", "people"],
  ["/reports", "reports"], // retired — next.config redirects it to /apps
  ["/hrms", "hrms"],
  ["/admin", "admin"],
  ["/founder", "founder"],
  ["/enquiries", "enquiries"],
  ["/erp", "erp"],
  ["/website", "website"],
  ["/hire", "hire"],
  ["/factory", "factory"],
  /* The factory phone's own API: a station phone sends from a page that may
     be days old, so the app it belongs to is named by the path, not left to
     a Referer an offline-cached page may not carry. */
  ["/api/factory", "factory"],
  ["/docs", "docs"],
];

/**
 * WHICH WORKSPACE, where one app draws more than one scope.
 *
 * `/crm/leads/sales-manager` is the CRM's Sales Manager workspace: the same
 * lead pipeline the Sales Dashboard draws, read through a different scope (the
 * leads whose `sales_manager_id` is the signed-in person). Scope is resolved in
 * services that take no arguments, so — exactly as the app id does — it has to
 * travel on the request. A server action POSTs to the URL it was rendered from,
 * so a write lands in the same workspace as the screen that offered it, which
 * is what keeps a lead you can see a lead you can act on.
 */
export const WORKSPACE_HEADER = "x-mahek-workspace";
export const CRM_SALES_MANAGER_WORKSPACE = "crm-sales-manager";
const CRM_SALES_MANAGER_PREFIX = "/crm/leads/sales-manager";

export function workspaceFor(pathname: string): string | null {
  return pathname === CRM_SALES_MANAGER_PREFIX || pathname.startsWith(CRM_SALES_MANAGER_PREFIX + "/")
    ? CRM_SALES_MANAGER_WORKSPACE
    : null;
}

export function appFor(pathname: string): string | null {
  for (const [prefix, app] of APP_ROUTES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return app;
  }
  return null;
}

/**
 * THE APP AN API CALL IS MADE FROM, which its own URL cannot say.
 *
 * `/api/search`, `/api/customer-info`, `/api/payment-panel` and the rest are
 * shared by several apps, so their path names none — and with no header,
 * `resolveScope` fell back to `users.role`, the WIDEST level held anywhere. A
 * telecaller who was also made a manager of Reports searched the CRM's book as
 * a manager, from the CRM's own search box, which is precisely the widening
 * the per-app header exists to prevent; it simply had not reached the API.
 *
 * The screen that made the call is in the `Referer`, and the browser writes
 * it. Only a SAME-ORIGIN referrer is believed: a page on another site has no
 * business naming which of our apps a request is in, and a malformed or
 * missing one names nothing, which is the old fallback exactly.
 *
 * Why it is safe to take from the request at all, when this header is
 * otherwise stripped precisely because the internet sends it: naming an app
 * grants nothing. `requestHat` still requires a real grant in that app and
 * reads its level off `app_access`, so a forged referrer can only select
 * between hats the caller genuinely wears. The one place an app widens SEEING
 * — the ledger desk and the Founder Command Centre see every book — is a
 * place the caller could already read in full by opening that app.
 */
export function appForApi(
  pathname: string,
  referer: string | null,
  /** The host the request arrived for — the Host header, which Caddy passes through. */
  host: string | null,
): string | null {
  if (!pathname.startsWith("/api/")) return null;
  if (!referer || !host) return null;
  let from: URL;
  try {
    from = new URL(referer);
  } catch {
    return null;
  }
  /* HOST, not origin. Behind Caddy the app sees plain http while the browser's
     Referer says https, so comparing whole origins would refuse every real
     request in production and quietly fall back to the widest level. */
  if (from.host !== host) return null;
  return appFor(from.pathname);
}

export function proxy(request: NextRequest) {
  const app =
    appFor(request.nextUrl.pathname) ??
    appForApi(
      request.nextUrl.pathname,
      request.headers.get("referer"),
      request.headers.get("host") ?? request.nextUrl.host,
    );

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

  /* Stripped for the same reason: it narrows scope, and it arrives from the
     internet. Only this function may write it. */
  headers.delete(WORKSPACE_HEADER);
  const workspace = workspaceFor(request.nextUrl.pathname);
  if (workspace) headers.set(WORKSPACE_HEADER, workspace);

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
