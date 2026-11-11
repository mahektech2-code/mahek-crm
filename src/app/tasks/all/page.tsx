import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { today } from "@/lib/recompute";
import { isTaskApp } from "@/lib/tasks/rules";
import { myTasks } from "@/lib/tasks/service";
import { TaskDialogs } from "../_ui/dialogs";
import { AllTasksScreen } from "../_ui/screens";

export const metadata = { title: "All my tasks" };

export default async function AllTasksPage({ searchParams }: { searchParams: Promise<{ app?: string }> }) {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [{ app }, tasks, day] = await Promise.all([searchParams, myTasks(user.id), today()]);
  return (
    <TaskDialogs>
      <AllTasksScreen tasks={tasks} today={day} viewerId={user.id} startApp={app && isTaskApp(app) ? app : null} />
    </TaskDialogs>
  );
}
