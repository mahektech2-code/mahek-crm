"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, Card, CardHeader, Field, Textarea, Td, Th, Tr } from "@/components/ui/primitives";
import { ConfirmDialog, Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  approveRequestAction,
  publishApprovedAction,
  rejectRequestAction,
  revokeApprovalAction,
  submitForVerificationAction,
  withdrawRequestAction,
} from "@/lib/actions/website-cms";
import { KINDS, type KindKey } from "@/lib/website-cms/kinds";
import { isImageValue, type FieldChange } from "@/lib/website-cms/review-diff";
import type { HistoryEntry, ItemReview } from "@/lib/website-cms/review-queries";
import type { RequestItemView, RequestView } from "@/lib/website-cms/review-service";
import { STATUS_HELP, STATUS_LABEL, STATUS_TONE, approvalIsLive, isReturned, type RequestStatus } from "@/lib/website-cms/review-status";
import { MediaThumb } from "./media-picker";
import { reportPublish, reportResult } from "./report";

/* ---------------------------------------------------------------------------
 * THE REVIEW SCREENS' SHARED PARTS — a request's status, what changed in it, the
 * pictures that came and went, and the few things a person can do about it.
 *
 * Nothing here decides what is allowed. The buttons are drawn from the request's
 * status (so a button the server would refuse is not offered), and every one of
 * them calls an action that the server checks again from the database row.
 *
 * What an EMPLOYEE can do: publish an approved request, take a request back, and
 * submit again. What a REVIEWER can do: grant permission, reject with a reason,
 * and take an approval back. There is no other publish button on these screens.
 * ------------------------------------------------------------------------- */

export const dateTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

/* -------------------------------------------------------------- the diff */

const NOT_SET = <span className="text-muted italic">not set</span>;
const EMPTY = <span className="text-muted italic">empty</span>;

function Value({ value }: { value: unknown }) {
  if (value === undefined) return NOT_SET;
  if (value === null || value === "") return EMPTY;
  if (isImageValue(value)) {
    return (
      <div className="flex items-center gap-2">
        <MediaThumb url={value} className="h-12 w-12" />
        <span className="min-w-0 text-xs break-all text-muted">{value}</span>
      </div>
    );
  }
  if (typeof value === "string") return <span className="break-words whitespace-pre-wrap">{value}</span>;
  if (typeof value === "number" || typeof value === "boolean") return <span>{String(value)}</span>;
  return <code className="text-xs break-all">{JSON.stringify(value)}</code>;
}

/** `blocks[3].value` is a page's fourth block: say what it is, not where it sits. */
export function fieldName(path: string, item: Pick<RequestItemView, "proposedData" | "baseData">): string {
  const block = /^blocks\[(\d+)\]\.value/.exec(path);
  if (block) {
    const at = Number(block[1]);
    const pick = (d: Record<string, unknown> | null) => (d?.blocks as { label?: string }[] | undefined)?.[at]?.label;
    const label = pick(item.proposedData) ?? pick(item.baseData);
    if (label) return label + path.slice(block[0].length).replace(/\[(\d+)\]/g, (_, n: string) => ` › item ${Number(n) + 1}`);
  }
  return path
    .replace(/\[(\d+)\]/g, (_, n: string) => ` › item ${Number(n) + 1}`)
    .replace(/\./g, " › ");
}

const CHANGE_TONE = { added: "success", edited: "brand", removed: "danger" } as const;
const CHANGE_LABEL = { added: "Added", edited: "Edited", removed: "Removed" } as const;

export function ChangeTable({ item }: { item: RequestItemView }) {
  if (item.changes.length === 0) return <div className="px-5 py-3 text-sm text-muted">No field differs from what is live.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <Th>Field</Th>
            <Th>Change</Th>
            <Th>Before (live)</Th>
            <Th>After (submitted)</Th>
          </tr>
        </thead>
        <tbody>
          {item.changes.map((c: FieldChange) => (
            <Tr key={c.path}>
              <Td className="w-[22%] whitespace-normal align-top font-medium text-ink">{fieldName(c.path, item)}</Td>
              <Td className="w-[10%] align-top"><Badge tone={CHANGE_TONE[c.change]}>{CHANGE_LABEL[c.change]}</Badge></Td>
              <Td className="w-[34%] whitespace-normal align-top"><Value value={c.before} /></Td>
              <Td className="w-[34%] whitespace-normal align-top"><Value value={c.after} /></Td>
            </Tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The old and the new picture side by side, large enough to judge. Uploaded
 * files are served by MahekOne to people who may review; a picture that ships
 * with the public site is loaded from the site, and its path is printed under
 * it either way — so what was replaced is named even where the picture cannot
 * be drawn.
 */
export function ImageChanges({ item }: { item: RequestItemView }) {
  const images = item.changes.filter((c) => isImageValue(c.before) || isImageValue(c.after));
  if (images.length === 0) return null;
  const pane = (title: string, value: unknown) => (
    <div className="min-w-[160px] flex-1">
      <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{title}</div>
      {isImageValue(value) ? (
        <>
          <MediaThumb url={value} className="h-40 w-full" />
          <div className="mt-1 text-xs break-all text-muted">{value}</div>
        </>
      ) : (
        <div className="flex h-40 items-center justify-center rounded-[4px] border border-dashed border-line text-sm text-muted">
          {title === "Before" ? "No image before" : "No image after"}
        </div>
      )}
    </div>
  );
  return (
    <div className="border-t border-divider px-5 py-4">
      <div className="mb-2 text-sm font-semibold text-ink">Images</div>
      <div className="flex flex-col gap-4">
        {images.map((c) => (
          <div key={c.path}>
            <div className="mb-1.5 text-[13px] text-body">{fieldName(c.path, item)}</div>
            <div className="flex flex-wrap gap-4">
              {pane("Before", c.before)}
              {pane("After", c.after)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RequestItemCard({ item }: { item: RequestItemView }) {
  const noun = KINDS[item.kind as KindKey]?.noun ?? item.kind;
  return (
    <Card className="mb-4">
      <CardHeader
        title={item.label}
        hint={`${noun[0].toUpperCase()}${noun.slice(1)} · ${item.changes.length} ${item.changes.length === 1 ? "field" : "fields"} ${item.action === "add" ? "added" : "changed"}`}
        action={<Badge tone={item.action === "add" ? "success" : "brand"}>{item.action === "add" ? "New — not live yet" : "Change to a live item"}</Badge>}
      />
      <ChangeTable item={item} />
      <ImageChanges item={item} />
    </Card>
  );
}

/* ---------------------------------------------------------- the history */

export function HistoryList({ entries }: { entries: HistoryEntry[] }) {
  return (
    <Card>
      <CardHeader title="History" hint="Every step, with who did it. Recorded as it happened." />
      {entries.length === 0 ? (
        <div className="px-5 py-4 text-sm text-muted">Nothing recorded yet.</div>
      ) : (
        <ul className="divide-y divide-divider text-sm">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-5 py-2.5">
              <span className="w-[160px] text-xs text-muted">{dateTime(e.at)}</span>
              <span className="font-medium text-ink">{e.action}</span>
              <span className="text-muted">{e.actorName ? `by ${e.actorName}` : "automatically"}</span>
              {e.detail ? <span className="w-full pl-[172px] text-body">“{e.detail}”</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------- the actions */

/**
 * The reviewer's decision. Granting is one press; rejecting asks for a reason
 * and the button stays off until there is one — the employee has to be told
 * what to fix, and the server refuses an empty reason as well.
 */
export function ReviewActions({ request }: { request: RequestView }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [rejecting, setRejecting] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);
  const [reason, setReason] = React.useState("");

  async function run(fn: () => Promise<boolean>) {
    setBusy(true);
    try {
      if (await fn()) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (request.status === "submitted") {
    return (
      <>
        <div className="flex flex-wrap gap-2.5">
          <Button variant="primary" disabled={busy} onClick={() => void run(async () => reportResult(toast, await approveRequestAction(request.id)))}>
            Grant Permission to Publish
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setRejecting(true)}>
            Reject Changes
          </Button>
        </div>
        <Modal
          open={rejecting}
          onClose={() => setRejecting(false)}
          title="Reject these changes"
          width={520}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRejecting(false)} disabled={busy}>Cancel</Button>
              <Button
                variant="primary"
                disabled={busy || reason.trim().length === 0}
                onClick={() =>
                  void run(async () => {
                    const ok = reportResult(toast, await rejectRequestAction(request.id, reason));
                    if (ok) {
                      setRejecting(false);
                      setReason("");
                    }
                    return ok;
                  })
                }
              >
                Reject Changes
              </Button>
            </>
          }
        >
          <Field label="Why are you rejecting them?" hint="The employee sees this exactly as written, and fixes what it says. A reason is required.">
            <Textarea rows={5} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="For example: the new name still uses the old brand — please use the current one." autoFocus />
          </Field>
        </Modal>
      </>
    );
  }
  if (request.status === "approved") {
    return (
      <>
        <Button variant="secondary" disabled={busy} onClick={() => setRevoking(true)}>Revoke approval</Button>
        <ConfirmDialog
          open={revoking}
          title="Revoke this approval"
          body="Nothing has been published. The employee will have to submit the changes again."
          destructive
          confirmLabel="Revoke approval"
          onClose={() => setRevoking(false)}
          onConfirm={() => run(async () => reportResult(toast, await revokeApprovalAction(request.id)))}
        />
      </>
    );
  }
  return null;
}

/**
 * What the person who submitted can do. "Publish approved changes" is the ONLY
 * publish button an employee is ever shown, and only on an approved request
 * whose seven days have not run out.
 */
export function EmployeeActions({ request, now }: { request: RequestView; /** The server's clock, as a number: reading it here would be impure. */ now: number }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [withdrawing, setWithdrawing] = React.useState(false);
  const [resubmitting, setResubmitting] = React.useState(false);

  async function run(fn: () => Promise<boolean>) {
    setBusy(true);
    try {
      if (await fn()) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const live = approvalIsLive({ status: request.status, approvalExpiresAt: request.approvalExpiresAt ? new Date(request.approvalExpiresAt) : null }, new Date(now));
  const status = request.status;

  return (
    <div className="flex flex-wrap gap-2.5">
      {status === "approved" && live ? (
        <Button variant="primary" disabled={busy} onClick={() => void run(async () => reportPublish(toast, await publishApprovedAction(request.id)))}>
          Publish approved changes
        </Button>
      ) : null}
      {status === "submitted" || status === "approved" ? (
        <Button variant="secondary" disabled={busy} onClick={() => setWithdrawing(true)}>Withdraw</Button>
      ) : null}
      {isReturned(status) ? (
        <>
          <Link
            href={editHref(request)}
            className="inline-flex h-9 items-center rounded-control border border-line bg-surface px-3.5 text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Edit these items
          </Link>
          <Button variant="primary" disabled={busy} onClick={() => setResubmitting(true)}>Submit again</Button>
        </>
      ) : null}
      <ConfirmDialog
        open={withdrawing}
        title="Withdraw this request"
        body="The reviewer will no longer see it, and you can edit these items again. Nothing is published."
        confirmLabel="Withdraw"
        onClose={() => setWithdrawing(false)}
        onConfirm={() => run(async () => reportResult(toast, await withdrawRequestAction(request.id)))}
      />
      <SubmitDialog
        open={resubmitting}
        ids={request.items.map((i) => i.contentId)}
        resubmissionOf={request.id}
        onClose={() => setResubmitting(false)}
        onDone={() => {
          setResubmitting(false);
          router.refresh();
        }}
      />
    </div>
  );
}

/** The module screen to edit a request's items in: its first item's kind. */
function editHref(request: RequestView): string {
  const kind = request.items[0]?.kind;
  return kind ? `/website/${KINDS[kind].moduleSlug}` : "/website/my-work";
}

/** Help for a status the employee cannot act on by pressing something. */
export function StatusPanel({ request, mode, now }: { request: RequestView; mode: "review" | "mine"; now: number }) {
  const status = request.status;
  const expired = status === "approved" && request.approvalExpiresAt && new Date(request.approvalExpiresAt).getTime() <= now;
  return (
    <Card className="mb-4 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <RequestStatusBadge status={expired ? "expired" : status} />
        <span className="text-sm text-muted">
          Submitted by <span className="text-ink">{request.submitterName}</span> on {dateTime(request.submittedAt)}
          {request.reviewerName && request.reviewedAt ? <> · decided by <span className="text-ink">{request.reviewerName}</span> on {dateTime(request.reviewedAt)}</> : null}
        </span>
      </div>
      {request.note ? <div className="mt-2 text-sm text-body">Note from the employee: “{request.note}”</div> : null}
      {status === "rejected" && request.rejectReason ? (
        <Callout tone="danger" className="mt-3 mb-0">
          <div>
            <div className="font-medium text-ink">Rejected{request.reviewerName ? ` by ${request.reviewerName}` : ""}</div>
            <div className="text-sm text-body">“{request.rejectReason}”</div>
          </div>
        </Callout>
      ) : null}
      {status === "approved" && request.approvalExpiresAt && !expired ? (
        <Callout tone="success" className="mt-3 mb-0">
          <div className="text-sm text-body">
            {mode === "mine" ? (
              <>
                <span className="font-medium text-ink">Verification Granted</span> — you can now publish your approved changes. Publish by {dateTime(request.approvalExpiresAt)}; after that the approval lapses.
              </>
            ) : (
              <>Permission granted. The employee can publish exactly this content until {dateTime(request.approvalExpiresAt)}.</>
            )}
          </div>
        </Callout>
      ) : null}
      {(expired || (status !== "approved" && STATUS_HELP[status])) && status !== "rejected" ? (
        <Callout tone="warn" className="mt-3 mb-0">
          <div className="text-sm text-body">{expired ? STATUS_HELP.expired : STATUS_HELP[status]}</div>
        </Callout>
      ) : null}
      {status === "rejected" ? <div className="mt-2 text-sm text-muted">{STATUS_HELP.rejected}</div> : null}
      {request.resubmissionOf ? (
        <div className="mt-2 text-sm text-muted">
          This follows an earlier request:{" "}
          <Link href={mode === "review" ? `/website/review/${request.resubmissionOf}` : `/website/my-work/${request.resubmissionOf}`}>see it</Link>.
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------- one item's review mark */

/**
 * The small badge beside an item that is in review, or came back. The person who
 * submitted it sees the real status and a link to it; anybody else is told only
 * that it is held — it is not theirs, and what became of it is not their news.
 */
export function ReviewBadge({ review }: { review: ItemReview }) {
  const open = review.status === "submitted" || review.status === "approved";
  const label = open && !review.mine ? "In review" : review.status === "approved" ? "Approved — ready to publish" : STATUS_LABEL[review.status];
  const tone = open && !review.mine ? "muted" : STATUS_TONE[review.status];
  const badge = <Badge tone={tone} title={review.reason ?? undefined}>{label}</Badge>;
  return review.mine ? (
    <Link href={`/website/my-work/${review.requestId}`} className="no-underline hover:no-underline">{badge}</Link>
  ) : (
    badge
  );
}

/**
 * Shown in an editor whose item is held by an open request. The item cannot be
 * changed — Save is off — and the way out is stated: wait for the decision, or
 * withdraw the request (only the person who submitted it can).
 */
export function ReviewLockNotice({ review }: { review: ItemReview }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  return (
    <Callout tone="brand" className="mb-3 items-start">
      <div className="min-w-0 flex-1 text-sm text-body">
        <div className="font-medium text-ink">{review.mine ? STATUS_LABEL[review.status] : "In a review request"}</div>
        {review.mine
          ? review.status === "approved"
            ? "This was approved. Publish it from the request, or withdraw the request to change it again."
            : "A reviewer is reading this. You cannot change it until they decide, or you withdraw the request."
          : "Somebody has submitted this for review, so it cannot be changed until it is decided or withdrawn."}
      </div>
      {review.mine ? (
        <div className="flex flex-none gap-2">
          <Link
            href={`/website/my-work/${review.requestId}`}
            className="inline-flex h-8 items-center rounded-control border border-line bg-surface px-3 text-[13px] font-medium text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Open request
          </Link>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if (reportResult(toast, await withdrawRequestAction(review.requestId))) router.refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            Withdraw
          </Button>
        </div>
      ) : null}
    </Callout>
  );
}

/** Shown in an editor whose item came BACK to this person: why, and that they can fix it and submit again. */
export function ReviewReturnNotice({ review }: { review: ItemReview }) {
  if (!review.mine || !isReturned(review.status)) return null;
  const rejected = review.status === "rejected";
  return (
    <Callout tone={rejected ? "danger" : "warn"} className="mb-3 items-start">
      <div className="min-w-0 flex-1 text-sm text-body">
        <div className="font-medium text-ink">{STATUS_LABEL[review.status]}</div>
        {rejected && review.reason ? <div>“{review.reason}”</div> : null}
        <div>{STATUS_HELP[review.status]}</div>
      </div>
      <Link href={`/website/my-work/${review.requestId}`} className="flex-none text-[13px]">Open request</Link>
    </Callout>
  );
}

/* -------------------------------------------------------- submitting */

/**
 * "Submit for Verification": a note for the reviewer (optional), then the
 * request is made. Used from an editor, from My work, and to submit again.
 */
export function SubmitDialog({
  open,
  ids,
  resubmissionOf,
  onClose,
  onDone,
}: {
  open: boolean;
  ids: string[];
  resubmissionOf?: string;
  onClose: () => void;
  onDone: (requestId: string) => void;
}) {
  const toast = useToast();
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    setBusy(true);
    try {
      const r = await submitForVerificationAction(ids, note.trim() || undefined, resubmissionOf);
      if (reportResult(toast, r) && r.ok) {
        setNote("");
        onDone(r.data.id);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Submit for Verification"
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || ids.length === 0}>{busy ? "Submitting…" : "Submit for Verification"}</Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-body">
        {ids.length === 1 ? "This item" : `These ${ids.length} items`} will be frozen exactly as {ids.length === 1 ? "it is" : "they are"} now and sent to a reviewer. You will not be able to change {ids.length === 1 ? "it" : "them"} while it is being reviewed, and nothing reaches the live site until it is approved and you publish it.
      </p>
      <Field label="A note for the reviewer (optional)">
        <Textarea rows={3} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}
