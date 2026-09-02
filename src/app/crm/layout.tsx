import { redirect } from "next/navigation";
import { isManager, requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { navForModules } from "@/components/shell/nav";
import { webApps } from "@/lib/apps";
import { getScope } from "@/lib/scope";
import { crmBadgeCounts, customerStatusRequestCount, listNotifications } from "@/lib/queries";
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
    sidebarBadges(),
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
      apps={webApps(apps)}
      // The role goes in too, because `managerOnly` is the second filter:
      // an ungranted module is a HELD module, so role is the only thing that
      // keeps an approval queue away from the people it answers.
      nav={navForModules(modules.map((m) => m.href), isManager(user))}
    >
      {children}
    </AppShell>
  );
}

/**
 * Both sidebar counts, from the one definition in `lib/queries.ts` — the same
 * function the launcher tile and the dashboard read, so the number beside
 * Reminders in the sidebar and the number on the CRM tile cannot disagree.
 */
async function sidebarBadges() {
  // Both in one wait. The deactivation count is not scoped, matching the queue
  // it labels — a request is work for whoever decides it, not for whoever asked.
  const [{ dueReminders, openComplaints }, statusRequests] = await Promise.all([
    crmBadgeCounts(),
    customerStatusRequestCount(),
  ]);
  return { reminders: dueReminders, complaints: openComplaints, statusRequests };
}
