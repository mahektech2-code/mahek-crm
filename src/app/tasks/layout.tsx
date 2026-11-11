import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { listNotifications } from "@/lib/queries";
import { today } from "@/lib/recompute";
import { taskCounts, teamOf } from "@/lib/tasks/service";
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
    teamOf(user),
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
  const counts = await taskCounts(user.id, day);

  const nav: TasksNav = {
    pinned: held.has("tasks.my-work")
      ? [
          { href: "/tasks", label: "My day", icon: "clock", exact: true },
          { href: "/tasks/all", label: "All my tasks", icon: "clipboard" },
          { href: "/tasks/board", label: "Board", icon: "grid" },
          { href: "/tasks/transfers", label: "Transfers", icon: "history" },
          { href: "/tasks/routines", label: "Routines", icon: "tick" },
        ]
      : [],
    groups:
      held.has("tasks.team") && team.size
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
        : [],
  };

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap" precedence="default" />
      <TasksShell
        nav={nav}
        counts={{
          "/tasks": { n: counts.dueNow, late: counts.late > 0 },
          "/tasks/transfers": { n: counts.offered },
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
