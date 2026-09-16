import { listEnquiries, assignableUsers, type EnquiryFilters } from "@/lib/services/enquiry-service";
import { EnquiryListScreen } from "@/components/enquiries/enquiry-list-screen";
import { decodeEnquiryCursors } from "@/lib/enquiry-labels";
import type { EnquiryPriority, EnquiryStage } from "@/lib/enquiry-labels";

export const metadata = { title: "Enquiries — Website Enquiries" };

const STAGES = new Set(["new", "contacted", "follow_up", "qualified", "converted", "closed"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

export default async function EnquiriesListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  const [{ items, total, cursor: nextCursor, more }, team] = await Promise.all([
    listEnquiries(filters),
    assignableUsers(),
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
