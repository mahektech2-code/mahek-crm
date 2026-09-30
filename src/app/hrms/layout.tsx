import { listUserApps } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { listNotifications } from "@/lib/queries";
import { requireHrmsApp } from "@/lib/hrms/access";
import { HRMS_GROUPS, hrmsHref } from "@/lib/hrms/registry";
import { hrmsNavCounts } from "@/lib/hrms/counts";
import { HrmsShell, type NavGroup } from "./_ui/hrms-shell";

/**
 * The HRMS's shell.
 *
 * The grant is checked here as well as on the launcher — a bookmarked /hrms
 * must not open for somebody never given it; salaries and home addresses are
 * in here — and the sidebar draws only the screens this person holds. Each
 * screen's page checks its own module again, because a link that is not drawn
 * is a statement to the browser, not a permission.
 */
export default async function HrmsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireHrmsApp();
  const [apps, hat, counts, notifications] = await Promise.all([
    listUserApps(ctx.user.id),
    hatForHeader(ctx.user, "hrms"),
    hrmsNavCounts(ctx),
    listNotifications(ctx.user.id),
  ]);

  const nav: NavGroup[] = HRMS_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    icon: g.icon,
    screens: g.screens
      .filter((s) => ctx.screens.has(s.key))
      .map((s) => ({ key: s.key, label: s.label, href: hrmsHref(s), count: counts[s.key] ?? 0, bottom: s.bottom })),
  })).filter((g) => g.screens.length > 0);

  return (
    <HrmsShell
      nav={nav}
      user={{ name: ctx.user.name, email: ctx.user.email, phone: ctx.user.phone, initials: initialsOf(ctx.user.name), role: ctx.user.role }}
      hat={hat}
      notifications={notifications}
      apps={webApps(apps)}
    >
      {children}
    </HrmsShell>
  );
}
