import { ROUTE_MOTION } from '../ui/route-motion';

/**
 * WHICH ADDRESSES ARE SCREENS ON THIS PHONE.
 *
 * A notification carries an `href`, and for a long time the office sent its
 * own web route there — `/crm/performance`, `/field/tasks`,
 * `/accounts/order-changes`. Pushed as-is, each landed on expo-router's
 * developer "Unmatched Route" page, which reads to a salesman as the app
 * having broken. So an address is checked against the screens this build
 * actually has before anything navigates to it.
 *
 * `ROUTE_MOTION` is already the list of every file in `app/`, pinned by a test
 * that fails when a screen is added or removed without it — so this reads that
 * rather than keeping a second list that would drift from it.
 */
const NOT_A_DESTINATION = new Set(['index', '+not-found']);

/** The four tab roots. Reached by going back to them, never by stacking a copy. */
export const TAB_ROOTS = ['home', 'journey', 'customers', 'more'] as const;

/** The screen an address names: the first path segment, or null. */
export function screenOf(href: string): string | null {
  if (typeof href !== 'string' || !href.startsWith('/')) return null;
  const seg = href.slice(1).split(/[/?#]/)[0];
  return seg || null;
}

/** True only for an address whose first segment is a screen in this build. */
export function isMbosRoute(href: unknown): href is string {
  if (typeof href !== 'string') return false;
  const screen = screenOf(href);
  /* Every screen on the phone is one flat file in `app/`, so an address with a
     second path segment is never one of them — even where its first segment
     happens to share a name: the office's `/accounts/order-changes` is not the
     phone's `/accounts`. */
  const path = href.split(/[?#]/)[0];
  if (path.slice(1).includes('/')) return false;
  return screen != null && screen in ROUTE_MOTION && !NOT_A_DESTINATION.has(screen);
}

export function isTabRoot(href: string): boolean {
  const screen = screenOf(href);
  return screen != null && (TAB_ROOTS as readonly string[]).includes(screen);
}

/** An address this phone can open, or the fallback when it cannot. */
export function safeHref(href: unknown, fallback = '/notifications'): string {
  return isMbosRoute(href) ? href : fallback;
}

/**
 * WHERE "BACK" GOES.
 *
 * A screen is told where it came from by `?from=`, which carries only the
 * screen's NAME — `from=lead` — and a dozen screens compare it to a word
 * ("did I come from a visit?"), so it stays a word. What it could not carry
 * was WHICH lead: the bell, opened from a lead, came back to `/lead` with no
 * id, and the screen said "This lead is not on this phone".
 *
 * So the full address rides beside it as `back`, and is preferred when it is
 * there. Anything that is not a screen on this phone falls back — two screens
 * named `day` as where to go back to, and no `day` screen has ever existed, so
 * "‹ Day" landed on the unmatched-route page.
 */
export function backTarget(
  params: { from?: string | string[]; back?: string | string[] },
  fallback: string,
): string {
  const fb = isMbosRoute('/' + fallback) ? '/' + fallback : '/home';
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const back = one(params.back);
  if (back) {
    const href = back.startsWith('/') ? back : '/' + back;
    if (isMbosRoute(href)) return href;
  }
  const from = one(params.from);
  if (!from) return fb;
  const href = from.startsWith('/') ? from : '/' + from;
  return isMbosRoute(href) ? href : fb;
}

/**
 * The query a screen adds when it opens another: `?from=<this screen>`, and
 * `&back=<this address>` when this address carries anything worth keeping.
 */
export function fromQuery(pathname: string, params: Record<string, string | string[] | undefined>): string {
  const path = pathname && pathname !== '/' ? pathname : '/home';
  const here = screenOf(path) ?? 'home';
  /* This screen's own `from` and `back` are dropped, so going back twice does
     not grow an address inside an address. */
  const query = Object.entries(params)
    .filter(([k, v]) => k !== 'from' && k !== 'back' && v != null)
    .flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, String(v)]]))
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
  return `?from=${here}` + (query ? '&back=' + encodeURIComponent(path + '?' + query) : '');
}
