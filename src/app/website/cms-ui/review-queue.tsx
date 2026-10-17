"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, EmptyState, PageHeader, Td, Th, Tr } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/overlays";
import type { Queue } from "@/lib/website-cms/review-queries";
import { QUEUE_TABS, type QueueTab } from "@/lib/website-cms/review-status";
import { RequestStatusBadge, dateTime } from "./review-ui";

/* ---------------------------------------------------------------------------
 * THE REVIEW QUEUE — one tab per question a reviewer asks of it, each with its
 * count. The tab is in the address, so a link to "waiting for review" is a link
 * to exactly that.
 *
 * A row opens the request: that page is where the changes are read and decided.
 * Nothing is decided from the list, because a decision made without reading the
 * difference is the one thing this exists to prevent.
 * ------------------------------------------------------------------------- */

const EMPTY: Record<QueueTab, string> = {
  pending: "Nothing is waiting for a decision.",
  approved: "Nothing approved is waiting to be published.",
  published: "Nothing has been published through review yet.",
  rejected: "Nothing has been rejected.",
  closed: "Nothing has been withdrawn, revoked, expired or gone stale.",
};

export function ReviewQueue({ queue }: { queue: Queue }) {
  const router = useRouter();
  return (
    <div className="p-6">
      <PageHeader title="Review" subtitle="What employees have submitted for the website. Read the changes, then grant permission to publish them or send them back with a reason." />
      <Tabs
        className="mb-4"
        value={queue.tab}
        onChange={(key) => router.push(`/website/review?tab=${key}`)}
        tabs={QUEUE_TABS.map((t) => ({ key: t.key, label: t.label, count: queue.counts[t.key] }))}
      />
      <Card className="overflow-x-auto">
        {queue.rows.length === 0 ? (
          <EmptyState title={EMPTY[queue.tab]} />
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>What</Th>
                <Th>Submitted by</Th>
                <Th>Submitted</Th>
                <Th>Status</Th>
                <Th>{queue.tab === "rejected" ? "Reason" : queue.tab === "approved" ? "Approval ends" : "Decided by"}</Th>
                <Th align="right">&nbsp;</Th>
              </tr>
            </thead>
            <tbody>
              {queue.rows.map((r) => (
                <Tr key={r.id}>
                  <Td className="max-w-[340px] whitespace-normal">
                    <div className="font-medium text-ink">
                      {r.itemLabels.join(", ")}
                      {r.items > r.itemLabels.length ? ` and ${r.items - r.itemLabels.length} more` : ""}
                    </div>
                    <div className="text-xs text-muted">{r.items} {r.items === 1 ? "item" : "items"}{r.resubmissionOf ? " · resubmitted" : ""}</div>
                  </Td>
                  <Td>{r.submitterName}</Td>
                  <Td>{dateTime(r.submittedAt)}</Td>
                  <Td><RequestStatusBadge status={r.status} /></Td>
                  <Td className="max-w-[260px] whitespace-normal text-body">
                    {queue.tab === "rejected" ? (r.rejectReason ? `“${r.rejectReason}”` : "") : queue.tab === "approved" ? (r.approvalExpiresAt ? dateTime(r.approvalExpiresAt) : "") : (r.reviewerName ?? "")}
                  </Td>
                  <Td align="right"><Link href={`/website/review/${r.id}`}>{r.status === "submitted" ? "Review" : "Open"}</Link></Td>
                </Tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
