"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import { Button, Input, cx } from "@/components/ui/primitives";
import { VoiceTextarea } from "@/components/ui/dictate";
import { PictureIcon, ScreenIcon, ShotButton, ShotThumbs, addShots, canCaptureScreen, captureScreen, useFilePicker, usePasteImages } from "@/components/feedback/shots";
import { similarReports, submitFeedback } from "@/lib/actions/feedback";
import { FEEDBACK_IMPACTS, FEEDBACK_KINDS, IMPACT_LABELS, KIND_HINTS, KIND_TILES, feedbackHomeFor, titleFromBody, type FeedbackImpact, type FeedbackKind } from "@/lib/feedback-labels";
import type { SimilarReport } from "@/lib/services/feedback-service";

import { KIND_ICON } from "./feedback-button";

/* The Tell us form, loaded when the dialog opens — see `TellUsForm` in feedback-button.tsx. */

/**
 * How many screenshots the form offers. Configuration owns the real limit —
 * `attachments.maxPerFeedback` — and the server refuses anything over it; this
 * client offers the shipped default and lets the save be the authority.
 */
const OFFERED_IMAGES = 3;

/** "CRM › Calling queue" — the app and the screen, read off the page title. */
function screenName(path: string): string {
  if (typeof document === "undefined") return path;
  const [screen, app] = document.title.split(" - ");
  const appName = app?.replace(/^MahekOne\s*/, "").trim();
  if (screen && appName) return `${appName} › ${screen}`;
  return screen || path;
}

const HELP_LINES = ["What I did: ", "What I expected: ", "What happened instead: "];

export function TellUsForm({ initialKind, onDone }: { initialKind: FeedbackKind; onDone: () => void }) {
  const path = usePathname() ?? "";
  const formRef = React.useRef<HTMLDivElement>(null);
  const [kind, setKind] = React.useState<FeedbackKind>(initialKind);
  const [impact, setImpact] = React.useState<FeedbackImpact | null>(null);
  const [body, setBody] = React.useState("");
  const [title, setTitle] = React.useState<string | null>(null);
  const [images, setImages] = React.useState<File[]>([]);
  const [shotNote, setShotNote] = React.useState<string | null>(null);
  const [similar, setSimilar] = React.useState<SimilarReport[]>([]);
  const [dismissed, setDismissed] = React.useState<string[]>([]);
  const [sameAs, setSameAs] = React.useState<SimilarReport | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<{ id: string; ref: string; sameAs: string | null } | null>(null);
  const [where] = React.useState(() => screenName(path));
  const [canCapture] = React.useState(() => canCaptureScreen());

  const addFiles = React.useCallback(
    (picked: File[]) => {
      setImages((current) => {
        const next = addShots(current, picked, OFFERED_IMAGES);
        setShotNote(next.refused);
        return next.files;
      });
    },
    [],
  );
  usePasteImages(formRef, addFiles);
  const picker = useFilePicker(addFiles);

  // Reports that read the same, looked up a moment after they stop typing.
  React.useEffect(() => {
    const text = body.trim();
    if (text.length < 16) return;
    const timer = setTimeout(() => {
      similarReports(text)
        .then((r) => setSimilar(r.ok ? r.data : []))
        .catch(() => {});
    }, 700);
    return () => clearTimeout(timer);
  }, [body]);

  const offered = sameAs
    ? null
    : (similar.find((s) => !dismissed.includes(s.id)) ?? null);
  const similarRef = React.useRef<HTMLDivElement>(null);
  const offeredId = offered?.id ?? null;
  // A card that appears below the fold of a scrolling dialog is a card nobody
  // sees: bring it into view the moment it is offered.
  React.useEffect(() => {
    if (offeredId) similarRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [offeredId]);
  const autoTitle = titleFromBody(body);
  const shownTitle = title ?? autoTitle;
  const tooShort = body.trim().length < 10;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const result = await submitFeedback({
        kind,
        title: title ?? undefined,
        body,
        impact: kind === "bug" ? (impact ?? undefined) : undefined,
        sameAsId: sameAs?.id,
        images,
        path,
        userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent.slice(0, 400),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSent(result.data);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return <SentState sent={sent} title={shownTitle} kind={kind} impact={impact} where={where} shots={images.length} path={path} onAnother={() => {
      setSent(null);
      setBody("");
      setTitle(null);
      setImages([]);
      setSameAs(null);
      setSimilar([]);
      setImpact(null);
    }} onDone={onDone} />;
  }

  return (
    <div ref={formRef}>
      <div className="inline-flex max-w-full items-center gap-1.5 rounded-[4px] border border-divider bg-canvas px-2 py-0.5 text-xs text-body">
        <Icon name="pin" size={13} className="flex-none text-muted" />
        <span className="truncate">From {where} — attached for you</span>
      </div>

      <div className="mt-4">
        <div className="mb-2 text-xs font-semibold text-body">What is it about?</div>
        <div role="radiogroup" aria-label="What is it about?" className="grid grid-cols-2 gap-2">
          {FEEDBACK_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={cx(
                "flex cursor-pointer items-start gap-3 rounded-[8px] border px-3.5 py-3 text-left",
                kind === k
                  ? "border-brand bg-brand-soft shadow-[inset_0_0_0_1px_var(--color-brand)]"
                  : "border-line bg-surface hover:bg-canvas",
              )}
            >
              <span className={cx("flex h-7 w-7 flex-none items-center justify-center rounded-lg", KIND_ICON[k].tone)}>
                {KIND_ICON[k].icon}
              </span>
              <span className="min-w-0 leading-[18px]">
                <span className="block text-sm font-semibold text-ink">{KIND_TILES[k]}</span>
                <span className="mt-0.5 block text-xs text-muted">{KIND_HINTS[k]}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {kind === "bug" ? (
        <div className="mt-4">
          <div className="mb-2 text-xs font-semibold text-body">How much is it getting in the way?</div>
          <div role="radiogroup" aria-label="How much is it getting in the way?" className="flex">
            {FEEDBACK_IMPACTS.map((i, n) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={impact === i}
                onClick={() => setImpact(impact === i ? null : i)}
                className={cx(
                  "h-9 flex-1 cursor-pointer border text-[13px] font-medium",
                  n === 0 ? "rounded-l-[7px]" : "-ml-px",
                  n === FEEDBACK_IMPACTS.length - 1 && "rounded-r-[7px]",
                  impact === i
                    ? "relative z-1 border-brand bg-brand-soft font-semibold text-brand-deep"
                    : "border-line bg-surface text-body hover:bg-canvas",
                )}
              >
                {IMPACT_LABELS[i]}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-4">
        <label htmlFor="fb-body" className="mb-2 block text-xs font-semibold text-body">
          {kind === "question" ? "What do you want to know?" : kind === "bug" ? "What happened?" : "Tell us more"}
        </label>
        <VoiceTextarea
          id="fb-body"
          autoFocus
          rows={4}
          value={body}
          maxLength={4000}
          disabled={busy}
          placeholder="Say it the way you would to a colleague. The first line becomes the title."
          onChange={(e) => setBody(e.target.value)}
          onDictate={setBody}
        />
        {offered ? (
          <div ref={similarRef} className="mt-3 rounded-[10px] border border-warn-line bg-warn-soft p-3.5">
            <div className="text-[13px] font-semibold text-warn-ink">Someone may have reported this already</div>
            <div className="mt-2 rounded-[8px] border border-warn-line bg-surface px-3 py-2.5">
              <div className="text-[11px] text-muted">
                {offered.ref} · reported by {offered.reporters} {offered.reporters === 1 ? "person" : "people"}
              </div>
              <div className="mt-0.5 text-sm font-medium text-ink">{offered.title}</div>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => setSameAs(offered)}>
                Same problem — add mine to it
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setDismissed((d) => [...d, offered.id])}>
                Mine is different
              </Button>
            </div>
            <div className="mt-2 text-[11px] leading-4 text-warn-ink">
              Adding yours keeps your words and screenshots, and every reply on it reaches you.
            </div>
          </div>
        ) : null}

        {sameAs ? (
          <div className="mt-3 flex items-center gap-3 rounded-[10px] border border-success bg-success-soft px-3.5 py-2.5">
            <Icon name="checkCircle" size={16} className="flex-none text-success" />
            <span className="min-w-0 flex-1 text-[13px] text-ink">
              Will be added to <b>{sameAs.ref}</b> — {sameAs.title}
            </span>
            <button type="button" onClick={() => setSameAs(null)} className="flex-none cursor-pointer text-xs font-medium text-brand">
              Send as new instead
            </button>
          </div>
        ) : null}
        {kind === "bug" ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">Help me say it:</span>
            {HELP_LINES.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() =>
                  setBody((b) => (b.trim() ? `${b.replace(/\s+$/, "")}\n${h}` : h))
                }
                className="h-7 cursor-pointer rounded-full border border-line bg-surface px-2.5 text-xs font-medium text-body hover:bg-canvas"
              >
                + {h.replace(/: $/, "")}
              </button>
            ))}
          </div>
        ) : null}
        {body.trim() ? (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted">
            {title !== null ? (
              <>
                <span className="flex-none">Title:</span>
                <Input
                  value={title}
                  maxLength={120}
                  onChange={(e) => setTitle(e.target.value)}
                  className="h-7 flex-1 text-xs"
                  aria-label="Title"
                />
                <button type="button" onClick={() => setTitle(null)} className="cursor-pointer font-medium text-brand">
                  Use the first line
                </button>
              </>
            ) : (
              <>
                <span className="min-w-0 truncate">
                  Title: <span className="font-medium text-body">{autoTitle || "—"}</span>
                </span>
                <button type="button" onClick={() => setTitle(autoTitle)} className="flex-none cursor-pointer font-medium text-brand">
                  edit
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>

      <div className="mt-4">
        <div className="mb-2 text-xs font-semibold text-body">
          Show us <span className="font-normal text-faint">optional</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canCapture ? (
            <ShotButton
              wide
              label="Capture this screen"
              disabled={images.length >= OFFERED_IMAGES}
              onClick={async () => {
                const shot = await captureScreen();
                if (shot) addFiles([shot]);
              }}
            >
              <ScreenIcon />
            </ShotButton>
          ) : null}
          <ShotButton wide label="Add a picture" disabled={images.length >= OFFERED_IMAGES} onClick={picker.open}>
            <PictureIcon />
          </ShotButton>
          {picker.input}
          <span className="text-xs text-faint">up to {OFFERED_IMAGES} · or paste with Ctrl+V</span>
        </div>
        {images.length ? (
          <div className="mt-2.5">
            <ShotThumbs files={images} onRemove={(i) => setImages((f) => f.filter((_, n) => n !== i))} />
          </div>
        ) : null}
        {shotNote ? <div className="mt-1.5 text-xs text-danger">{shotNote}</div> : null}
      </div>

      {error ? <div className="mt-3 text-[13px] text-danger">{error}</div> : null}

      <div className="sticky -bottom-4 z-10 -mx-5 mt-5 -mb-4 flex items-center gap-2.5 border-t border-divider bg-page px-5 py-3.5">
        <Link href={feedbackHomeFor(path)} onClick={onDone} className="mr-auto text-[13px] font-medium text-brand">
          Your feedback
        </Link>
        <Button variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={send}
          disabled={busy || tooShort}
          title={tooShort ? "Say what happened first — a sentence is enough." : undefined}
        >
          {busy ? "Sending…" : sameAs ? `Add to ${sameAs.ref}` : "Send"}
        </Button>
      </div>
    </div>
  );
}

const STEPS = ["Sent", "Seen by the team", "Being looked at", "Done"];

function SentState({
  sent,
  title,
  kind,
  impact,
  where,
  shots,
  path,
  onAnother,
  onDone,
}: {
  sent: { id: string; ref: string; sameAs: string | null };
  title: string;
  kind: FeedbackKind;
  impact: FeedbackImpact | null;
  where: string;
  shots: number;
  path: string;
  onAnother: () => void;
  onDone: () => void;
}) {
  return (
    <div>
      <div className="flex flex-col items-center px-4 pt-3 pb-5 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success">
          <Icon name="tick" size={26} />
        </span>
        <h2 className="mt-4 text-[22px] leading-7 font-semibold text-ink">Got it — thank you</h2>
        <p className="mt-2 max-w-[460px] text-[15px] leading-[22px] text-body">
          {sent.sameAs ? (
            <>
              Added to <RefPill>{sent.sameAs}</RefPill>, the report about the same thing. Every reply on it reaches you.
            </>
          ) : (
            <>
              Your report is <RefPill>{sent.ref}</RefPill>. When someone replies, it shows in your bell and on Your
              feedback — you don&apos;t need to chase it.
            </>
          )}
        </p>

        <ol className="relative mt-7 flex items-start" aria-label="Where it is">
          <span className="absolute top-[10px] right-[55px] left-[55px] h-0.5 bg-line" aria-hidden />
          <span className="absolute top-[10px] left-[55px] h-0.5 w-[110px] bg-success" aria-hidden />
          {STEPS.map((s, i) => (
            <li key={s} className={cx("relative flex w-[110px] flex-col items-center gap-1.5 text-xs", i === 0 ? "font-semibold text-success" : "text-muted")}>
              <span className={cx("h-[22px] w-[22px] rounded-full border-2", i === 0 ? "border-success bg-success" : "border-line bg-surface")} />
              {s}
            </li>
          ))}
        </ol>
      </div>

      <div className="mx-3 mb-5 flex items-center gap-3 rounded-[8px] border border-divider bg-page px-3.5 py-3">
        <span className={cx("flex h-8 w-8 flex-none items-center justify-center rounded-lg", KIND_ICON[kind].tone)}>
          {KIND_ICON[kind].icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">{title}</div>
          <div className="truncate text-xs text-muted">
            {KIND_TILES[kind]}
            {impact ? ` · ${IMPACT_LABELS[impact].toLowerCase()}` : ""} · {where}
            {shots ? ` · ${shots} screenshot${shots === 1 ? "" : "s"}` : ""}
          </div>
        </div>
      </div>

      <div className="sticky -bottom-4 z-10 -mx-5 -mb-4 flex flex-wrap items-center gap-2.5 border-t border-divider bg-page px-5 py-3.5">
        <Button variant="secondary" onClick={onAnother}>
          Tell us something else
        </Button>
        <span className="flex-1" />
        <Link
          href={feedbackHomeFor(path, sent.id)}
          onClick={onDone}
          className="inline-flex h-9 items-center rounded-[7px] border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink no-underline hover:bg-canvas hover:no-underline"
        >
          Open Your feedback
        </Link>
        <Button variant="primary" onClick={onDone}>
          Back to work
        </Button>
      </div>
    </div>
  );
}

function RefPill({ children }: { children: React.ReactNode }) {
  return (
    <b className="rounded-[4px] border border-line bg-canvas px-1.5 py-px font-mono text-[13px] font-semibold text-ink">
      {children}
    </b>
  );
}
