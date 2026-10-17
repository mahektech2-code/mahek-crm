import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { listUserApps, listUserModules } from "@/lib/access";
import { navForModules, pinnedForModules } from "@/components/shell/nav";
import { webApps } from "@/lib/apps";
import { hatForHeader } from "@/lib/hat-for-header";
import { getScope, managesHere } from "@/lib/scope";
import { crmBadgeCounts, customerStatusRequestCount, listNotifications } from "@/lib/queries";
import { leadSidebarCounts } from "@/lib/services/lead-sidebar-service";
import { today } from "@/lib/recompute";
import { AppShell } from "@/components/shell/app-shell";
import type { SidebarBadges } from "@/components/shell/sidebar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  // One wait, not four. Every one of these is a round trip to a database in
  // another continent, so they run together rather than one after another.
  const [apps, scope, notifications, badges, managerHere, decidesStatus] = await Promise.all([
    listUserApps(user.id),
    getScope(user, "crm"),
    listNotifications(user.id),
    sidebarBadges(),
    /* A manager OF THE CRM — not of something somewhere. `isManager` is the
       widest level held in any app, and it drew the My book / Team switch for
       a telecaller who happened to manage Reports. */
    managesHere(user, "crm"),
    canFor(user, "customer.deactivate"),
  ]);

  // Access is checked here, not just hidden on the launcher — a bookmarked
  // /crm URL must not open for somebody who was never given the app.
  if (!apps.includes("crm")) redirect("/apps");

  // And the sidebar is narrowed to the screens they hold. This is the courtesy
  // half — each module's own layout runs `requireModule`, because a link that
  // is not drawn is still a URL somebody can type.
  const modules = await listUserModules(user.id, "crm");
  /* The level for THIS app. `users.role` is the widest held anywhere, which is
     the right answer to what somebody may DO and the wrong one to who they are
     HERE. */
  const hat = await hatForHeader(user, "crm");
  if (modules.length === 0) redirect("/apps");

  return (
    <AppShell
      user={user}
      hat={hat}
      isManager={managerHere}
      scope={scope}
      notifications={notifications}
      badges={badges}
      apps={webApps(apps)}
      // The capability goes in too, because `managerOnly` is the second
      // filter: an ungranted module is a HELD module, so this is the only
      // thing that keeps an approval queue away from the people it answers.
      // It is the capability the queue's own actions ask, not a level.
      nav={navForModules(modules.map((m) => m.href), decidesStatus)}
      pinnedNav={pinnedForModules(modules.map((m) => m.href))}
    >
      {children}
    </AppShell>
  );
}

/**
 * Every sidebar count, each from the one definition of its own question — the
 * same functions the launcher tile, the dashboard and the screens behind the
 * rows read, so a number beside a link and the same number inside it cannot
 * disagree.
 *
 * **THE BUSINESS DAY IS READ HERE, not inside the statement.** The two lead
 * windows are date comparisons against Asia/Kolkata's working day, and a
 * `now()` in the statement would read in the session's zone — which on a
 * server running in GMT puts a Monday promise on Sunday. `today()` applies the
 * configured boundary, and every service below takes the answer as an argument
 * for that reason.
 */
async function sidebarBadges(): Promise<SidebarBadges> {
  const day = await today();

  // All three in one wait. The deactivation count is not scoped, matching the
  // queue it labels — a request is work for whoever decides it, not for
  // whoever asked; the two lead counts are scoped exactly as their lists are.
  const [{ dueReminders, openComplaints }, statusRequests, leads] = await Promise.all([
    crmBadgeCounts(),
    customerStatusRequestCount(),
    leadSidebarCounts(day),
  ]);
  return {
    reminders: dueReminders,
    complaints: openComplaints,
    statusRequests,
    leadsDueToday: leads.dueToday,
    leadsOverdue: leads.overdue,
  };
}
