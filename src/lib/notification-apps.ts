/* ---------------------------------------------------------------------------
 * WHICH APP A NOTIFICATION BELONGS TO — pure and client-safe.
 *
 * The bell used to be one list per PERSON, drawn the same in every app: an
 * ERP storekeeper who also holds the CRM opened the ERP's bell and read about
 * a declined CRM order, and the badge on a godown tablet counted leads. A
 * notification belongs to the app its link opens, so that is what the bell now
 * filters by — the same prefix list `proxy.ts` names a request's app with.
 *
 * It is DERIVED from the link, never stored. Fifty places write a
 * notification, a dozen of them with their own insert rather than through
 * `notifyUsers`, and every one of them already says where the notification
 * goes. A column every writer had to remember to fill would be empty on the
 * one that forgot; reading the link is right for all of them, for every row
 * already written, and for the next writer nobody has met yet.
 *
 * Two answers that are not an app:
 *  - a notification with no web link but a HANDSET link is the field app's
 *    (MBOS), which has no browser screen: it goes to the phone and is shown in no
 *    bell on the web, not even under "All apps";
 *  - a notification with neither, or a link into no app (`/feedback`, the
 *    launcher), is GENERAL: about the person rather than about one app's work,
 *    so it is shown in every app's bell.
 * ------------------------------------------------------------------------- */

import { appFor } from "./app-routes";
import { APPS } from "./apps";

/** The app a notification's link opens, "field" for a handset-only one, or null (general). */
export function notificationAppOf(href: string | null | undefined, mbosHref?: string | null): string | null {
  if (href && href.startsWith("/")) {
    const path = href.split(/[?#]/, 1)[0];
    /* The Salesman App has no browser screens, so `/field/...` opens nothing on
       this site. Read as a general link it reached every app's bell and 404ed. */
    if (path === "/field" || path.startsWith("/field/")) return "field";
    return appFor(path);
  }
  if (!href && mbosHref) return "field";
  return null;
}

/**
 * Whether a notification goes to the handset: its list and its push.
 *
 * A handset link says so. No link at all is a general notice, which is everyone's.
 * A web link with no handset link belongs to a desk, and a stock alert on the ERP
 * has no business buzzing somebody's phone.
 */
export function reachesHandset(href: string | null | undefined, mbosHref: string | null | undefined): boolean {
  return Boolean(mbosHref) || !href;
}

/**
 * Whether a notification belongs in a bell drawn inside `viewApp`. Null view
 * (a screen in no app) shows everything; a general notification shows
 * everywhere.
 */
export function shownIn(itemApp: string | null, viewApp: string | null): boolean {
  if (itemApp === "field") return false;
  return viewApp === null || itemApp === null || itemApp === viewApp;
}

/** The app's own name, as the launcher prints it; "General" for none. */
export function notificationAppName(app: string | null): string {
  if (app === null) return "General";
  if (app === "field") return "Salesman App";
  return APPS.find((a) => a.id === app)?.name ?? app;
}

export type AppUnread = { app: string | null; unread: number };

/**
 * Unread elsewhere: the apps other than `viewApp` with something unread,
 * biggest first. General notifications are never "elsewhere" — they are
 * already in this bell.
 */
export function unreadElsewhere(byApp: readonly AppUnread[], viewApp: string | null): AppUnread[] {
  if (viewApp === null) return [];
  return byApp
    .filter((r) => r.app !== null && r.app !== "field" && r.app !== viewApp && r.unread > 0)
    .sort((a, b) => b.unread - a.unread || notificationAppName(a.app).localeCompare(notificationAppName(b.app)));
}
