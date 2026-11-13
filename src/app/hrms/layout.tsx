import { listUserApps } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { listNotifications } from "@/lib/queries";
import { holdsScreen, requireHrmsApp } from "@/lib/hrms/access";
import { HRMS_GROUPS, hrmsHref, hrmsKeysOf } from "@/lib/hrms/registry";
import { hrmsNavCounts } from "@/lib/hrms/counts";
import { HrmsShell, type NavGroup } from "./_ui/hrms-shell";
import "@/styles/v4-theme.css";

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
      .filter((s) => holdsScreen(ctx, s))
      .map((s) => ({
        key: s.key,
        label: s.label,
        nav: s.nav,
        short: s.short,
        icon: s.icon,
        href: hrmsHref(s),
        /* A screen's badge is what is waiting on all of its tabs. */
        count: hrmsKeysOf(s).reduce((n, k) => n + (ctx.screens.has(k) ? (counts[k] ?? 0) : 0), 0),
        bottom: s.bottom,
      })),
  })).filter((g) => g.screens.length > 0);

  return (
    <>
    {/* The v4 look is set in Geist, as the ERP's, the CRM's and the Sales
        Dashboard's are. React hoists a precedence stylesheet into the head once. */}
    {/* eslint-disable-next-line @next/next/no-page-custom-font */}
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap" precedence="default" />
    <HrmsShell
      nav={nav}
      user={{ name: ctx.user.name, email: ctx.user.email, phone: ctx.user.phone, initials: initialsOf(ctx.user.name), role: ctx.user.role }}
      hat={hat}
      notifications={notifications}
      apps={webApps(apps)}
    >
      {children}
    </HrmsShell>
    </>
  );
}
