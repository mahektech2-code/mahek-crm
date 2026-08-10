"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import { Modal } from "@/components/ui/overlays";
import { Button, Field, Input, cx } from "@/components/ui/primitives";
import { VoiceTextarea } from "@/components/ui/dictate";
import { ImagePicker } from "@/components/crm/image-picker";
import { myFeedbackSummary, submitFeedback } from "@/lib/actions/feedback";
import { FEEDBACK_KINDS, KIND_LABELS, type FeedbackKind } from "@/lib/feedback-labels";

/* ---------------------------------------------------------------------------
 * "Tell us" — the one way the team reports a fault or asks for something.
 *
 * It lives in the header of every app rather than on a page of its own,
 * because the moment somebody wants to report a broken screen is the moment
 * they are standing on it, and a form two navigations away is a fault that
 * gets mentioned in the corridor instead and then lost.
 *
 * The screen they were on is captured, not asked for. So is the browser. Both
 * are the difference between a report somebody can act on and one that reads
 * "it did not work".
 *
 * It carries its own success state rather than a toast: this is the only
 * control in MahekOne that four different shells mount, and two of them have
 * no ToastProvider above them. Saying thank you inside the dialog works
 * everywhere and does not vanish after four seconds.
 * ------------------------------------------------------------------------- */

/** The label under each option — what makes the four kinds tell themselves apart. */
const KIND_HINTS: Record<FeedbackKind, string> = {
  bug: "A screen, number or button that is wrong or will not work",
  suggestion: "Something that works but could be easier",
  feature: "Something MahekOne does not do yet",
  question: "Anything else you want to ask",
};

export function FeedbackButton({
  /** `compact` is the icon alone, for a header already full of controls. */
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Report a problem or suggest something"
        aria-label="Send feedback"
        className={cx(
          "flex h-8 cursor-pointer items-center gap-1.5 rounded-[4px] border border-line bg-surface text-[13px] font-medium text-muted hover:bg-canvas hover:text-body",
          compact ? "w-8 justify-center" : "px-2.5",
          className,
        )}
      >
        <Icon name="chat" size={15} />
        {compact ? null : "Feedback"}
      </button>

      {/* The form is a child of the modal, so closing unmounts it and the next
          visit starts blank — state reset by remounting, never by an effect. */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Tell us"
        width={560}
        footer={null}
      >
        <FeedbackForm onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}

/**
 * How many screenshots the form offers. Configuration owns the real limit —
 * `attachments.maxPerFeedback` — and the server refuses anything over it, but
 * this dialog is a client with no async config above it, so it offers a number
 * and lets the save be the authority. Three is the shipped default; a limit
 * lowered in the console shows up as "2 of 3 attached" rather than a refusal.
 */
const OFFERED_IMAGES = 3;

function FeedbackForm({ onDone }: { onDone: () => void }) {
  const path = usePathname();
  const [kind, setKind] = React.useState<FeedbackKind>("bug");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [images, setImages] = React.useState<File[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [field, setField] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<string | null>(null);
  const [mine, setMine] = React.useState<{ total: number; unreadReplies: number } | null>(
    null,
  );

  // What they have already sent, so the way back to the answers is on the
  // screen they would go looking on. Read on open rather than passed in: five
  // different app shells mount this button.
  React.useEffect(() => {
    let live = true;
    myFeedbackSummary().then((r) => {
      if (live && r.ok) setMine(r.data);
    });
    return () => {
      live = false;
    };
  }, []);

  async function send() {
    setBusy(true);
    setError(null);
    setField(null);
    try {
      const result = await submitFeedback({
        kind,
        title,
        body,
        images,
        path,
        userAgent:
          typeof navigator === "undefined" ? undefined : navigator.userAgent.slice(0, 400),
      });
      if (!result.ok) {
        setError(result.error);
        setField(result.fieldErrors?.[0]?.field ?? null);
        return;
      }
      setSent(result.message ?? "Thank you — that is logged.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div>
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-success text-white">
            <Icon name="tick" size={12} />
          </span>
          <div>
            <div className="text-sm font-medium text-ink">{sent}</div>
            <div className="mt-1 text-[13px] leading-[19px] text-muted">
              It goes to whoever looks after MahekOne. You will get a
              notification here when somebody answers it — including if the
              answer is no. The whole conversation is under{" "}
              <Link href="/feedback" className="text-brand hover:underline">
                Your feedback
              </Link>
              , and you can add to it there.
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={onDone}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="text-[13px] leading-[19px] text-muted">
        Anything at all — a screen that is wrong, a number that does not add
        up, or something you wish this did. It reaches the people who build it.
      </div>

      <div className="mt-4">
        <span className="mb-1.5 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
          What is it
        </span>
        <div className="flex flex-col gap-1.5">
          {FEEDBACK_KINDS.map((k) => (
            <label
              key={k}
              className={cx(
                "flex cursor-pointer items-start gap-2.5 rounded-[4px] border px-3 py-2",
                kind === k ? "border-brand bg-brand-soft" : "border-line hover:bg-canvas",
              )}
            >
              <input
                type="radio"
                name="feedback-kind"
                checked={kind === k}
                onChange={() => setKind(k)}
                className="mt-0.5 h-[15px] w-[15px] accent-[#6835FB]"
              />
              <span className="leading-[18px]">
                <span className="block text-sm font-medium text-ink">
                  {KIND_LABELS[k]}
                </span>
                <span className="block text-[13px] text-muted">{KIND_HINTS[k]}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <Field
        label="In one line"
        className="mt-4"
        error={field === "title" ? error : null}
      >
        <Input
          autoFocus
          value={title}
          maxLength={120}
          invalid={field === "title"}
          placeholder={
            kind === "bug"
              ? "The outstanding figure on the customer page is wrong"
              : "Let me filter the queue by area"
          }
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>

      <Field
        label={kind === "bug" ? "What happened" : "Tell us more"}
        className="mt-3.5"
        hint={
          kind === "bug"
            ? "What you did, what you expected, and what you saw instead."
            : "What you are trying to do, and what would make it easier."
        }
        error={field === "body" ? error : null}
      >
        <VoiceTextarea
          rows={5}
          value={body}
          maxLength={4000}
          invalid={field === "body"}
          onChange={(e) => setBody(e.target.value)}
          onDictate={setBody}
        />
      </Field>

      {/* A screenshot of the wrong screen settles in one picture what a
          paragraph describes badly, and the person reporting it is standing on
          the fault right now. Never required, and never able to fail the
          report: what does not upload is reported by count. */}
      <div className="mt-3.5">
        <ImagePicker
          files={images}
          onChange={setImages}
          max={OFFERED_IMAGES}
          label="Screenshot, if it helps"
          hint="A picture of the screen that is wrong settles in one look what a paragraph describes badly."
        />
      </div>

      {error && !field ? (
        <div className="mt-3 text-[13px] text-danger">{error}</div>
      ) : null}

      <div className="mt-4 rounded-[4px] bg-canvas px-3 py-2 text-[13px] text-muted">
        Sent with the screen you are on — <span className="font-mono">{path}</span> —
        and your name, so somebody can come back to you.
      </div>

      <div className="mt-5 flex items-center justify-end gap-2.5">
        {mine && mine.total ? (
          <Link
            href="/feedback"
            className="mr-auto text-[13px] font-medium text-brand hover:underline"
          >
            Your {mine.total} report{mine.total === 1 ? "" : "s"}
            {mine.unreadReplies
              ? ` · ${mine.unreadReplies} new repl${mine.unreadReplies === 1 ? "y" : "ies"}`
              : ""}
          </Link>
        ) : null}
        <Button variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={send}
          disabled={busy || title.trim().length < 4 || body.trim().length < 10}
          title={
            title.trim().length < 4
              ? "Give it a short heading first"
              : body.trim().length < 10
                ? "Say a little more first"
                : undefined
          }
        >
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
