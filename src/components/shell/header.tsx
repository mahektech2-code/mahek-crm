"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { GlobalSearch } from "./global-search";
import { AppSwitcher } from "./app-switcher";
import { cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { setDensity, setScope, markNotificationsRead, markNotificationRead } from "@/lib/actions/crm";
import { signOut } from "@/lib/actions/auth";
import { stamp } from "@/lib/format";
import type { Notification, User } from "@/db/schema";
import type { AppDefinition } from "@/lib/apps";

const SHORTCUTS = [
  { what: "Focus global search", key: "/" },
  { what: "Move down / up the queue", key: "j · k" },
  { what: "Open the call panel for the selected row", key: "Enter" },
  { what: "Save the call and open the next customer", key: "Ctrl + Enter" },
  { what: "Close drawer or dialog", key: "Esc" },
  { what: "Show this list", key: "?" },
];

export function Header({
  user,
  isManager,
  scope,
  density,
  notifications,
  apps,
  onToggleSidebar,
}: {
  user: User;
  isManager: boolean;
  scope: "mine" | "team";
  density: "comfortable" | "compact";
  notifications: Notification[];
  /** Every app this account opens — the switcher lists them. */
  apps: AppDefinition[];
  onToggleSidebar: () => void;
}) {
  const router = useRouter();
  const [notifOpen, setNotifOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const notifRef = React.useRef<HTMLDivElement>(null);

  const unread = notifications.filter((n) => !n.read).length;

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (e.key === "?" && !typing) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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

  function toggleDensity() {
    const next = density === "comfortable" ? "compact" : "comfortable";
    document.documentElement.dataset.density = next;
    void setDensity(next);
    router.refresh();
  }

  return (
    <header className="z-30 flex h-14 flex-none items-center gap-5 border-b border-line bg-surface px-4">
      <div className="flex w-[216px] flex-none items-center gap-2">
        {apps.length > 1 ? <AppSwitcher apps={apps} current="crm" /> : null}
        <button
          onClick={onToggleSidebar}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
        >
          <Icon name="menu" size={18} />
        </button>
        <Link href="/crm/dashboard" className="flex items-center gap-2 no-underline hover:no-underline">
          <span className="flex h-4 w-4 flex-none items-center justify-center rounded-[3px] bg-brand">
            <span className="block h-1.5 w-1.5 rounded-[1px] bg-brand-lime" />
          </span>
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
            MAHEK CRM
          </span>
        </Link>
      </div>

      <GlobalSearch />

      <div className="flex-1" />

      <div className="flex items-center gap-2">
        <button
          onClick={toggleDensity}
          className="inline-flex h-7.5 cursor-pointer items-center gap-1.5 rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-body hover:bg-canvas"
        >
          <Icon name="menu" size={16} />
          {density === "comfortable" ? "Comfortable" : "Compact"}
        </button>

        {isManager ? (
          <div className="flex h-7.5 items-center gap-1.5 rounded-[4px] border border-dashed border-line-strong pr-1 pl-2">
            <span className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
              Viewing
            </span>
            {(["mine", "team"] as const).map((s) => (
              <button
                key={s}
                onClick={() => {
                  void setScope(s);
                  router.refresh();
                }}
                className={cx(
                  "h-6 cursor-pointer rounded-[3px] px-2 text-[13px]",
                  scope === s
                    ? "bg-brand-soft font-medium text-[#5223E0]"
                    : "text-muted hover:text-body",
                )}
              >
                {s === "mine" ? "My book" : "Team"}
              </button>
            ))}
          </div>
        ) : null}

        <button
          onClick={() => setShortcutsOpen(true)}
          title="Keyboard shortcuts"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-[13px] font-medium text-muted hover:bg-canvas hover:text-body"
        >
          ?
        </button>

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

        <span className="mx-1 h-6 w-px bg-divider" />

        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-[#5223E0]">
            {user.initials}
          </span>
          <span className="leading-[14px]">
            <span className="block text-[13px] font-medium text-ink">
              {user.name}
            </span>
            <span className="block text-[11px] text-muted capitalize">
              {user.role}
            </span>
          </span>
          <form action={signOut}>
            <button
              type="submit"
              title="Sign out"
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
            >
              <Icon name="signOut" size={16} />
            </button>
          </form>
        </div>
      </div>

      <Modal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        title="Keyboard shortcuts"
        width={460}
      >
        <div className="flex flex-col">
          {SHORTCUTS.map((s) => (
            <div
              key={s.what}
              className="flex items-center justify-between border-b border-divider py-2.5 last:border-0"
            >
              <span className="text-sm text-body">{s.what}</span>
              <kbd className="rounded-[4px] border border-line bg-canvas px-2 py-0.5 font-mono text-xs text-body">
                {s.key}
              </kbd>
            </div>
          ))}
        </div>
      </Modal>
    </header>
  );
}
