import { webApps } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { listNotifications } from "@/lib/queries";
import { ADMIN, ADMIN_GROUPS, ADMIN_PINNED, type AdminNavItem } from "@/lib/admin-routes";
import { schemaForPage } from "@/lib/config/settings-schemas";
import { attentionItems } from "@/lib/services/admin-platform-service";
import { feedbackCounts } from "@/lib/services/feedback-service";
import type { NavRowGroup, NavRowItem } from "@/components/shell/collapsible-nav";
import { adminContext } from "./_shell/context";
import { AdminShell, type SearchEntry } from "./_shell/admin-shell";

export const metadata = { title: "Admin Console · MahekOne" };

/**
 * The console's frame, and the gate in front of every page in it.
 *
 * Access is checked here and again on each page: a bookmarked /admin must not
 * open for somebody never given it, and a page is a URL that can be reached
 * without this sidebar. The sidebar draws only what this person can open.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await adminContext();
  // The level that let them in: the Admin app's for a platform administrator,
  // otherwise the app whose settings they configure — the Admin app's would
  // read "No role" on somebody who holds none of it.
  const via = ctx.isPlatformAdmin ? "admin" : (ctx.settingsPages[0].owners.find((a) => ctx.apps.includes(a)) ?? "admin");
  const [hat, notifications, attention, feedback] = await Promise.all([
    hatForHeader(ctx.user, via),
    listNotifications(ctx.user.id),
    attentionItems(),
    feedbackCounts(),
  ]);

  const may = (item: AdminNavItem) =>
    (!item.platform || ctx.isPlatformAdmin) && (item.href !== ADMIN.feedback() || ctx.canTriage);
  const row = (item: AdminNavItem): NavRowItem => ({ href: item.href, label: item.label, icon: item.icon, exact: item.exact });

  const settingsItems: NavRowItem[] = [
    { href: ADMIN.settings, label: "All settings", icon: "grid", exact: true },
    ...ctx.settingsPages.map((p) => ({ href: ADMIN.settingsFor(p.id), label: p.label, icon: p.icon })),
  ];

  const pinned = ADMIN_PINNED.filter(may).map(row);
  const groups: NavRowGroup[] = ADMIN_GROUPS.map((g) => ({
    label: g.label,
    icon: g.icon,
    items: g.label === "Settings" ? settingsItems : g.items.filter(may).map(row),
  })).filter((g) => g.items.length > 0);

  // Counts the sidebar draws. Every one is a query, and a zero is not drawn.
  const attentionAt = (href: string) => attention.find((a) => a.href === href)?.n ?? 0;
  const counts: Record<string, number> = {
    [ADMIN.home]: attention.filter((a) => a.tone === "danger").length,
    [ADMIN.feedback()]: feedback.new,
    [ADMIN.catalogue()]: attentionAt(ADMIN.catalogue("duplicates")),
    [ADMIN.sheets()]: attentionAt(ADMIN.sheets("issues")),
  };

  const search: SearchEntry[] = [
    ...pinned.map((i) => ({ label: i.label, hint: "Screen", href: i.href })),
    ...groups.flatMap((g) => g.items.map((i) => ({ label: i.label, hint: g.label, href: i.href }))),
    ...ctx.settingsPages.flatMap((p) =>
      (schemaForPage(p.id)?.tabs ?? []).flatMap((t) =>
        t.groups.flatMap((grp) =>
          grp.fields.map((f) => ({
            label: f.label,
            hint: `${p.label} › ${t.label}`,
            key: f.control === "entity" ? undefined : f.key,
            href: `${ADMIN.settingsFor(p.id, t.key)}#${f.key}`,
          })),
        ),
      ),
    ),
  ];

  return (
    <AdminShell
      pinned={pinned}
      groups={groups}
      counts={counts}
      search={search}
      user={{
        name: ctx.user.name,
        email: ctx.user.email,
        phone: ctx.user.phone,
        initials: initialsOf(ctx.user.name),
        role: ctx.user.role,
      }}
      hat={ctx.isPlatformAdmin ? { ...hat, label: "Platform admin" } : hat}
      notifications={notifications}
      apps={webApps(ctx.apps)}
    >
      {children}
    </AdminShell>
  );
}
