import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { isManager, requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { canFor, isPlatformAdmin as holdsPlatformAdmin } from "@/lib/access-control";
import { ADMIN } from "@/lib/admin-routes";
import { SETTINGS_PAGES, type SettingsPage } from "@/lib/config/settings-pages";
import { isConsoleConfirmed, keepConsoleConfirmed } from "@/lib/console-confirm";

/* ---------------------------------------------------------------------------
 * Who is looking at the console, worked out once per request.
 *
 * The layout asks and so does every page — a page is a URL, and a URL can be
 * reached without the sidebar that would have hidden it — so it is cached for
 * the request rather than asked twice.
 *
 * Two kinds of person get in. A platform administrator holds the `admin` app
 * AT THE ADMIN LEVEL and sees everything. A manager who may write configuration sees the settings
 * of the apps they hold, the business data, and the feedback their team sent,
 * which is what they could reach before the console was split into pages.
 * ------------------------------------------------------------------------- */

export type AdminContext = {
  user: Awaited<ReturnType<typeof requireUser>>;
  apps: Awaited<ReturnType<typeof listUserApps>>;
  isPlatformAdmin: boolean;
  /** May write configuration at all — the server checks again on every save. */
  canWriteConfig: boolean;
  /** Answering feedback is a manager's or a platform administrator's. */
  canTriage: boolean;
  /** The settings pages this person may open. */
  settingsPages: SettingsPage[];
};

export const adminContext = cache(async (): Promise<AdminContext> => {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  /* Admin ON THE ADMIN CONSOLE, not merely holding it: a manager of the
     console writes the settings of the apps they hold and nothing more. */
  const isPlatformAdmin = await holdsPlatformAdmin(user);
  const canWriteConfig = await canFor(user, "config.write");

  const settingsPages = SETTINGS_PAGES.filter(
    (p) => isPlatformAdmin || (canWriteConfig && p.owners.some((a) => apps.includes(a))),
  );

  if (!isPlatformAdmin && settingsPages.length === 0) redirect("/apps");

  /* The password, again: see `lib/console-confirm.ts`. Asked after the access
     check, so somebody with no console at all is sent to their apps rather
     than asked for a password that would open nothing. */
  if (!(await isConsoleConfirmed())) redirect("/login/confirm?next=/admin");
  await keepConsoleConfirmed();

  return {
    user,
    apps,
    isPlatformAdmin,
    canWriteConfig,
    canTriage: isManager(user) || isPlatformAdmin,
    settingsPages,
  };
});

/**
 * A platform section. Somebody who reached it by URL without the grant is sent
 * to the first page they can open, never shown a refusal — the sidebar is not
 * a list of things to be told no about, and neither is the address bar.
 */
export async function requirePlatformAdmin(): Promise<AdminContext> {
  const ctx = await adminContext();
  if (!ctx.isPlatformAdmin) redirect(firstPageFor(ctx));
  return ctx;
}

export function firstPageFor(ctx: AdminContext): string {
  if (ctx.isPlatformAdmin) return ADMIN.home;
  return ADMIN.settingsFor(ctx.settingsPages[0].id);
}
