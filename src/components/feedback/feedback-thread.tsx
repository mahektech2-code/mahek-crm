"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, cx } from "@/components/ui/primitives";
import { VoiceTextarea } from "@/components/ui/dictate";
import { AttachmentStrip } from "@/components/ui/attachment-strip";
import { stamp } from "@/lib/format";
import { STATUS_LABELS, type FeedbackStatus } from "@/lib/feedback-labels";
import type { FeedbackRow } from "@/lib/services/feedback-service";
import { answerFix, replyToFeedback, setFeedbackStatus } from "@/lib/actions/feedback";
import {
  PictureIcon,
  ShotButton,
  ShotThumbs,
  addShots,
  useFilePicker,
  usePasteImages,
} from "./shots";

/* ---------------------------------------------------------------------------
 * The conversation about one report, and the box to add to it.
 *
 * One component for both sides. The reporter's Feedback page and the Admin
 * Console show the same lines in the same order — what differs is decided by
 * the SERVICE (team notes are simply not in the reporter's rows), and here only
 * by which side is "you":
 *
 *   - the reporter's own lines sit on the right, the team's on the left;
 *   - triage can write a team note, drawn in amber and labelled as unseen by
 *     the reporter, which never notifies them;
 *   - the reporter, on a report marked Done, is asked "Is it fixed for you?" —
 *     "still happening" reopens it, which is the only answer that changes
 *     anything (Done closes a report outright).
 *
 * No toast: this mounts in several shells and two have no ToastProvider above
 * them. The result is said inline, where it also does not vanish.
 * ------------------------------------------------------------------------- */

const STATUS_TONE: Record<FeedbackStatus, string> = {
  new: "text-ink",
  in_progress: "text-brand-deep",
  done: "text-success",
  declined: "text-muted",
};

export function FeedbackThread({
  report,
  viewerId,
  maxImages,
  view,
  canReply = true,
}: {
  report: FeedbackRow;
  /** The signed-in person. Their own lines sit on the right. */
  viewerId: string;
  /** `attachments.maxPerFeedback`, read from configuration by the server. */
  maxImages: number;
  view: "reporter" | "team";
  canReply?: boolean;
}) {
  const reporterSide = view === "reporter";
  const reporters = new Set([report.byId, ...report.alsoReported.map((a) => a.byId)]);

  return (
    <div className="flex flex-col gap-3.5">
      {/* The report itself is the first thing said, so it is the first
          message — not a header with the conversation underneath it. */}
      <Bubble
        author={report.byId === viewerId ? "You" : report.byName}
        at={report.createdAt}
        mine={reporterSide ? report.byId === viewerId : false}
        tone={reporterSide ? "mine" : "reporter"}
        body={report.body}
        files={report.attachments}
        footnote={
          report.path ? (
            <>
              Sent from <span className="font-mono">{report.path}</span>
            </>
          ) : null
        }
      />

      {report.alsoReported.length ? (
        view === "team" ? (
          <div className="rounded-[8px] border border-divider bg-page px-3.5 py-3">
            <div className="text-xs font-semibold text-body">
              Also reported by {report.alsoReported.length}{" "}
              {report.alsoReported.length === 1 ? "person" : "people"}
            </div>
            {report.alsoReported.map((a) => (
              <div key={a.id} className="mt-2 text-[13px] leading-5 text-body">
                <b className="font-semibold text-ink">{a.byName}</b>{" "}
                <span className="text-muted">· {a.ref} · {stamp(a.createdAt)}</span>
                <div className="whitespace-pre-wrap">{a.body}</div>
                <AttachmentStrip files={a.attachments} />
              </div>
            ))}
          </div>
        ) : (
          <SystemLine>
            {report.alsoReported.length === 1
              ? "One other person reported the same thing"
              : `${report.alsoReported.length} other people reported the same thing`}
          </SystemLine>
        )
      ) : null}

      {report.messages.map((m) => {
        if (m.body === null && m.statusTo) {
          return (
            <SystemLine key={m.id}>
              {m.authorId === viewerId ? "You" : m.authorName} moved this to{" "}
              <b className={cx("font-semibold", STATUS_TONE[m.statusTo])}>{STATUS_LABELS[m.statusTo]}</b> ·{" "}
              {stamp(m.at)}
            </SystemLine>
          );
        }
        if (m.internal) {
          return (
            <div key={m.id} className="rounded-[8px] border border-warn-line bg-warn-soft px-3.5 py-2.5">
              <div className="text-xs font-semibold text-warn-ink">
                Team note · {m.authorId === viewerId ? "you" : m.authorName} · {stamp(m.at)} · not seen by{" "}
                {report.byName.split(" ")[0]}
              </div>
              <div className="mt-1 text-sm leading-[21px] whitespace-pre-wrap text-ink">{m.body}</div>
              <AttachmentStrip files={m.attachments} />
            </div>
          );
        }
        const fromReporter = reporters.has(m.authorId);
        return (
          <Bubble
            key={m.id}
            author={m.authorId === viewerId ? "You" : m.authorName}
            role={fromReporter ? undefined : "MahekOne team"}
            at={m.at}
            mine={reporterSide ? fromReporter && m.authorId === viewerId : !fromReporter}
            tone={fromReporter ? (reporterSide ? "mine" : "reporter") : "team"}
            body={m.body ?? ""}
            files={m.attachments}
            footnote={
              m.statusTo ? (
                <>
                  Moved it to <b className="font-semibold text-ink">{STATUS_LABELS[m.statusTo]}</b>
                </>
              ) : null
            }
          />
        );
      })}

      {reporterSide && report.status === "done" && !report.verdict ? <FixCheck id={report.id} /> : null}
      {reporterSide && report.verdict === "fixed" && report.status === "done" ? (
        <SystemLine>You confirmed it is fixed</SystemLine>
      ) : null}

      {canReply ? <Composer report={report} view={view} maxImages={maxImages} /> : null}
    </div>
  );
}

function Bubble({
  author,
  role,
  at,
  mine,
  tone,
  body,
  files,
  footnote,
}: {
  author: string;
  role?: string;
  at: string;
  mine: boolean;
  tone: "mine" | "team" | "reporter";
  body: string;
  files: FeedbackRow["attachments"];
  footnote?: React.ReactNode;
}) {
  return (
    <div className={cx("flex gap-2.5", mine ? "justify-end" : "justify-start")}>
      {!mine ? (
        <span
          className={cx(
            "mt-0.5 flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full text-[11px] font-semibold",
            tone === "team" ? "bg-ink text-white" : "bg-brand-soft text-brand-deep",
          )}
          aria-hidden
        >
          {initialsOf(author)}
        </span>
      ) : null}
      <div
        className={cx(
          "max-w-[min(640px,84%)] px-3.5 py-2.5",
          tone === "mine"
            ? "rounded-[10px_10px_2px_10px] bg-brand-soft"
            : tone === "team" && mine
              ? "rounded-[10px_10px_2px_10px] border border-line bg-surface"
              : "rounded-[10px_10px_10px_2px] border border-line bg-surface",
        )}
      >
        <div className={cx("text-xs font-semibold", tone === "mine" ? "text-brand-deep" : "text-body")}>
          {author}
          {role ? ` · ${role}` : ""} · <span className="font-normal">{stamp(at)}</span>
        </div>
        <div className="mt-1 text-sm leading-[21px] whitespace-pre-wrap text-ink">{body}</div>
        <AttachmentStrip files={files} />
        {footnote ? <div className="mt-2 text-[11px] text-muted">{footnote}</div> : null}
      </div>
    </div>
  );
}

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** A fact rather than a message — a status change, a merge, an answer. */
function SystemLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-xs text-muted">
      <span className="h-px flex-1 bg-divider" />
      <span className="text-center">{children}</span>
      <span className="h-px flex-1 bg-divider" />
    </div>
  );
}

/** "Is it fixed for you?" — asked of the reporter once a report is marked Done. */
function FixCheck({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function answer(verdict: "fixed" | "still_happening") {
    setBusy(true);
    setError(null);
    const r = await answerFix({ id, verdict });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-[8px] border border-success bg-success-soft px-4 py-3">
      <div className="min-w-[200px] flex-1">
        <div className="text-sm font-semibold text-ink">Is it fixed for you?</div>
        <div className="mt-0.5 text-xs text-body">
          It is closed as done. If it is still happening, say so and it goes straight back to the team.
        </div>
        {error ? <div className="mt-1 text-xs text-danger">{error}</div> : null}
      </div>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => answer("still_happening")}
        className="border-danger text-danger"
      >
        Still happening
      </Button>
      <Button variant="primary" disabled={busy} onClick={() => answer("fixed")} className="border-success bg-success hover:bg-success">
        Yes, it&apos;s fixed
      </Button>
    </div>
  );
}

function Composer({
  report,
  view,
  maxImages,
}: {
  report: FeedbackRow;
  view: "reporter" | "team";
  maxImages: number;
}) {
  const router = useRouter();
  const ref = React.useRef<HTMLDivElement>(null);
  const [mode, setMode] = React.useState<"reply" | "note">("reply");
  const [body, setBody] = React.useState("");
  const [images, setImages] = React.useState<File[]>([]);
  const [shotNote, setShotNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);

  const add = React.useCallback(
    (picked: File[]) =>
      setImages((cur) => {
        const next = addShots(cur, picked, maxImages);
        setShotNote(next.refused);
        return next.files;
      }),
    [maxImages],
  );
  usePasteImages(ref, add);
  const picker = useFilePicker(add);
  const internal = view === "team" && mode === "note";
  const first = report.byName.split(" ")[0];
  const others = report.alsoReported.length;

  async function send(then?: () => Promise<unknown>) {
    setBusy(true);
    setNote(null);
    try {
      const result = await replyToFeedback({ id: report.id, body, images, internal });
      if (!result.ok) {
        setNote({ ok: false, text: result.error });
        return;
      }
      if (then) await then();
      setBody("");
      setImages([]);
      setNote({ ok: true, text: result.message ?? "Sent." });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={ref}
      className={cx(
        "overflow-hidden rounded-[8px] border",
        internal ? "border-warn-line" : "border-line-strong",
      )}
    >
      {view === "team" ? (
        <div className="flex border-b border-divider" role="tablist">
          {(
            [
              ["reply", `Reply to ${first}${others ? ` + ${others}` : ""}`],
              ["note", "Team note"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cx(
                "h-9 flex-1 cursor-pointer border-b-2 text-[13px]",
                mode === m
                  ? m === "note"
                    ? "border-warn bg-warn-soft font-semibold text-warn-ink"
                    : "border-brand bg-surface font-semibold text-brand-deep"
                  : "border-transparent bg-page font-medium text-muted hover:text-body",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <VoiceTextarea
        rows={3}
        value={body}
        maxLength={2000}
        disabled={busy}
        aria-label={internal ? "Team note" : "Reply"}
        placeholder={
          view === "reporter"
            ? "Add to this — a sentence or a screenshot is often what makes it findable"
            : internal
              ? `Only the team sees this. ${first} is not told.`
              : `What you are doing about it, or why not. ${first} sees this.`
        }
        onChange={(e) => setBody(e.target.value)}
        onDictate={setBody}
        className="rounded-none border-0 shadow-none focus:shadow-none"
      />
      {images.length || shotNote ? (
        <div className="border-t border-divider px-3 py-2">
          <ShotThumbs files={images} size={48} onRemove={(i) => setImages((f) => f.filter((_, n) => n !== i))} />
          {shotNote ? <div className="mt-1 text-xs text-danger">{shotNote}</div> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-divider bg-page px-2.5 py-2">
        {maxImages > 0 ? (
          <ShotButton label="Add a screenshot" onClick={picker.open} disabled={busy || images.length >= maxImages}>
            <PictureIcon />
          </ShotButton>
        ) : null}
        {picker.input}
        {note ? (
          <span className={cx("text-[13px]", note.ok ? "text-success" : "text-danger")}>{note.text}</span>
        ) : null}
        <span className="flex-1" />
        <Button
          variant={view === "team" && !internal && report.status === "new" ? "secondary" : "primary"}
          disabled={busy || !body.trim()}
          title={!body.trim() ? "Write something first" : undefined}
          onClick={() => send()}
        >
          {busy ? "Sending…" : internal ? "Save note" : "Send"}
        </Button>
        {view === "team" && !internal && report.status === "new" ? (
          <Button
            variant="primary"
            disabled={busy || !body.trim()}
            onClick={() =>
              send(() => setFeedbackStatus(report.id, "in_progress"))
            }
          >
            Send + Being looked at
          </Button>
        ) : null}
      </div>
    </div>
  );
}
