import { sql } from "drizzle-orm";
import { db } from "@/db";
import { redirect } from "next/navigation";
import { isManager, requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { getDensity, getScope } from "@/lib/scope";
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
  const [apps, scope, density, notifications, badges] = await Promise.all([
    listUserApps(user.id),
    getScope(user),
    getDensity(),
    listNotifications(user.id),
    sidebarBadges(user),
  ]);

  // Access is checked here, not just hidden on the launcher — a bookmarked
  // /crm URL must not open for somebody who was never given the app.
  if (!apps.includes("crm")) redirect("/apps");

  return (
    <AppShell
      user={user}
      isManager={isManager(user)}
      scope={scope}
      density={density}
      notifications={notifications}
      badges={badges}
      appCount={apps.length}
    >
      {children}
    </AppShell>
  );
}

/** Both sidebar counts in a single query. */
async function sidebarBadges(user: Awaited<ReturnType<typeof requireUser>>) {
  const scope = await getScope(user);
  const teamWide = scope === "team" && isManager(user);
  const day = today();

  const [row] = await db.execute<{ reminders: number; complaints: number }>(sql`
    select
      (select count(*) from reminders r
        where r.status = 'open' and r.due_date <= ${day}::date
          and (${teamWide} or r.user_id = ${user.id}))::int as reminders,
      (select count(*) from complaints c
        join customers cu on cu.id = c.customer_id
        where c.status in ('Open','In progress')
          and (${teamWide} or cu.owner_id = ${user.id}))::int as complaints
  `);

  return {
    reminders: row?.reminders ?? 0,
    complaints: row?.complaints ?? 0,
  };
}
