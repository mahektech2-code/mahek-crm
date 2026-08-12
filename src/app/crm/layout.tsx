import { sql } from "drizzle-orm";
import { db } from "@/db";
import { redirect } from "next/navigation";
import { isManager, requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { navForModules } from "@/components/shell/nav";
import { APPS } from "@/lib/apps";
import { getScope } from "@/lib/scope";
import { listNotifications, today } from "@/lib/queries";
import { AppShell } from "@/components/shell/app-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  // One wait, not four. Every one of these is a round trip to a database in
  // another continent, so they run together rather than one after another.
  const [apps, scope, notifications, badges] = await Promise.all([
    listUserApps(user.id),
    getScope(user),
    listNotifications(user.id),
    sidebarBadges(user),
  ]);

  // Access is checked here, not just hidden on the launcher — a bookmarked
  // /crm URL must not open for somebody who was never given the app.
  if (!apps.includes("crm")) redirect("/apps");

  // And the sidebar is narrowed to the screens they hold. This is the courtesy
  // half — each module's own layout runs `requireModule`, because a link that
  // is not drawn is still a URL somebody can type.
  const modules = await listUserModules(user.id, "crm");
  if (modules.length === 0) redirect("/apps");

  return (
    <AppShell
      user={user}
      isManager={isManager(user)}
      scope={scope}
      notifications={notifications}
      badges={badges}
      apps={APPS.filter((a) => apps.includes(a.id))}
      nav={navForModules(modules.map((m) => m.href))}
    >
      {children}
    </AppShell>
  );
}

/** Both sidebar counts in a single query. */
async function sidebarBadges(user: Awaited<ReturnType<typeof requireUser>>) {
  const scope = await getScope(user);
  const teamWide = scope === "team" && isManager(user);
  const day = await today();

  const [row] = await db.execute<{ reminders: number; complaints: number }>(sql`
    select
      (select count(*) from reminders r
        where r.status = 'pending' and r.due_date <= ${day}::date
          and (${teamWide} or r.assigned_user_id = ${user.id}))::int as reminders,
      (select count(*) from complaints c
        join customers cu on cu.id = c.customer_id
        where c.status in ('open','in_progress','awaiting_customer')
          and (${teamWide} or cu.owner_id = ${user.id}))::int as complaints
  `);

  return {
    reminders: row?.reminders ?? 0,
    complaints: row?.complaints ?? 0,
  };
}
