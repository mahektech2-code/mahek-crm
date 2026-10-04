import { Redirect } from 'expo-router';

/**
 * AN ADDRESS THIS PHONE HAS NO SCREEN FOR goes Home.
 *
 * Without this file expo-router draws its developer "Unmatched Route" page —
 * a URL, a sitemap button and nothing a salesman can act on — which is what a
 * notification carrying the office's web route (`/crm/performance`) opened, and
 * what a back link to a screen that was never built (`/day`) opened. Both are
 * now stopped before they navigate (`isMbosRoute`); this is the net under
 * that, for whatever the next one is. Signed out, the guard in `_layout` takes
 * it on from Home to the sign-in.
 */
export default function NotFound() {
  return <Redirect href="/home" />;
}
