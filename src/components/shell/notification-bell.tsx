"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { cx } from "@/components/ui/primitives";
import { markNotificationsRead, markNotificationRead } from "@/lib/actions/crm";
import { stamp } from "@/lib/format";
import type { Notification } from "@/db/schema";

/**
 * The bell in an app's header, and the list it opens.
 *
 * It was drawn inline in the CRM's header. The ERP draws the same header, and
 * a second copy of this would be the one that drifts — notifications are
 * per person, not per app, so both bells read one list.
 */
export function NotificationBell({
  notifications,
}: {
  notifications: Notification[];
}) {
  const router = useRouter();
  const [notifOpen, setNotifOpen] = React.useState(false);
  const notifRef = React.useRef<HTMLDivElement>(null);
  const unread = notifications.filter((n) => !n.read).length;

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
        aria-label="Notifications"
        className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-muted hover:bg-canvas hover:text-body"
      >
        <Icon name="bell" size={16} />
        {unread ? (
          <span className="absolute -top-1.5 -right-1.5 h-4 min-w-4 rounded-lg bg-danger px-1 text-[11px] leading-4 font-medium text-white">
            {unread}
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
                await markNotificationsRead();
                router.refresh();
              }}
              className="cursor-pointer text-[13px] text-brand"
            >
              Mark all read
            </button>
          </div>
          <div className="max-h-[340px] overflow-y-auto">
            {notifications.length ? (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={async () => {
                    await markNotificationRead(n.id);
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
                        : n.kind === "warn"
                          ? "bg-warn"
                          : n.kind === "danger"
                            ? "bg-danger"
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
        </div>
      ) : null}
    </div>
  );
}
