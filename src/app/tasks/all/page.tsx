import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { today } from "@/lib/recompute";
import { ALL_TASKS_LIST, readTaskQuery } from "@/lib/tasks/list-query";
import { taskListPage } from "@/lib/tasks/list-service";
import { TaskDialogs } from "../_ui/dialogs";
import { AllTasksScreen } from "../_ui/screens";

export const metadata = { title: "All my tasks" };

/** Every task of this person's, a page at a time; the tab, filters, search, grouping and page are the URL. */
export default async function AllTasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [sp, day] = await Promise.all([searchParams, today()]);
  const query = readTaskQuery(sp, ALL_TASKS_LIST);
  const page = await taskListPage({ kind: "mine", userId: user.id }, query, day);
  return (
    <TaskDialogs>
      <AllTasksScreen page={page} query={query} today={day} viewerId={user.id} />
    </TaskDialogs>
  );
}
