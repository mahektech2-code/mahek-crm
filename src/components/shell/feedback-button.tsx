"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import { Modal } from "@/components/ui/modal";
import { cx } from "@/components/ui/primitives";
import { myFeedbackSummary, type FeedbackSummaryItem } from "@/lib/actions/feedback";
import { feedbackHomeFor, type FeedbackKind, type FeedbackStage } from "@/lib/feedback-labels";

/* ---------------------------------------------------------------------------
 * "Feedback" in the header of every app — a menu, and the Tell us dialog.
 *
 * THE MENU, because the button had two jobs and only showed one. Reporting
 * something is the first; finding out what came back is the second, and it
 * used to be a link at the foot of the form, so nobody found it. The button
 * now carries the count of replies the person has not read, and opens on the
 * three ways to start (each opening the form with its kind already chosen) and
 * the last three things they sent, with where each one has got to.
 *
 * THE FORM asks less and captures more. The kind is a tile; a fault is asked
 * how much it is getting in the way; there is ONE box — the first line becomes
 * the heading, so nobody is made to write a summary before they have written
 * the thing. The screen they are on is captured, never asked for, and said in
 * words at the top. A screenshot can be captured, pasted or picked. And while
 * they type, reports that read the same are offered — the second person to hit
 * a fault adds their words to the first report instead of starting a second
 * conversation about it.
 *
 * It carries its own success state rather than a toast: several shells that
 * mount it have no ToastProvider above them, and a thank-you inside the dialog
 * does not vanish after four seconds.
 * ------------------------------------------------------------------------- */


export const KIND_ICON: Record<FeedbackKind, { icon: React.ReactNode; tone: string }> = {
  bug: {
    tone: "bg-danger-soft text-danger",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M12 9v4M12 17h.01" />
        <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
    ),
  },
  suggestion: {
    tone: "bg-warn-soft text-warn-ink",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M9 18h6M10 22h4" />
        <path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
      </svg>
    ),
  },
  feature: {
    tone: "bg-brand-soft text-brand",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M12 5v14M5 12h14" />
      </svg>
    ),
  },
  question: {
    tone: "bg-info-soft text-info",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01" />
      </svg>
    ),
  },
};

/** The pill colours for where a report has got to, shared with the Feedback page. */
export const STAGE_TONE: Record<FeedbackStage, string> = {
  sent: "border border-line bg-canvas text-body",
  seen: "border border-line bg-canvas text-body",
  looking: "bg-brand-soft text-brand-deep",
  done: "bg-success-soft text-success",
  confirmed: "bg-success-soft text-success",
  declined: "bg-canvas text-muted border border-line",
};

const MENU_STARTS: { kind: FeedbackKind; label: string; hint?: string }[] = [
  { kind: "bug", label: "Report a problem", hint: "Opens with this screen attached" },
  { kind: "suggestion", label: "Suggest an idea" },
  { kind: "question", label: "Ask a question" },
];

export function FeedbackButton({
  /** `compact` is the icon alone, for a header already full of controls. */
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const pathname = usePathname();
  const [menu, setMenu] = React.useState(false);
  const [dialog, setDialog] = React.useState<FeedbackKind | null>(null);
  const [summary, setSummary] = React.useState<{
    total: number;
    unreadReplies: number;
    recent: FeedbackSummaryItem[];
  } | null>(null);
  const wrap = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(() => {
    myFeedbackSummary()
      .then((r) => {
        if (r.ok) setSummary(r.data);
      })
      .catch(() => {});
  }, []);

  // Read once per screen, and again when somebody comes back to the tab — the
  // reply count is what makes a reply findable, so it has to be current.
  React.useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load, pathname]);

  React.useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const unread = summary?.unreadReplies ?? 0;
  const home = feedbackHomeFor(pathname);

  return (
    <div ref={wrap} className="relative flex-none">
      <button
        type="button"
        onClick={() => setMenu((m) => !m)}
        title="Report a problem, suggest something, or read the replies"
        aria-label={unread ? `Feedback — ${unread} new repl${unread === 1 ? "y" : "ies"}` : "Feedback"}
        aria-expanded={menu}
        aria-haspopup="menu"
        className={cx(
          "relative flex h-8 cursor-pointer items-center gap-1.5 rounded-[4px] border text-[13px] font-medium",
          menu
            ? "border-brand bg-brand-soft text-brand-deep"
            : "border-line bg-surface text-muted hover:bg-canvas hover:text-body",
          compact ? "w-8 justify-center" : "px-2.5",
          className,
        )}
      >
        <Icon name="chat" size={15} />
        {compact ? null : "Feedback"}
        {unread ? (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-surface bg-danger px-1 text-[10px] leading-none font-bold text-white tabular-nums">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {menu ? (
        <div
          role="menu"
          className="animate-fade-in absolute top-[calc(100%+6px)] right-0 z-50 w-[380px] overflow-hidden rounded-[10px] border border-line bg-surface shadow-pop"
        >
          <div className="px-3.5 pt-3 pb-1 text-xs font-semibold text-muted">Tell us about this screen</div>
          {MENU_STARTS.map((s) => (
            <button
              key={s.kind}
              role="menuitem"
              type="button"
              onClick={() => {
                setMenu(false);
                setDialog(s.kind);
              }}
              className="flex w-full cursor-pointer items-center gap-3 px-3.5 py-2 text-left hover:bg-canvas"
            >
              <span className={cx("flex h-8 w-8 flex-none items-center justify-center rounded-lg", KIND_ICON[s.kind].tone)}>
                {KIND_ICON[s.kind].icon}
              </span>
              <span className="min-w-0 leading-[18px]">
                <span className="block text-sm font-medium text-ink">{s.label}</span>
                {s.hint ? <span className="block text-xs text-muted">{s.hint}</span> : null}
              </span>
            </button>
          ))}

          <div className="my-1.5 h-px bg-divider" />
          <div className="flex items-center px-3.5 pt-1 pb-1">
            <span className="flex-1 text-xs font-semibold text-muted">What you&apos;ve sent</span>
            <Link href={home} onClick={() => setMenu(false)} className="text-xs font-medium text-brand">
              {summary?.total ? `See all ${summary.total}` : "Your feedback"}
            </Link>
          </div>
          {summary?.recent.length ? (
            summary.recent.map((r) => (
              <Link
                key={r.id}
                href={feedbackHomeFor(pathname, r.id)}
                onClick={() => setMenu(false)}
                role="menuitem"
                className="flex w-full items-start gap-2.5 px-3.5 py-2 no-underline hover:bg-canvas hover:no-underline"
              >
                <span
                  className={cx("mt-1.5 h-2 w-2 flex-none rounded-full", r.unread ? "bg-brand" : "bg-transparent")}
                  aria-label={r.unread ? "New reply" : undefined}
                />
                <span className="min-w-0 flex-1 leading-[18px]">
                  <span className={cx("block text-sm text-ink", r.unread ? "font-semibold" : "font-medium")}>
                    {r.title}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {r.ref}
                    {r.lastLine ? ` · ${r.lastLine.who}: ${r.lastLine.text}` : ""}
                  </span>
                </span>
                <span className={cx("mt-0.5 flex-none rounded-full px-2 py-px text-[11px] font-semibold whitespace-nowrap", STAGE_TONE[r.stage])}>
                  {r.stageLabel}
                </span>
              </Link>
            ))
          ) : (
            <div className="px-3.5 pt-1 pb-3 text-[13px] text-muted">
              Nothing sent yet. Whatever you send shows here, with the reply.
            </div>
          )}
          <div className="h-1.5" />
        </div>
      ) : null}

      {/* The form is a child of the modal, so closing unmounts it and the next
          visit starts blank — state reset by remounting, never by an effect. */}
      <TellUsDialog
        open={dialog !== null}
        initialKind={dialog ?? "bug"}
        onClose={() => {
          setDialog(null);
          load();
        }}
      />
    </div>
  );
}

/** The Tell us dialog on its own — the Feedback page opens it from its own button. */
export function TellUsDialog({
  open,
  onClose,
  initialKind = "bug",
}: {
  open: boolean;
  onClose: () => void;
  initialKind?: FeedbackKind;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Tell us" width={680} footer={null}>
      {open ? (
        <React.Suspense fallback={<div className="py-10 text-center text-[13px] text-muted">Opening…</div>}>
          <TellUsForm key={initialKind} initialKind={initialKind} onDone={onClose} />
        </React.Suspense>
      ) : null}
    </Modal>
  );
}

/* THE FORM IS FETCHED WHEN THE DIALOG OPENS. It is most of this feature — the
   form, screenshot capture, the dictation box and its modal — and it was in
   every page's first download for a button pressed a few times a week. */
const TellUsForm = React.lazy(() => import("./tell-us-form").then((m) => ({ default: m.TellUsForm })));
