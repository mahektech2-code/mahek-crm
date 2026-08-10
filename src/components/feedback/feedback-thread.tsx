"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, cx } from "@/components/ui/primitives";
import { VoiceTextarea } from "@/components/ui/dictate";
import { AttachmentStrip } from "@/components/ui/attachment-strip";
import { ImagePicker } from "@/components/crm/image-picker";
import { stamp } from "@/lib/format";
import { STATUS_LABELS } from "@/lib/feedback-labels";
import type { FeedbackRow } from "@/lib/services/feedback-service";
import { replyToFeedback } from "@/lib/actions/feedback";

/* ---------------------------------------------------------------------------
 * The conversation about one report, and the box to add to it.
 *
 * One component for both sides. The Admin Console and the reporter's own
 * screen show the SAME messages in the same order — a submitter reading a
 * shorter version of the conversation they are in is how somebody concludes
 * nobody answered them, and stops writing reports.
 *
 * What differs is only which side is "you", which decides the alignment and
 * the placeholder. It does not decide what is visible.
 *
 * No toast: this mounts inside the console, inside a dialog and on a page of
 * its own, and two of those shells have no ToastProvider above them. The
 * result is said inline, where it also does not vanish after four seconds.
 * ------------------------------------------------------------------------- */

export function FeedbackThread({
  report,
  /** The signed-in person. Their own lines sit on the right. */
  viewerId,
  /** `attachments.maxPerFeedback`, read from configuration by the server. */
  maxImages,
  canReply = true,
}: {
  report: FeedbackRow;
  viewerId: string;
  maxImages: number;
  canReply?: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = React.useState("");
  const [images, setImages] = React.useState<File[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);

  const isMine = report.byId === viewerId;

  async function send() {
    setBusy(true);
    setNote(null);
    try {
      const result = await replyToFeedback({ id: report.id, body, images });
      if (!result.ok) {
        setNote({ ok: false, text: result.error });
        return;
      }
      setBody("");
      setImages([]);
      setNote({ ok: true, text: result.message ?? "Sent." });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-2.5">
        {/* The report itself is the first thing said, so it is the first
            message — not a header with the conversation underneath it. */}
        <Bubble
          author={report.byName}
          role={report.byRole}
          at={report.createdAt}
          mine={isMine}
          body={report.body}
          files={report.attachments}
        />

        {report.messages.map((m) =>
          m.body === null && m.statusTo ? (
            <StatusLine
              key={m.id}
              who={m.authorName}
              status={STATUS_LABELS[m.statusTo]}
              at={m.at}
            />
          ) : (
            <Bubble
              key={m.id}
              author={m.authorName}
              role={m.authorRole}
              at={m.at}
              mine={m.authorId === viewerId}
              body={m.body ?? ""}
              files={m.attachments}
              statusTo={m.statusTo ? STATUS_LABELS[m.statusTo] : null}
            />
          ),
        )}
      </div>

      {canReply ? (
        <div className="mt-4 border-t border-divider pt-4">
          {/* Both ends of the thread get the microphone. A telecaller
              describing a fault in Hindi types the short version of it in
              English, which is exactly the loss dictation exists to close —
              and a report nobody can act on is the one that gets shrugged at. */}
          <VoiceTextarea
            rows={3}
            value={body}
            maxLength={2000}
            disabled={busy}
            placeholder={
              isMine
                ? "Anything else that would help — what you were doing, what you expected."
                : `What you are doing about it, or why not. ${report.byName.split(" ")[0]} sees this.`
            }
            onChange={(e) => setBody(e.target.value)}
            onDictate={setBody}
          />

          {maxImages > 0 ? (
            <div className="mt-2.5">
              <ImagePicker
                files={images}
                onChange={setImages}
                max={maxImages}
                label="Attach a screenshot"
                hint={
                  isMine
                    ? "A picture of what you are seeing, if that says it better."
                    : "A picture of the fix, or of what you need them to look at."
                }
              />
            </div>
          ) : null}

          {note ? (
            <div
              className={cx(
                "mt-2 text-[13px]",
                note.ok ? "text-success" : "text-danger",
              )}
            >
              {note.text}
            </div>
          ) : null}

          <div className="mt-2.5 flex justify-end">
            <Button
              variant="primary"
              disabled={busy || body.trim().length === 0}
              title={body.trim().length === 0 ? "Write something first" : undefined}
              onClick={send}
            >
              {busy ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Bubble({
  author,
  role,
  at,
  mine,
  body,
  files,
  statusTo,
}: {
  author: string;
  role: string;
  at: string;
  mine: boolean;
  body: string;
  files: FeedbackRow["attachments"];
  statusTo?: string | null;
}) {
  return (
    <div className={cx("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cx(
          "max-w-[min(680px,92%)] rounded-[6px] border px-3.5 py-2.5",
          mine ? "border-brand-soft bg-brand-soft" : "border-line bg-surface",
        )}
      >
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          {author} · {role} · {stamp(at)}
        </div>
        <div className="mt-1 text-sm leading-[21px] whitespace-pre-wrap text-body">
          {body}
        </div>
        {statusTo ? (
          <div className="mt-1.5 text-[13px] text-muted">
            Marked <span className="font-medium text-ink">{statusTo}</span> with this.
          </div>
        ) : null}
        <AttachmentStrip files={files} />
      </div>
    </div>
  );
}

/** A status change with nothing typed beside it — a fact, not a message. */
function StatusLine({ who, status, at }: { who: string; status: string; at: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="h-px flex-1 bg-divider" />
      <span className="text-[13px] text-muted">
        {who} marked this <span className="font-medium text-ink">{status}</span> ·{" "}
        {stamp(at)}
      </span>
      <span className="h-px flex-1 bg-divider" />
    </div>
  );
}
