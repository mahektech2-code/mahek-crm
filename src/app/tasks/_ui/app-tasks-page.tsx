import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { today } from "@/lib/recompute";
import { APP_TASKS_LIST, readTaskQuery } from "@/lib/tasks/list-query";
import { appSummary, incomingSummary, openElsewhere, taskListPage } from "@/lib/tasks/list-service";
import type { TaskApp } from "@/lib/tasks/rules";
import { TaskDialogs } from "./dialogs";
import { AppTasksScreen } from "./screens";

/**
 * One app's My tasks, as a server component every app mounts at its own path
 * (`APP_TASKS_PATH`). The app's layout has already asked whether this person
 * holds the app; a task here is only ever the signed-in person's, so nothing
 * can show anybody else's work. The list is one page of the URL's reading; the
 * strip above it and the note about other apps are counted over every task.
 */
export async function AppTasksPage({
  app,
  searchParams,
  className = "max-w-[1200px] px-6 pt-6 pb-10",
}: {
  app: TaskApp;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  className?: string;
}) {
  const user = await requireUser();
  const [sp, day, apps] = await Promise.all([searchParams, today(), listUserApps(user.id)]);
  /* What is shown here: this app's tasks and personal ones (`shownInApp`). */
  const here: TaskApp[] = app === "tasks" ? ["tasks"] : [app, "tasks"];
  const query = { ...readTaskQuery(sp, APP_TASKS_LIST), app: null };
  const [page, summary, incoming, elsewhere] = await Promise.all([
    taskListPage({ kind: "mine", userId: user.id, apps: here }, query, day),
    appSummary(user.id, here, day),
    incomingSummary(user.id, here),
    openElsewhere(user.id, here),
  ]);
  return (
    <div className={className}>
      <TaskDialogs defaultApp={app}>
        <AppTasksScreen
          app={app}
          summary={summary}
          incoming={incoming}
          elsewhere={elsewhere}
          list={{ page, query }}
          today={day}
          viewerId={user.id}
          hasTasksApp={apps.includes("tasks")}
        />
      </TaskDialogs>
    </div>
  );
}
