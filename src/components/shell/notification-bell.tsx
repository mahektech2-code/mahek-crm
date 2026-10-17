"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "./icons";
import { cx } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { toneOf, type FeedItem } from "@/lib/notification-feed";
import type { Notification } from "@/db/schema";
import { appFor } from "@/lib/app-routes";
import { notificationAppName, notificationAppOf, unreadElsewhere } from "@/lib/notification-apps";
import { SpeakerIcon, readAll, readOne, useNotificationFeed, useNotifyPrefs } from "./notification-center";

/**
 * The bell in an app's header, and the list it opens.
 *
 * It was drawn inline in the CRM's header. The ERP draws the same header, and
 * a second copy of this would be the one that drifts.
 *
 * It is LIVE: the layout's list is only the first paint, and from then on the
 * bell reads `NotificationCenter`'s store, which asks the server every few
 * seconds — so the badge rises while the page is open, and the count is the
 * true unread count rather than the unread among the thirty newest.
 *
 * AND IT IS THIS APP'S BELL. The badge and the first view count only the
 * notifications whose link opens this app, plus the general ones that belong
 * to no app (`lib/notification-apps.ts`). Everything else is one tab away,
 * under "All apps", with a line saying how much is waiting where — so nothing
 * is hidden, and nothing from another app's work rings over this one.
 */
function asFeed(rows: Notification[]): FeedItem[] {
  return rows.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    kind: n.kind,
    href: n.href,
    app: notificationAppOf(n.href, n.mbosHref),
    read: n.read,
    createdAt: new Date(n.createdAt).toISOString(),
  }));
}

type View = "app" | "all";

export function NotificationBell({
  notifications = [],
}: {
  /** The layout's first paint; the live store replaces it within a poll. */
  notifications?: Notification[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const viewApp = pathname ? appFor(pathname) : null;
  const [notifOpen, setNotifOpen] = React.useState(false);
  const [view, setView] = React.useState<View>("app");
  const notifRef = React.useRef<HTMLDivElement>(null);
  const initial = React.useMemo(() => asFeed(notifications), [notifications]);
  const { items, unread, all, byApp } = useNotificationFeed(initial, viewApp);
  const prefs = useNotifyPrefs();
  const elsewhere = unreadElsewhere(byApp, viewApp);
  const elsewhereCount = elsewhere.reduce((t, r) => t + r.unread, 0);
  const totalUnread = byApp.reduce((t, r) => t + r.unread, 0);
  /* Outside every app there is only one view, and it is everything. */
  const showing: View = viewApp === null ? "all" : view;
  const list = showing === "app" ? items : all;
  const appName = viewApp === null ? null : notificationAppName(viewApp);

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

  const label = unread
    ? `Notifications, ${unread} unread${elsewhereCount ? `, ${elsewhereCount} more in other apps` : ""}`
    : elsewhereCount
      ? `Notifications, ${elsewhereCount} unread in other apps`
      : "Notifications";

  return (
    <div ref={notifRef} className="relative">
      <button
        onClick={() => {
          setNotifOpen((o) => !o);
          setView("app");
        }}
        aria-label={label}
        title={label}
        className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-muted hover:bg-canvas hover:text-body"
      >
        <Icon name="bell" size={16} />
        {unread ? (
          <span className="absolute -top-1.5 -right-1.5 h-4 min-w-4 rounded-lg bg-danger px-1 text-[11px] leading-4 font-medium text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : elsewhereCount ? (
          /* Nothing here, something elsewhere: a quiet dot, not a red count —
             the count belongs to this app. */
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full border border-surface bg-muted" />
        ) : null}
      </button>

      {notifOpen ? (
        <div className="animate-fade-in absolute top-9.5 right-0 z-50 w-[400px] rounded-[6px] border border-line bg-surface shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <div className="flex items-center justify-between border-b border-divider px-3.5 py-2.5">
            <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
              Notifications
            </span>
            <button
              onClick={async () => {
                await readAll(showing === "app" ? viewApp : null);
                router.refresh();
              }}
              className="cursor-pointer text-[13px] text-brand"
              title={showing === "app" && appName ? `Marks ${appName}'s notifications and the general ones read` : "Marks every notification read"}
            >
              {showing === "app" ? "Mark all read" : "Mark everything read"}
            </button>
          </div>
          {viewApp !== null ? (
            <div role="tablist" className="flex gap-1 border-b border-divider px-2.5 pt-1.5">
              <ViewTab active={showing === "app"} onClick={() => setView("app")} count={unread}>
                {appName}
              </ViewTab>
              <ViewTab active={showing === "all"} onClick={() => setView("all")} count={totalUnread}>
                All apps
              </ViewTab>
            </div>
          ) : null}
          <div className="max-h-[340px] overflow-y-auto">
            {list.length ? (
              list.map((n) => (
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
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                      {showing === "all" ? (
                        <span className="rounded-[3px] bg-canvas px-1.5 py-px text-body">{notificationAppName(n.app)}</span>
                      ) : null}
                      {stamp(n.createdAt)}
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <div className="px-3.5 py-7 text-center text-[15px] text-muted">
                {showing === "app" && appName ? `Nothing in ${appName} needs your attention.` : "Nothing needs your attention."}
              </div>
            )}
          </div>
          {showing === "app" && elsewhere.length ? (
            <button
              type="button"
              onClick={() => setView("all")}
              className="block w-full cursor-pointer border-t border-divider bg-canvas px-3.5 py-2 text-left text-[13px] text-body hover:text-ink"
            >
              <span className="text-muted">Unread in other apps: </span>
              {elsewhere
                .slice(0, 3)
                .map((r) => `${notificationAppName(r.app)} ${r.unread}`)
                .join(" · ")}
              {elsewhere.length > 3 ? ` · +${elsewhere.length - 3} more` : ""}
              <span className="text-brand"> — see all</span>
            </button>
          ) : null}
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

function ViewTab({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cx(
        "-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 px-2 pb-1.5 text-[13px]",
        active ? "border-brand font-medium text-ink" : "border-transparent text-muted hover:text-body",
      )}
    >
      {children}
      {count ? (
        <span className={cx("rounded-lg px-1.5 text-[11px] leading-4", active ? "bg-brand-soft text-brand" : "bg-canvas text-muted")}>
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );
}
