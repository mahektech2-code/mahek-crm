/* ---------------------------------------------------------------------------
 * WHICH APP A PATH BELONGS TO — pure and client-safe.
 *
 * It lived inside `proxy.ts`, which names the app on every request. The
 * notification bell asks the same question in the browser (which app is this
 * screen, and which app does this notification point into), and a second copy
 * of the prefix list is the one that would drift.
 * ------------------------------------------------------------------------- */

/**
 * URL prefix → app id. The `field` app is deliberately absent: it is MBOS's
 * handset, it has no browser route, and the API the handset actually calls
 * carries its own principal from a bearer token rather than from a path.
 */
export const APP_ROUTES: ReadonlyArray<readonly [string, string]> = [
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

export function appFor(pathname: string): string | null {
  for (const [prefix, app] of APP_ROUTES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return app;
  }
  return null;
}
