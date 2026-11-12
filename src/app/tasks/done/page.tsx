import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { today } from "@/lib/recompute";
import { DONE_LIST, readTaskQuery } from "@/lib/tasks/list-query";
import { taskListPage } from "@/lib/tasks/list-service";
import { TaskDialogs } from "../_ui/dialogs";
import { DoneScreen } from "../_ui/screens-more";

export const metadata = { title: "Done" };

/** Everything this person finished, newest first, grouped by the day it closed — a page at a time. */
export default async function DonePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [sp, day] = await Promise.all([searchParams, today()]);
  const query = readTaskQuery(sp, DONE_LIST);
  const page = await taskListPage({ kind: "mine", userId: user.id }, query, day);
  return (
    <TaskDialogs>
      <DoneScreen page={page} query={query} today={day} viewerId={user.id} />
    </TaskDialogs>
  );
}
