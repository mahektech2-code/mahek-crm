import Link from "next/link";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";

/**
 * The way into the Qualification Review from the Qualify screen. A link, not a
 * second copy of the review: the review is one screen with one set of actions.
 */
export function ReviewEntry({ workspace, customerId }: { workspace: LeadWorkspace; customerId: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-line bg-surface px-5 py-3">
      <p className="text-[13px] text-body">
        See every Suspect, Prospect and Qualification answer together, with the reviewer&apos;s decision.
      </p>
      <Link
        href={leadHref(workspace, `${customerId}/review`)}
        className="text-[13px] font-medium text-brand hover:underline"
      >
        Open the qualification review
      </Link>
    </div>
  );
}
