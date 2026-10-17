import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserModules } from "@/lib/access";
import {
  listEnquiries,
  assignableUsers,
  enquiryDashboardCounts,
  type EnquiryFilters,
} from "@/lib/services/enquiry-service";
import { EnquiryListScreen } from "@/components/enquiries/enquiry-list-screen";
import { decodeEnquiryCursors } from "@/lib/enquiry-labels";
import type { EnquiryPriority, EnquiryStage } from "@/lib/enquiry-labels";

export const metadata = { title: "Website Enquiries" };

const STAGES = new Set(["new", "contacted", "follow_up", "qualified", "converted", "closed"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

export default async function EnquiriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();

  /*
   * ONE page for what used to be two modules, so it opens for whoever held
   * EITHER: the Overview (the numbers) or the worklist (the rows). Both keys
   * still exist and are still granted separately — somebody who held only one
   * of them must not lose the app because the screens merged.
   *
   * It is the app's own root, so it has no folder layout to guard it and the
   * check runs here. `listUserModules` answers whole for somebody with no
   * module rows, which is the rule that lets a terminal grant open the app.
   */
  const modules = await listUserModules(user.id, "enquiries");
  const keys = new Set(modules.map((m) => m.key));
  if (!keys.has("enquiries.overview") && !keys.has("enquiries.list")) redirect("/apps");
  // A row links to the enquiry's own page only for somebody who may open it:
  // that page is still the worklist module's, and Overview alone does not
  // widen into it.
  const canOpenEnquiry = keys.has("enquiries.list");

  const params = await searchParams;
  const one = (k: string) => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const q = one("q") ?? "";
  const stageParam = one("stage");
  const priorityParam = one("priority");
  const sourceParam = one("source");
  const assignedParam = one("assigned");
  const linkedParam = one("linked");
  const sortParam = one("sort");
  // A stack of keyset cursors, one per page boundary already crossed — see
  // `decodeEnquiryCursors`. "Page" is derived from its length rather than
  // stored separately, so a hand-edited URL cannot name a page number the
  // cursor chain does not actually reach.
  const cursors = decodeEnquiryCursors(one("cursors"));
  const page = cursors.length + 1;

  const filters: EnquiryFilters = {
    q: q || undefined,
    stage: stageParam && STAGES.has(stageParam) ? (stageParam as EnquiryStage) : undefined,
    priority: priorityParam && PRIORITIES.has(priorityParam) ? (priorityParam as EnquiryPriority) : undefined,
    source: sourceParam || undefined,
    assignedToId: assignedParam === "unassigned" ? "unassigned" : assignedParam || undefined,
    linked: linkedParam === "linked" || linkedParam === "unlinked" ? linkedParam : undefined,
    sort: sortParam === "received_asc" ? "received_asc" : "received_desc",
    cursor: cursors.length ? cursors[cursors.length - 1] : null,
    pageSize: 25,
  };

  const [{ items, total, cursor: nextCursor, more }, team, counts] = await Promise.all([
    listEnquiries(filters),
    assignableUsers(),
    enquiryDashboardCounts(),
  ]);

  return (
    <EnquiryListScreen
      items={items}
      total={total}
      page={page}
      pageSize={25}
      cursors={cursors}
      nextCursor={nextCursor}
      more={more}
      team={team}
      counts={counts}
      canOpenEnquiry={canOpenEnquiry}
      filters={{
        q,
        stage: filters.stage,
        priority: filters.priority,
        source: filters.source,
        assigned: assignedParam ?? "",
        linked: filters.linked,
        sort: filters.sort ?? "received_desc",
      }}
    />
  );
}
