import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { today } from "@/lib/recompute";
import { myTasks } from "@/lib/tasks/service";
import { TASK_APP_LABEL, isTaskApp } from "@/lib/tasks/rules";
import { TaskDialogs } from "../../_ui/dialogs";
import { AllTasksScreen } from "../../_ui/screens";

export async function generateMetadata({ params }: { params: Promise<{ app: string }> }) {
  const { app } = await params;
  return { title: isTaskApp(app) ? (app === "tasks" ? "Personal" : TASK_APP_LABEL[app]) : "Tasks" };
}

/** By app: one app's share of this person's tasks — the sidebar's list of apps. */
export default async function ByAppPage({ params }: { params: Promise<{ app: string }> }) {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const { app } = await params;
  if (!isTaskApp(app)) notFound();
  const [tasks, day] = await Promise.all([myTasks(user.id, { apps: [app] }), today()]);
  return (
    <TaskDialogs defaultApp={app}>
      <AllTasksScreen key={app} tasks={tasks} today={day} viewerId={user.id} startApp={app} lockApp />
    </TaskDialogs>
  );
}
