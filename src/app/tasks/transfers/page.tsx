import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { today } from "@/lib/recompute";
import { DEFAULT_PER_PAGE, TRANSFER_LIST, readTaskQuery } from "@/lib/tasks/list-query";
import { taskListPage, transferCounts, transferHistoryPage } from "@/lib/tasks/list-service";
import { TaskDialogs } from "../_ui/dialogs";
import { TransfersScreen, type TransfersView } from "../_ui/screens";

export const metadata = { title: "Transfers" };

/** Waiting for you, sent by you, and what was decided — each a page at a time; `t` is the tab. */
export default async function TransfersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [sp, day, counts] = await Promise.all([searchParams, today(), transferCounts(user.id)]);
  const t = sp.t === "out" || sp.t === "history" ? sp.t : "in";
  const query = readTaskQuery(sp, TRANSFER_LIST);
  let view: TransfersView;
  if (t === "history") {
    const h = await transferHistoryPage(user.id, query.page, query.per);
    view = { tab: "history", history: { ...h, per: query.per ?? DEFAULT_PER_PAGE } };
  } else {
    view = { tab: t, list: { query, page: await taskListPage({ kind: t === "in" ? "incoming" : "outgoing", userId: user.id }, query, day) } };
  }
  return (
    <TaskDialogs>
      <TransfersScreen view={view} counts={counts} today={day} viewerId={user.id} />
    </TaskDialogs>
  );
}
