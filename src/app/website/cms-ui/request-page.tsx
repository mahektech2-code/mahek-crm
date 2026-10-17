import Link from "next/link";
import { PageHeader } from "@/components/ui/primitives";
import type { HistoryEntry } from "@/lib/website-cms/review-queries";
import type { RequestView } from "@/lib/website-cms/review-service";
import { EmployeeActions, HistoryList, RequestItemCard, ReviewActions, StatusPanel } from "./review-ui";

/**
 * One request, read in full: its status, every item with what changed in it and
 * the pictures that came and went, the decision or the next step, and the
 * history. The same page for the reviewer and for the employee — what differs
 * is only which buttons are offered, and the server checks each of them again.
 */
export function RequestPage({ request, history, mode, now }: { request: RequestView; history: HistoryEntry[]; mode: "review" | "mine"; now: number }) {
  const back = mode === "review" ? { href: "/website/review", label: "← Review" } : { href: "/website/my-work", label: "← My work" };
  const title = request.items.map((i) => i.label).slice(0, 3).join(", ") + (request.items.length > 3 ? ` and ${request.items.length - 3} more` : "");
  return (
    <div className="max-w-[1100px] p-6">
      <Link href={back.href} className="mb-2 inline-block text-[13px] text-muted no-underline hover:text-body hover:no-underline">
        {back.label}
      </Link>
      <PageHeader
        title={title || "Change request"}
        subtitle={`${request.items.length} ${request.items.length === 1 ? "item" : "items"} — read exactly as they were frozen when submitted.`}
        actions={mode === "review" ? <ReviewActions request={request} /> : <EmployeeActions request={request} now={now} />}
      />
      <StatusPanel request={request} mode={mode} now={now} />
      {request.items.map((item) => (
        <RequestItemCard key={item.id} item={item} />
      ))}
      <HistoryList entries={history} />
    </div>
  );
}
