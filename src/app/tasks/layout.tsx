import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { listNotifications } from "@/lib/queries";
import { today } from "@/lib/recompute";
import { openByApp, taskCounts, teamOf } from "@/lib/tasks/service";
import { TASK_APP_LABEL, type TaskApp } from "@/lib/tasks/rules";
import { writeRoutineTasks } from "@/lib/tasks/routine-service";
import "@/styles/v4-theme.css";
import { TasksShell, type TasksNav } from "./_ui/tasks-shell";

export const metadata: Metadata = { title: { template: "%s · Tasks · MahekOne", default: "Tasks · MahekOne" } };

/**
 * The Tasks app's shell. The grant is checked here as well as on the launcher —
 * a bookmarked /tasks must not open for somebody never given it — and the
 * sidebar draws only the modules this person holds. The team screens appear
 * only for somebody with people under them on the org chart: for anybody else
 * they would be empty.
 */
export default async function TasksLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("tasks")) redirect("/apps");
  const [modules, hat, notifications, day, team] = await Promise.all([
    listUserModules(user.id, "tasks"),
    hatForHeader(user, "tasks"),
    listNotifications(user.id),
    today(),
    teamOf(user, "see"),
  ]);
  if (!modules.length) redirect("/apps");
  const held = new Set(modules.map((m) => m.key));
  /* Today's routine tasks, before anything is counted. The hourly job writes
     them for everybody; asking again here is what makes the screen right on a
     morning the job has not run yet. Idempotent, and never allowed to stop the
     page from opening. */
  try {
    await writeRoutineTasks(day, { assigneeId: user.id });
  } catch (e) {
    console.error("Routine tasks on open failed:", e instanceof Error ? e.message : e);
  }
  const [counts, byApp] = await Promise.all([taskCounts(user.id, day), openByApp(user.id, day)]);

  const nav: TasksNav = {
    pinned: held.has("tasks.my-work")
      ? [
          { href: "/tasks", label: "My day", icon: "clock", exact: true },
          { href: "/tasks/all", label: "All my tasks", icon: "clipboard" },
          { href: "/tasks/board", label: "Board", icon: "board" },
          { href: "/tasks/calendar", label: "Calendar", icon: "calendar" },
          { href: "/tasks/done", label: "Done", icon: "checkCircle" },
          { href: "/tasks/transfers", label: "Transfers", icon: "swap" },
        ]
      : [],
    groups: [
      ...(held.has("tasks.team") && team.size
        ? [
            {
              label: "My team",
              icon: "people",
              items: [
                { href: "/tasks/team", label: "Team workload", icon: "people", exact: true },
                { href: "/tasks/team/assigned", label: "Assigned by me", icon: "target" },
              ],
            },
          ]
        : []),
      ...(held.has("tasks.setup")
        ? [
            {
              label: "Set up",
              icon: "settings",
              items: [
                { href: "/tasks/setup/routines", label: "Routines", icon: "repeat" },
                { href: "/tasks/setup/automatic", label: "Automatic tasks", icon: "bolt" },
              ],
            },
          ]
        : []),
      ...(held.has("tasks.my-work") && byApp.length
        ? [
            {
              label: "By app",
              icon: "grid",
              items: byApp.map((a) => ({ href: `/tasks/app/${a.app}`, label: a.app === "tasks" ? "Personal" : (TASK_APP_LABEL[a.app as TaskApp] ?? a.app), icon: "grid" })),
            },
          ]
        : []),
    ],
  };

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap" precedence="default" />
      <TasksShell
        nav={nav}
        counts={{
          "/tasks": { n: counts.dueNow, late: counts.late > 0 },
          "/tasks/all": { n: counts.open },
          "/tasks/transfers": { n: counts.offered },
          "/tasks/team": { n: counts.teamLate, late: counts.teamLate > 0 },
          "/tasks/team/assigned": { n: counts.givenOpen },
          ...Object.fromEntries(byApp.map((a) => [`/tasks/app/${a.app}`, { n: a.open, late: a.late > 0 }])),
        }}
        user={{ name: user.name, email: user.email, phone: user.phone, initials: initialsOf(user.name), role: hat.label }}
        hat={hat}
        notifications={notifications}
        apps={webApps(apps)}
      >
        {children}
      </TasksShell>
    </>
  );
}
