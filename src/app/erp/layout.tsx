import { listUserApps } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { AccountMenu } from "@/components/shell/account-menu";
import { requireErpApp } from "@/lib/erp/access";
import { ERP_GROUPS, erpHref } from "@/lib/erp/registry";
import { erpNavCounts } from "@/lib/erp/counts";
import { getConfig } from "@/lib/config/store";
import { ErpShell, type NavGroup } from "./_ui/erp-shell";

/**
 * The ERP's shell.
 *
 * The grant is checked here as well as on the launcher — a bookmarked /erp must
 * not open for somebody never given it — and the sidebar draws only the screens
 * this person holds. Each screen's page checks its own module again, because a
 * link that is not drawn is a statement to the browser, not a permission.
 */
export default async function ErpLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireErpApp();
  const [apps, hat, counts, config] = await Promise.all([listUserApps(ctx.user.id), hatForHeader(ctx.user, "erp"), erpNavCounts(ctx), getConfig()]);

  const nav: NavGroup[] = ERP_GROUPS.map((g) => {
    const screens = g.screens
      .filter((s) => s.built && ctx.screens.has(s.key))
      .map((s) => ({ key: s.key, label: s.label, href: erpHref(s), count: counts[s.key] ?? 0 }));
    return {
      id: g.id,
      label: g.label,
      icon: g.icon,
      single: screens.length === 1 && (g.screens.length === 1 || g.id === "dashboard" || g.id === "settings"),
      screens,
    };
  }).filter((g) => g.screens.length > 0);

  return (
    <ErpShell
      nav={nav}
      user={{ name: ctx.user.name, title: hat.label, initials: initialsOf(ctx.user.name) }}
      godowns={ctx.assignedGodowns.map((g) => ({ id: g.id, name: g.name }))}
      working={ctx.workingGodown ? { id: ctx.workingGodown.id, name: ctx.workingGodown.name } : null}
      voice={config["erp.ai.voice.enabled"]}
      switcher={apps.length > 1 ? <AppSwitcher apps={webApps(apps)} current="erp" /> : undefined}
      accountMenu={
        <AccountMenu
          user={{ name: ctx.user.name, email: ctx.user.email, phone: ctx.user.phone, initials: initialsOf(ctx.user.name), role: ctx.user.role }}
          hat={hat}
          variant="header"
        />
      }
    >
      {children}
    </ErpShell>
  );
}
