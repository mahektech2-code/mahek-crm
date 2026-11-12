import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { today } from "@/lib/recompute";
import { TASK_APP_LABEL, shownInApp, type TaskApp } from "@/lib/tasks/rules";
import { incomingTransfers, myTasks } from "@/lib/tasks/service";
import { TaskDialogs } from "./dialogs";
import { AppTasksScreen } from "./screens";

/**
 * One app's My tasks, as a server component every app mounts at its own path
 * (`APP_TASKS_PATH`). The app's layout has already asked whether this person
 * holds the app; a task is only ever the signed-in person's, so nothing here
 * can show anybody else's work.
 */
export async function AppTasksPage({ app, className = "max-w-[1200px] px-6 pt-6 pb-10" }: { app: TaskApp; className?: string }) {
  const user = await requireUser();
  const [all, incoming, day, apps] = await Promise.all([myTasks(user.id), incomingTransfers(user.id), today(), listUserApps(user.id)]);
  const here = all.filter((t) => shownInApp(t.app, app));
  const elsewhere = all.filter((t) => t.status !== "done" && !shownInApp(t.app, app));
  return (
    <div className={className}>
      <TaskDialogs defaultApp={app}>
        <AppTasksScreen
          app={app}
          tasks={here}
          incoming={incoming.filter((t) => shownInApp(t.app, app))}
          elsewhere={{ count: elsewhere.length, apps: [...new Set(elsewhere.map((t) => TASK_APP_LABEL[t.app]))] }}
          today={day}
          viewerId={user.id}
          hasTasksApp={apps.includes("tasks")}
        />
      </TaskDialogs>
    </div>
  );
}
