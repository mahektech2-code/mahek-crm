"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Select,
  Textarea,
  Th,
  Td,
  Tr,
  cx,
  type Tone,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { stamp } from "@/lib/format";
import {
  FEEDBACK_STATUSES,
  KIND_SHORT,
  STATUS_LABELS,
  type FeedbackKind,
  type FeedbackStatus,
} from "@/lib/feedback-labels";
import type { FeedbackRow } from "@/lib/services/feedback-service";
import { setFeedbackNote, setFeedbackStatus } from "@/lib/actions/feedback";
import { PLATFORM_TABS } from "./data";

/* ---------------------------------------------------------------------------
 * Feedback → what the team has sent in.
 *
 * A section rather than a settings tab, because none of it is configuration:
 * these are rows written by colleagues, and the work here is answering them.
 *
 * The tabs are the statuses in the order they are worked — New first, because
 * an unread report is the only kind that costs anything. `Everything` exists
 * so a report that was declined months ago can still be found; nothing here
 * is ever deleted.
 * ------------------------------------------------------------------------- */

/** The tabs live where every other platform section's do — one registry. */
const TABS = PLATFORM_TABS.feedback;

export type FeedbackData = {
  rows: FeedbackRow[];
  counts: { new: number; in_progress: number; done: number; declined: number; total: number };
  /** Whether this person may move a report along, or only read them. */
  canTriage: boolean;
};

const KIND_TONE: Record<FeedbackKind, Tone> = {
  bug: "danger",
  suggestion: "neutral",
  feature: "brand",
  question: "neutral",
};

const STATUS_TONE: Record<FeedbackStatus, Tone> = {
  new: "warn",
  in_progress: "brand",
  done: "success",
  declined: "neutral",
};

export function FeedbackSection({ data, tab }: { data: FeedbackData; tab: number }) {
  const slug = TABS[Math.min(tab, TABS.length - 1)].slug;

  const rows = data.rows.filter((r) => {
    if (slug === "new") return r.status === "new";
    if (slug === "in-progress") return r.status === "in_progress";
    // Both kinds are somebody asking for something MahekOne does not do; the
    // line between them is finer than anybody triaging wants to care about.
    if (slug === "requests") return r.kind === "feature" || r.kind === "suggestion";
    return true;
  });

  return (
    <div className="mt-5">
      <div className="mb-4 flex flex-wrap gap-2.5">
        <Count label="New" value={data.counts.new} tone={data.counts.new ? "warn" : "neutral"} />
        <Count label="Being looked at" value={data.counts.in_progress} tone="brand" />
        <Count label="Done" value={data.counts.done} tone="success" />
        <Count label="Not doing" value={data.counts.declined} tone="neutral" />
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title={
              slug === "new"
                ? "Nothing new to read"
                : slug === "in-progress"
                  ? "Nothing is being worked on"
                  : slug === "requests"
                    ? "Nobody has asked for anything yet"
                    : "No feedback has been sent yet"
            }
            body={
              data.counts.total === 0
                ? "The Feedback button sits in the header of every app. Anything the team sends from it lands here."
                : "Everything sent in is under Everything — this tab is simply empty."
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-2.5">
          {rows.map((r) => (
            <Report key={r.id} row={r} canTriage={data.canTriage} />
          ))}
        </div>
      )}

      {!data.canTriage && rows.length ? (
        <div className="mt-4 text-[13px] text-muted">
          Read-only. Answering feedback is a manager&apos;s to do — the person who
          wrote it is told what you decide, so it is not a decision to leave to
          whoever happens to have this screen open.
        </div>
      ) : null}
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: Tone }) {
  return (
    <Card className="flex min-w-[150px] flex-col gap-1 px-4 py-3">
      <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <span className="flex items-center gap-2">
        <span className="text-[22px] leading-7 font-semibold text-ink">{value}</span>
        {value && tone === "warn" ? <Badge tone={tone}>waiting</Badge> : null}
      </span>
    </Card>
  );
}

function Report({ row, canTriage }: { row: FeedbackRow; canTriage: boolean }) {
  const router = useRouter();
  const { run } = useToast();
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState(row.adminNote ?? "");
  const [busy, setBusy] = React.useState(false);

  async function changeStatus(status: FeedbackStatus) {
    setBusy(true);
    try {
      const result = await run(setFeedbackStatus(row.id, status));
      if (result.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveNote() {
    setBusy(true);
    try {
      const result = await run(setFeedbackNote(row.id, note));
      if (result.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 px-5 py-3.5">
        <button
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 flex-1 cursor-pointer border-none bg-transparent text-left"
        >
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={KIND_TONE[row.kind]}>{KIND_SHORT[row.kind]}</Badge>
            <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABELS[row.status]}</Badge>
            <span
              className={cx(
                "text-sm text-ink",
                row.status === "new" ? "font-semibold" : "font-medium",
              )}
            >
              {row.title}
            </span>
          </span>
          <span className="mt-1 block text-[13px] text-muted">
            {row.byName} · {row.byRole} · {stamp(row.createdAt)}
            {row.path ? (
              <>
                {" · "}
                <span className="font-mono">{row.path}</span>
              </>
            ) : null}
          </span>
        </button>

        {canTriage ? (
          <Select
            value={row.status}
            disabled={busy}
            onChange={(e) => changeStatus(e.target.value as FeedbackStatus)}
            title="Move this report along — the person who wrote it is told"
          >
            {FEEDBACK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        ) : null}
      </div>

      {open ? (
        <div className="border-t border-divider bg-canvas px-5 py-4">
          <div className="text-sm leading-[21px] whitespace-pre-wrap text-body">
            {row.body}
          </div>

          <table className="mt-4 w-auto">
            <tbody>
              <Tr>
                <Th>Screen</Th>
                <Td className="font-mono">{row.path ?? "—"}</Td>
              </Tr>
              <Tr>
                <Th>App</Th>
                <Td>{row.app ?? "—"}</Td>
              </Tr>
              <Tr>
                <Th>Browser</Th>
                <Td className="max-w-[520px] truncate" title={row.userAgent ?? undefined}>
                  {row.userAgent ?? "—"}
                </Td>
              </Tr>
              {row.handledByName ? (
                <Tr>
                  <Th>Last answered</Th>
                  <Td>
                    {row.handledByName} · {stamp(row.handledAt)}
                  </Td>
                </Tr>
              ) : null}
            </tbody>
          </table>

          <div className="mt-4">
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
              Reply to {row.byName.split(" ")[0]}
            </span>
            {canTriage ? (
              <>
                <Textarea
                  rows={3}
                  value={note}
                  maxLength={2000}
                  placeholder="What you are doing about it, or why not. They see this."
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="secondary"
                    disabled={busy || note === (row.adminNote ?? "")}
                    title={note === (row.adminNote ?? "") ? "Nothing to save" : undefined}
                    onClick={saveNote}
                  >
                    Save reply
                  </Button>
                </div>
              </>
            ) : (
              <div className="text-sm text-body">
                {row.adminNote ?? "Nobody has answered this yet."}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
