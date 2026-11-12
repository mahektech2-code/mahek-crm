import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { GIVEN_LIST, readTaskQuery } from "@/lib/tasks/list-query";
import { givenBatches, taskListPage } from "@/lib/tasks/list-service";
import { TaskDialogs } from "../../_ui/dialogs";
import { AssignedScreen } from "../../_ui/screens";

export const metadata = { title: "Assigned by me" };

const BATCHES_PER_PAGE = 10;

/** What this person gave out: groups a page of cards at a time (`bp`), and tasks given to one person a page at a time. */
export default async function AssignedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const [sp, day] = await Promise.all([searchParams, today()]);
  const bp = Math.max(1, Number.parseInt(String(Array.isArray(sp.bp) ? sp.bp[0] : (sp.bp ?? "1")), 10) || 1);
  const query = readTaskQuery(sp, GIVEN_LIST);
  const [batches, singles] = await Promise.all([givenBatches(user.id, bp, BATCHES_PER_PAGE), taskListPage({ kind: "given", userId: user.id, singles: true }, query, day)]);
  return (
    <TaskDialogs>
      <AssignedScreen batches={{ ...batches, per: BATCHES_PER_PAGE }} singles={{ query, page: singles }} today={day} viewerId={user.id} />
    </TaskDialogs>
  );
}
