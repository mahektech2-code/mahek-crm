import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { today } from "@/lib/recompute";
import { myTasks } from "@/lib/tasks/service";
import { TaskDialogs } from "../_ui/dialogs";
import { BoardScreen } from "../_ui/screens";

export const metadata = { title: "Board" };

export default async function BoardPage() {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [tasks, day] = await Promise.all([myTasks(user.id), today()]);
  return (
    <TaskDialogs>
      <BoardScreen tasks={tasks} today={day} viewerId={user.id} />
    </TaskDialogs>
  );
}
