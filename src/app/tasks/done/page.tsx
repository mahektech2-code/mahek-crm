import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { today } from "@/lib/recompute";
import { doneTasks } from "@/lib/tasks/service";
import { TaskDialogs } from "../_ui/dialogs";
import { DoneScreen } from "../_ui/screens-more";

export const metadata = { title: "Done" };

/** Everything this person finished, newest first, grouped by the day it closed. */
export default async function DonePage() {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [tasks, day] = await Promise.all([doneTasks(user.id), today()]);
  return (
    <TaskDialogs>
      <DoneScreen tasks={tasks} today={day} viewerId={user.id} />
    </TaskDialogs>
  );
}
