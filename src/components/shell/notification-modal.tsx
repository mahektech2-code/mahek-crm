"use client";

import * as React from "react";
import { ago, clampIndex, SNOOZE_CHOICES, toneOf, type FeedItem, type NotifyTone, type SnoozeCode } from "@/lib/notification-feed";
import { Modal } from "@/components/ui/modal";
import { Button, cx } from "@/components/ui/primitives";
import { Icon } from "./icons";

/* ---------------------------------------------------------------------------
 * THE NOTIFICATION POP-UP, in every app: one at a time, and it has to be answered.
 *
 * It started in the ERP and is now how every web app tells somebody something.
 * Several waiting is "Notification 1 of 4", and the arrows step through them
 * without answering any — somebody looking for the urgent one should not have
 * to snooze three others to reach it.
 *
 * Each one is answered on its own:
 *   - Take action now marks it done and goes to the page it names;
 *   - Mark as done marks it done and stays put;
 *   - Remind me puts it away for the time picked, and it comes back.
 * Until one of those, it stays in the stack — across a reload, a closed tab or
 * another machine (`answerNotifications(…, "shown")` makes it due on the server
 * the moment it is first shown).
 *
 * Escape and a click outside are "remind me in 30 minutes", not done: a stray
 * click must not be what loses something somebody was asked to do.
 *
 * IT WAITS FOR YOU TO FINISH. It does not open over a dialog that is already
 * open or while the cursor is in a field, because it would take the focus out of
 * what somebody is typing and offer a button that leaves the page.
 * ------------------------------------------------------------------------- */

export const TONE_STYLE: Record<NotifyTone, { bar: string; chip: string; label: string }> = {
  info: { bar: "bg-brand", chip: "bg-brand-soft text-brand", label: "Notification" },
  success: { bar: "bg-success", chip: "bg-success-soft text-success", label: "Good news" },
  warn: { bar: "bg-warn", chip: "bg-warn-soft text-warn-ink", label: "Needs a look" },
  danger: { bar: "bg-danger", chip: "bg-danger-soft text-danger", label: "Needs you" },
};

function typing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

/** Something on the page is mid-way: another dialog is open, or somebody is typing. */
function busy(): boolean {
  return Boolean(document.querySelector('[role="dialog"], [aria-modal="true"]')) || typing();
}

const STEP =
  "flex h-6 w-6 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent";

export function NotificationModal({
  queue,
  onAct,
  onRead,
  onLater,
}: {
  queue: FeedItem[];
  onAct: (n: FeedItem) => void;
  onRead: (items: FeedItem[]) => void;
  onLater: (items: FeedItem[], snooze: SnoozeCode) => void;
}) {
  const [ready, setReady] = React.useState(false);
  const [nowMs, setNowMs] = React.useState<number | null>(null);
  /* Which one is showing, by id, so an arrival joining the stack never swaps the
     card somebody is reading. When that one is answered, the card that slides
     into its position (`lastIndex`) is the next one along. */
  const [currentId, setCurrentId] = React.useState<string | null>(null);
  const [lastIndex, setLastIndex] = React.useState(0);

  /* Once it is showing it stays: its own dialog would otherwise count as busy. */
  React.useEffect(() => {
    if (ready) return;
    const check = () => {
      if (!busy()) setReady(true);
    };
    check();
    const t = setInterval(check, 1500);
    return () => clearInterval(t);
  }, [ready]);

  React.useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);

  const found = currentId === null ? -1 : queue.findIndex((x) => x.id === currentId);
  const index = found >= 0 ? found : clampIndex(lastIndex, queue.length);
  const n = queue[index];
  const total = queue.length;

  const go = React.useCallback(
    (to: number) => {
      const i = clampIndex(to, total);
      setLastIndex(i);
      setCurrentId(queue[i]?.id ?? null);
    },
    [queue, total],
  );

  /* ← and → step through the stack, as long as nobody is typing. */
  React.useEffect(() => {
    if (!ready || total < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing()) return;
      if (e.key === "ArrowRight") go(index + 1);
      else if (e.key === "ArrowLeft") go(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, total, index, go]);

  if (!ready || !n) return null;

  const tone = toneOf(n.kind);
  const style = TONE_STYLE[tone];
  /* The card on screen is being answered: whatever is next takes its position. */
  const answer = (fn: () => void) => () => {
    setCurrentId(null);
    setLastIndex(index);
    fn();
  };
  const done = answer(() => onRead([n]));

  return (
    <Modal
      open
      width={500}
      onClose={answer(() => onLater([n], "30m"))}
      title={
        <span className="flex items-center gap-3">
          <span className={cx("flex h-8 w-8 flex-none items-center justify-center rounded-full", style.chip)}>
            <Icon name={tone === "danger" || tone === "warn" ? "alert" : "bell"} size={16} />
          </span>
          <span className="min-w-0 flex-1">{n.title}</span>
        </span>
      }
      footer={
        n.href ? (
          <>
            <Button variant="ghost" onClick={done}>
              Mark as done
            </Button>
            <Button variant="primary" onClick={answer(() => onAct(n))} autoFocus>
              {tone === "success" ? "Open" : "Take action now"}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={done} autoFocus>
            Mark as done
          </Button>
        )
      }
    >
      <div className="flex items-center gap-2">
        <span className={cx("rounded-[3px] px-1.5 py-px text-[11px] font-medium", style.chip)}>{style.label}</span>
        <span className="text-[11px] text-muted">{nowMs === null ? "" : ago(n.createdAt, nowMs)}</span>
        {total > 1 ? (
          <span className="ml-auto flex items-center gap-1">
            <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous notification" className={STEP}>
              <Icon name="chevronLeft" size={14} />
            </button>
            <span className="text-[12px] font-medium text-body tabular-nums" aria-live="polite">
              Notification {index + 1} of {total}
            </span>
            <button type="button" onClick={() => go(index + 1)} disabled={index === total - 1} aria-label="Next notification" className={STEP}>
              <Icon name="chevron" size={14} />
            </button>
          </span>
        ) : null}
      </div>
      {n.body ? <p className="mt-2 text-sm whitespace-pre-line text-body">{n.body}</p> : null}

      <div className="mt-4">
        <p className="text-[12px] font-medium text-muted">Remind me</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {SNOOZE_CHOICES.map((c) => (
            <button
              key={c.code}
              type="button"
              onClick={answer(() => onLater([n], c.code))}
              className="cursor-pointer rounded-control border border-line bg-surface px-2.5 py-1 text-[13px] text-body hover:border-line-strong hover:bg-canvas"
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {total > 1 ? (
        <div className="mt-4 border-t border-divider pt-3 text-[13px] text-muted">
          <p>{total - 1} more waiting. Each stays here until you take action, mark it done or ask to be reminded.</p>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            <button type="button" onClick={() => onLater(queue, "30m")} className="cursor-pointer font-medium text-brand hover:underline">
              Remind me about all {total} in 30 minutes
            </button>
            <button type="button" onClick={() => onRead(queue)} className="cursor-pointer hover:text-body">
              Mark all {total} as done
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
