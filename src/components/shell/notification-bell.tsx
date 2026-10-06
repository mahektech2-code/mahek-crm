"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { cx } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { toneOf, type FeedItem } from "@/lib/notification-feed";
import type { Notification } from "@/db/schema";
import { SpeakerIcon, readAll, readOne, useNotificationFeed, useNotifyPrefs } from "./notification-center";

/**
 * The bell in an app's header, and the list it opens.
 *
 * It was drawn inline in the CRM's header. The ERP draws the same header, and
 * a second copy of this would be the one that drifts — notifications are
 * per person, not per app, so both bells read one list.
 *
 * It is LIVE now: the layout's list is only the first paint, and from then on
 * the bell reads `NotificationCenter`'s store, which asks the server every few
 * seconds — so the badge rises while the page is open, and the count is the
 * true unread count rather than the unread among the thirty newest.
 */
function asFeed(rows: Notification[]): FeedItem[] {
  return rows.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    kind: n.kind,
    href: n.href,
    read: n.read,
    createdAt: new Date(n.createdAt).toISOString(),
  }));
}

export function NotificationBell({
  notifications,
}: {
  notifications: Notification[];
}) {
  const router = useRouter();
  const [notifOpen, setNotifOpen] = React.useState(false);
  const notifRef = React.useRef<HTMLDivElement>(null);
  const initial = React.useMemo(() => asFeed(notifications), [notifications]);
  const { items, unread } = useNotificationFeed(initial);
  const prefs = useNotifyPrefs();

  React.useEffect(() => {
    if (!notifOpen) return;
    const handler = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [notifOpen]);

  return (
    <div ref={notifRef} className="relative">
      <button
        onClick={() => setNotifOpen((o) => !o)}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-muted hover:bg-canvas hover:text-body"
      >
        <Icon name="bell" size={16} />
        {unread ? (
          <span className="absolute -top-1.5 -right-1.5 h-4 min-w-4 rounded-lg bg-danger px-1 text-[11px] leading-4 font-medium text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {notifOpen ? (
        <div className="animate-fade-in absolute top-9.5 right-0 z-50 w-[380px] rounded-[6px] border border-line bg-surface shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <div className="flex items-center justify-between border-b border-divider px-3.5 py-2.5">
            <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
              Notifications
            </span>
            <button
              onClick={async () => {
                await readAll();
                router.refresh();
              }}
              className="cursor-pointer text-[13px] text-brand"
            >
              Mark all read
            </button>
          </div>
          <div className="max-h-[340px] overflow-y-auto">
            {items.length ? (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={async () => {
                    await readOne(n.id);
                    setNotifOpen(false);
                    if (n.href) router.push(n.href);
                    else router.refresh();
                  }}
                  className="flex w-full cursor-pointer items-start gap-2.5 border-b border-divider px-3.5 py-2.5 text-left last:border-0 hover:bg-canvas"
                >
                  <span
                    className={cx(
                      "mt-1.5 block h-1.5 w-1.5 flex-none rounded-full",
                      n.read
                        ? "bg-transparent"
                        : toneOf(n.kind) === "warn"
                          ? "bg-warn"
                          : toneOf(n.kind) === "danger"
                            ? "bg-danger"
                            : toneOf(n.kind) === "success"
                              ? "bg-success"
                              : "bg-brand",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cx(
                        "block text-sm",
                        n.read ? "text-body" : "font-medium text-ink",
                      )}
                    >
                      {n.title}
                    </span>
                    <span className="mt-0.5 block text-[13px] text-muted">
                      {n.body}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {stamp(n.createdAt)}
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <div className="px-3.5 py-7 text-center text-[15px] text-muted">
                Nothing needs your attention.
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-divider px-3.5 py-2 text-[13px]">
            <button
              type="button"
              onClick={() => prefs.setSound(!prefs.sound)}
              className="flex cursor-pointer items-center gap-1.5 text-muted hover:text-body"
              title={prefs.sound ? "A chime plays when a notification arrives" : "Notifications arrive silently"}
            >
              <SpeakerIcon on={prefs.sound} />
              Sound {prefs.sound ? "on" : "off"}
            </button>
            {prefs.permission === "unsupported" ? null : prefs.permission === "denied" ? (
              <span className="text-muted" title="Allow notifications for this site in the browser's settings to turn these on">
                Desktop alerts blocked by the browser
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void prefs.setDesktop(!prefs.desktop)}
                className="cursor-pointer text-muted hover:text-body"
                title="Shows a notification on your computer when MahekOne is in another tab"
              >
                {prefs.desktop ? "Desktop alerts on" : "Turn on desktop alerts"}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
