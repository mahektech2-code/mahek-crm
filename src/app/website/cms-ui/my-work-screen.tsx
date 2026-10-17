"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, Card, CardHeader, Checkbox, EmptyState, PageHeader, Td, Th, Tr } from "@/components/ui/primitives";
import { KINDS } from "@/lib/website-cms/kinds";
import type { MyWork, RequestRow } from "@/lib/website-cms/review-queries";
import { RequestStatusBadge, SubmitDialog, dateTime } from "./review-ui";

/* ---------------------------------------------------------------------------
 * MY WORK — what an employee has been given, what is waiting on them, and what
 * is waiting on somebody else. The order is the order of what to do next:
 * approved changes to publish, then what came back, then what to hand in.
 *
 * Every figure here is the person's own. Where assignments are enforced, the
 * assignments list IS the whole of what they may edit, and says so.
 * ------------------------------------------------------------------------- */

function RequestTable({ rows, empty }: { rows: RequestRow[]; empty: string }) {
  if (rows.length === 0) return <div className="px-5 py-4 text-sm text-muted">{empty}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>What</Th>
            <Th>Status</Th>
            <Th>Submitted</Th>
            <Th>Why</Th>
            <Th align="right">&nbsp;</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.id}>
              <Td className="max-w-[320px] whitespace-normal">
                <div className="font-medium text-ink">
                  {r.itemLabels.join(", ")}
                  {r.items > r.itemLabels.length ? ` and ${r.items - r.itemLabels.length} more` : ""}
                </div>
                <div className="text-xs text-muted">{r.items} {r.items === 1 ? "item" : "items"}</div>
              </Td>
              <Td><RequestStatusBadge status={r.status} /></Td>
              <Td>{dateTime(r.submittedAt)}</Td>
              <Td className="max-w-[280px] whitespace-normal text-body">
                {r.status === "rejected" && r.rejectReason ? `“${r.rejectReason}”` : r.status === "approved" && r.approvalExpiresAt ? `Publish by ${dateTime(r.approvalExpiresAt)}` : ""}
              </Td>
              <Td align="right"><Link href={`/website/my-work/${r.id}`}>Open</Link></Td>
            </Tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MyWorkScreen({ work }: { work: MyWork }) {
  const router = useRouter();
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = React.useState(false);
  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="p-6">
      <PageHeader
        title="My work"
        subtitle="What you have been assigned, what has come back to you, and what is waiting for a reviewer. Nothing you save reaches mahekindia.com until it has been approved and you publish it."
      />

      {work.toPublish.length > 0 ? (
        <Callout tone="success">
          <span className="text-sm text-ink">
            <span className="font-medium">Verification Granted</span> — you can now publish {work.toPublish.length === 1 ? "an approved change" : `${work.toPublish.length} approved changes`}.
          </span>
        </Callout>
      ) : null}

      {work.toPublish.length > 0 ? (
        <Card className="mb-4">
          <CardHeader title="Approved — ready for you to publish" hint="Open one and press “Publish approved changes”. An approval lasts 7 days." />
          <RequestTable rows={work.toPublish} empty="" />
        </Card>
      ) : null}

      {work.returned.length > 0 ? (
        <Card className="mb-4">
          <CardHeader title="Came back to you" hint="Fix what it says, then submit again." />
          <RequestTable rows={work.returned} empty="" />
        </Card>
      ) : null}

      <Card className="mb-4">
        <CardHeader
          title="Ready to submit"
          hint="Drafts you have edited that nobody has seen yet."
          action={
            <Button variant="primary" disabled={picked.size === 0} onClick={() => setSubmitting(true)}>
              Submit for Verification{picked.size ? ` (${picked.size})` : ""}
            </Button>
          }
        />
        {work.ready.length === 0 ? (
          <EmptyState title="Nothing to submit" body="Edit an item you were assigned and save it; it appears here." />
        ) : (
          <ul className="divide-y divide-divider text-sm">
            {work.ready.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-5 py-2.5">
                <Checkbox
                  className="min-w-0 flex-1"
                  checked={picked.has(r.id)}
                  onChange={() => toggle(r.id)}
                  label={<span className="truncate font-medium text-ink">{r.label}</span>}
                />
                <span className="text-xs text-muted">{KINDS[r.kind].noun}</span>
                <Badge tone={r.why === "new" ? "success" : "brand"}>{r.why === "new" ? "New draft" : "Changed"}</Badge>
                <Link href={`/website/${KINDS[r.kind].moduleSlug}`}>Open</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mb-4">
        <CardHeader title="Waiting for a reviewer" hint="You cannot change these while they are being reviewed. Withdraw one to edit it again." />
        <RequestTable rows={work.waiting} empty="Nothing is waiting for review." />
      </Card>

      <Card className="mb-4">
        <CardHeader
          title="Assigned to you"
          hint={work.enforced ? "This is everything you can edit." : "Assignments are not enforced yet, so you can edit whatever your Website modules cover. These are what you have been given."}
        />
        {work.assignments.length === 0 ? (
          <EmptyState title="Nothing assigned yet" body={work.enforced ? "You cannot edit anything until a reviewer assigns you some website content." : "Nobody has assigned you anything."} />
        ) : (
          <ul className="divide-y divide-divider text-sm">
            {work.assignments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                <span className="font-medium text-ink">{a.itemLabel ?? `Every item in ${a.kindLabel}`}</span>
                <Badge tone="neutral">{a.itemLabel ? a.kindLabel : "Whole kind"}</Badge>
                {a.scopeNote ? <span className="text-muted">{a.scopeNote}</span> : null}
                <span className="flex-1" />
                <span className="text-xs text-muted">since {dateTime(a.assignedAt)}</span>
                <Link href={a.kind === "media" ? "/website/media" : `/website/${KINDS[a.kind].moduleSlug}`}>Open</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {work.published.length > 0 ? (
        <Card>
          <CardHeader title="Recently published" />
          <RequestTable rows={work.published} empty="" />
        </Card>
      ) : null}

      <SubmitDialog
        open={submitting}
        ids={[...picked]}
        onClose={() => setSubmitting(false)}
        onDone={() => {
          setSubmitting(false);
          setPicked(new Set());
          router.refresh();
        }}
      />
    </div>
  );
}
