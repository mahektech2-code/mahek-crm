"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { GlobalSearch } from "./global-search";
import { FeedbackButton } from "./feedback-button";
import { AppSwitcher } from "./app-switcher";
import { cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { setScope } from "@/lib/actions/crm";
import { AccountMenu } from "./account-menu";
import { NotificationBell } from "./notification-bell";
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
  hat,
  isManager,
  scope,
  notifications,
  apps,
  onToggleSidebar,
}: {
  user: User;
  /** Who this person is in THIS app — see `lib/hat-labels.ts`. */
  hat: { label: string; sentence: string };
  isManager: boolean;
  scope: "mine" | "team";
  notifications: Notification[];
  /** Every app this account opens — the switcher lists them. */
  apps: AppDefinition[];
  onToggleSidebar: () => void;
}) {
  const router = useRouter();
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

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
        {isManager ? (
          <div className="flex h-7.5 items-center gap-1.5 rounded-[4px] border border-dashed border-line-strong pr-1 pl-2">
            <span className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
              Viewing
            </span>
            {(["mine", "team"] as const).map((s) => (
              <button
                key={s}
                // Awaited, not fired and forgotten: the cookie is set by the
                // action's response, so a refresh raced against it re-fetches
                // the page with the scope the user has just left.
                onClick={async () => {
                  await setScope(s);
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

        <FeedbackButton />

        <button
          onClick={() => setShortcutsOpen(true)}
          title="Keyboard shortcuts"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-[13px] font-medium text-muted hover:bg-canvas hover:text-body"
        >
          ?
        </button>

        <NotificationBell notifications={notifications} />

        <span className="mx-1 h-6 w-px bg-divider" />

        {/*
          The same chip the sidebar draws on its floor, and it has to be the
          same CONTROL: two identical-looking chips on one screen that behave
          differently is worse than either arrangement on its own. Both were a
          name with a sign-out icon welded to the side of it.
        */}
        <AccountMenu user={user} hat={hat} variant="header" />
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
