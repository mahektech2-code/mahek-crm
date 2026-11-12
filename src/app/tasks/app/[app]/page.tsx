import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { today } from "@/lib/recompute";
import { BY_APP_LIST, readTaskQuery } from "@/lib/tasks/list-query";
import { taskListPage } from "@/lib/tasks/list-service";
import { TASK_APP_LABEL, isTaskApp } from "@/lib/tasks/rules";
import { TaskDialogs } from "../../_ui/dialogs";
import { AllTasksScreen } from "../../_ui/screens";

export async function generateMetadata({ params }: { params: Promise<{ app: string }> }) {
  const { app } = await params;
  return { title: isTaskApp(app) ? (app === "tasks" ? "Personal" : TASK_APP_LABEL[app]) : "Tasks" };
}

/** By app: one app's share of this person's tasks — the sidebar's list of apps — a page at a time. */
export default async function ByAppPage({ params, searchParams }: { params: Promise<{ app: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [{ app }, sp, day] = await Promise.all([params, searchParams, today()]);
  if (!isTaskApp(app)) notFound();
  const query = { ...readTaskQuery(sp, BY_APP_LIST), app: null };
  const page = await taskListPage({ kind: "mine", userId: user.id, apps: [app] }, query, day);
  return (
    <TaskDialogs defaultApp={app}>
      <AllTasksScreen page={page} query={query} today={day} viewerId={user.id} lockApp={app} />
    </TaskDialogs>
  );
}
