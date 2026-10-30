/* ---------------------------------------------------------------------------
 * THE PAGES AN OUTSIDER IS SENT. A customer's order tracking link (`/t/…`), the
 * older consignment link (`/track/…`) and a vendor's purchase order (`/po/…`)
 * open with no sign-in: the token in the address is the key. Nothing else here
 * is for anybody outside Mahek.
 *
 * Two rules hang on this list, and it is PURE so the browser and the request
 * proxy read the same one:
 *
 * - these pages carry none of the staff app's chrome — no notification bell
 *   polling for a session, no "MahekOne has been updated" banner;
 * - where `PUBLIC_LINK_HOST` is set (track.mahekindia.com), these pages are
 *   served ONLY there and that host serves nothing else, so the staff
 *   workspace's address never reaches a customer and the public host is not a
 *   second door into it.
 * ------------------------------------------------------------------------- */

export const PUBLIC_PREFIXES = ["/t/", "/track/", "/po/"] as const;

export function isPublicPath(pathname: string | null | undefined): boolean {
  return !!pathname && PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/** What the public host may also serve: the page's own scripts, styles and the Mahek logo as its icon. */
export const ICON_PATHS = ["/favicon.ico", "/icon.png", "/apple-icon.png"] as const;

export function isPublicAsset(pathname: string): boolean {
  return pathname.startsWith("/_next/") || (ICON_PATHS as readonly string[]).includes(pathname) || pathname === "/robots.txt";
}

/** A host as written in the setting or a Host header: lower case, no port, no scheme. */
export function bareHost(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  return t || null;
}

/**
 * What the proxy does with a request, given the public host (or none):
 * - `pass` — serve it as usual;
 * - `refuse` — the public host asked for a staff page: answered 404, never redirected,
 *   so the public host does not even reveal where the workspace lives;
 * - `redirect` — a public page asked on the staff host: sent to the public host,
 *   so links already sent keep working and every new visit lands there.
 */
export function publicRouting(host: string | null, pathname: string, publicHost: string | null): { kind: "pass" } | { kind: "refuse" } | { kind: "redirect"; to: string } {
  const pub = bareHost(publicHost);
  if (!pub) return { kind: "pass" };
  const h = bareHost(host);
  if (h === pub) return isPublicPath(pathname) || isPublicAsset(pathname) ? { kind: "pass" } : { kind: "refuse" };
  if (isPublicPath(pathname)) return { kind: "redirect", to: `https://${pub}` };
  return { kind: "pass" };
}

/**
 * The origin a link sent OUTSIDE is written with: the public host where one is
 * set, else the app's own (`APP_URL`). Staff links — a password reset, a
 * notification — keep using the app's.
 */
export function publicLinkOrigin(): string | null {
  const pub = bareHost(process.env.PUBLIC_LINK_HOST);
  if (pub) return `https://${pub}`;
  return process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, "") : null;
}
