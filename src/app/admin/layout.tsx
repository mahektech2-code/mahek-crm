import { asc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
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
import { AdminShell, type ConsoleStatus, type SearchEntry } from "./_shell/admin-shell";
// The ERP's look, shared — see styles/v4-theme.css. The shell carries the marker.
import "@/styles/v4-theme.css";

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
  const [hat, notifications, attention, feedback, people] = await Promise.all([
    hatForHeader(ctx.user, via),
    listNotifications(ctx.user.id),
    attentionItems(),
    feedbackCounts(),
    /* People are searchable from the header — the platform administrator's
       directory; a settings manager searches screens and settings only. */
    ctx.isPlatformAdmin
      ? db
          .select({ id: users.id, name: users.name, email: users.email, phone: users.phone })
          .from(users)
          .orderBy(asc(users.name))
      : Promise.resolve([] as Array<{ id: string; name: string; email: string | null; phone: string | null }>),
  ]);

  const may = (item: AdminNavItem) =>
    (!item.platform || ctx.isPlatformAdmin) && (item.href !== ADMIN.feedback() || ctx.canTriage);
  const row = (item: AdminNavItem): NavRowItem => ({
    href: item.href,
    label: item.label,
    icon: item.icon,
    exact: item.exact,
    match: item.match,
  });

  const pinned = ADMIN_PINNED.filter(may).map(row);
  const groups: NavRowGroup[] = ADMIN_GROUPS.map((g) => ({
    label: g.label,
    icon: g.icon,
    items: g.items.filter(may).map(row),
  })).filter((g) => g.items.length > 0);

  /* Counts the sidebar draws, read off the same attention list Home draws:
     each item is counted on the row whose address it opens. Zero is not drawn. */
  const rows = [...pinned, ...groups.flatMap((g) => g.items)];
  const rowFor = (href: string) => {
    const path = href.split(/[?#]/)[0];
    let best: string | null = null;
    for (const r of rows) {
      for (const pre of [r.href, ...(r.match ?? [])]) {
        if ((path === pre || path.startsWith(pre + "/")) && pre !== ADMIN.home && (!best || pre.length > best.length)) best = r.href;
      }
    }
    return best;
  };
  const counts: Record<string, { n: number; urgent?: boolean }> = {};
  for (const a of attention) {
    const at = rowFor(a.href);
    if (!at) continue;
    const c = (counts[at] ??= { n: 0 });
    c.n += a.n;
    if (a.tone === "danger") c.urgent = true;
  }
  counts[ADMIN.home] = { n: attention.length, urgent: attention.some((a) => a.tone === "danger") };
  counts[ADMIN.feedback()] = { n: feedback.reply, urgent: feedback.reply > 5 };

  /* The console's "Live now": the platform's state in two lines, read off the
     same attention list Home draws, so the two cannot disagree. */
  const urgent = attention.filter((a) => a.tone === "danger").length;
  const toTidy = attention.length - urgent;
  const status: ConsoleStatus =
    urgent > 0
      ? { tone: "danger", title: `${urgent} need${urgent === 1 ? "s" : ""} an admin`, line: toTidy ? `${toTidy} more to tidy` : "Open Home" }
      : toTidy > 0
        ? { tone: "warn", title: "Running normally", line: `${toTidy} to tidy` }
        : { tone: "ok", title: "All systems normal", line: "Nothing waiting" };

  const search: SearchEntry[] = [
    ...people.map((p) => ({ label: p.name, hint: p.email ?? p.phone ?? "Person", href: ADMIN.person(p.id) })),
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
      status={status}
    >
      {children}
    </AdminShell>
  );
}
