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
 *    (MBOS), which has no browser screen and so no bell of its own — it is
 *    listed under "All apps";
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
    return appFor(path);
  }
  if (!href && mbosHref) return "field";
  return null;
}

/**
 * Whether a notification belongs in a bell drawn inside `viewApp`. Null view
 * (a screen in no app) shows everything; a general notification shows
 * everywhere.
 */
export function shownIn(itemApp: string | null, viewApp: string | null): boolean {
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
    .filter((r) => r.app !== null && r.app !== viewApp && r.unread > 0)
    .sort((a, b) => b.unread - a.unread || notificationAppName(a.app).localeCompare(notificationAppName(b.app)));
}
