"use client";

import * as React from "react";
import { ago, REMIND_AFTER_MINUTES, toneOf, type FeedItem, type NotifyTone } from "@/lib/notification-feed";
import { Modal } from "@/components/ui/modal";
import { Button, cx } from "@/components/ui/primitives";
import { Icon } from "./icons";

/* ---------------------------------------------------------------------------
 * THE ERP'S NOTIFICATION POP-UP: one at a time, and it has to be answered.
 *
 * Take action marks it read and goes to the page it names. Remind me brings it
 * back in half an hour. Dismiss marks it read and stays put. A batch has the same
 * answers for all of it, because a person can be sent fifty in a day and the
 * stock alerts arrive in groups.
 *
 * Escape and a click outside are Remind me, not Dismiss: a stray click must not
 * be what loses something somebody was asked to do.
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

/** Something on the page is mid-way: another dialog is open, or somebody is typing. */
function busy(): boolean {
  if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return true;
  const el = document.activeElement;
  return el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

export function NotificationModal({
  queue,
  onAct,
  onRead,
  onLater,
}: {
  queue: FeedItem[];
  onAct: (n: FeedItem) => void;
  onRead: (items: FeedItem[]) => void;
  onLater: (items: FeedItem[]) => void;
}) {
  const [ready, setReady] = React.useState(false);
  const [nowMs, setNowMs] = React.useState<number | null>(null);

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

  const n = queue[0];
  if (!ready || !n) return null;

  const tone = toneOf(n.kind);
  const style = TONE_STYLE[tone];
  const others = queue.length - 1;
  const later = `Remind me in ${REMIND_AFTER_MINUTES} minutes`;

  return (
    <Modal
      open
      width={480}
      onClose={() => (n.href ? onLater([n]) : onRead([n]))}
      title={
        <span className="flex items-center gap-3">
          <span className={cx("flex h-8 w-8 flex-none items-center justify-center rounded-full", style.chip)}>
            <Icon name={tone === "danger" || tone === "warn" ? "alert" : "bell"} size={16} />
          </span>
          <span className="min-w-0 flex-1">{n.title}</span>
          {others > 0 ? <span className="flex-none text-sm font-normal text-muted">1 of {queue.length}</span> : null}
        </span>
      }
      footer={
        n.href ? (
          <>
            <Button variant="ghost" onClick={() => onRead([n])}>
              Dismiss
            </Button>
            <Button onClick={() => onLater([n])}>{later}</Button>
            <Button variant="primary" onClick={() => onAct(n)} autoFocus>
              {tone === "success" ? "Open" : "Take action now"}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => onRead([n])} autoFocus>
            Got it
          </Button>
        )
      }
    >
      <div className="flex items-center gap-2">
        <span className={cx("rounded-[3px] px-1.5 py-px text-[11px] font-medium", style.chip)}>{style.label}</span>
        <span className="text-[11px] text-muted">{nowMs === null ? "" : ago(n.createdAt, nowMs)}</span>
      </div>
      {n.body ? <p className="mt-2 text-sm whitespace-pre-line text-body">{n.body}</p> : null}
      {others > 0 ? (
        <div className="mt-4 border-t border-divider pt-3 text-[13px] text-muted">
          <p>{n.href && tone !== "success" ? `Take action now and the other ${others} come back in ${REMIND_AFTER_MINUTES} minutes.` : `${others} more after this one.`}</p>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            <button type="button" onClick={() => onLater(queue)} className="cursor-pointer font-medium text-brand hover:underline">
              Remind me about all {queue.length}
            </button>
            <button type="button" onClick={() => onRead(queue)} className="cursor-pointer hover:text-body">
              Dismiss all {queue.length}
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
