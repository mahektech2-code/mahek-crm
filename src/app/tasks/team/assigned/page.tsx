import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { givenByMe } from "@/lib/tasks/service";
import { TaskDialogs } from "../../_ui/dialogs";
import { AssignedScreen } from "../../_ui/screens";

export const metadata = { title: "Assigned by me" };

export default async function AssignedPage() {
  const user = await requireUser();
  const [tasks, day] = await Promise.all([givenByMe(user.id), today()]);
  return (
    <TaskDialogs>
      <AssignedScreen tasks={tasks} today={day} viewerId={user.id} />
    </TaskDialogs>
  );
}
