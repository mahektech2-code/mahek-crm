"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { SmartSearch } from "./smart-search";
import { AskPanel } from "./ask-panel";
import { CRM_ASK } from "./ask-setups";
import { FeedbackButton } from "./feedback-button";
import { HeaderLead } from "./header-lead";
import { cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { setScope } from "@/lib/actions/crm";
import { AccountMenu } from "./account-menu";
import { NotificationBell } from "./notification-bell";
import type { Notification, User } from "@/db/schema";
import type { AppDefinition } from "@/lib/apps";

const SHORTCUTS = [
  { what: "Focus search — type a name, or ask a question", key: "/" },
  { what: "Move through search results", key: "↑ · ↓" },
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
  collapsed,
  onToggleSidebar,
  v4 = false,
}: {
  user: User;
  /** Who this person is in THIS app — see `lib/hat-labels.ts`. */
  hat: { label: string; sentence: string };
  isManager: boolean;
  scope: "mine" | "team";
  notifications: Notification[];
  /** Every app this account opens — the switcher lists them. */
  apps: AppDefinition[];
  /** Whether the sidebar is the narrow rail — the collapse control says which. */
  collapsed: boolean;
  onToggleSidebar: () => void;
  /** The v4 look (`styles/v4-theme.css`): a lavender header. The CRM asks
   *  for it; Accounts, which shares this header, does not. */
  v4?: boolean;
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
    <header
      data-v4-header={v4 ? "" : undefined}
      className={cx(
        "z-30 flex h-14 flex-none items-center gap-5 border-b px-4",
        v4 ? "border-brand-softer bg-brand-soft" : "border-line bg-surface",
      )}
    >
      {/* The switcher, the collapse and the wordmark are `HeaderLead`'s, as in
          every app. The fixed width keeps the search box where it was. In v4
          the wordmark is the Mahek mark atop the sidebar, as in the ERP. */}
      <div className={cx("flex flex-none items-center", !v4 && "w-[216px]")}>
        <HeaderLead
          apps={apps}
          current="crm"
          collapsed={collapsed}
          onToggleSidebar={onToggleSidebar}
          href="/crm/dashboard"
          label="MAHEK CRM"
          wordmark={!v4}
          toggleIcon={
            v4 ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 5h16v14H4zM9 5v14" />
              </svg>
            ) : undefined
          }
        />
      </div>

      {/* The ERP's header: one box that finds a customer, a lead, a bill, an
          order, a complaint or a screen — or, typed as a question, asks the
          CRM and opens the answer in the Ask AI drawer. */}
      <SmartSearch
        endpoint="/api/crm/search"
        placeholder="Search customers, leads, bills, orders — or ask a question"
        ask={CRM_ASK.title}
      />

      <div className="flex-1" />

      <div className="flex items-center gap-2">
        {isManager ? (
          <div
            role="group"
            aria-label="Viewing"
            className={cx(
              "flex h-7.5 items-center gap-1.5 rounded-[4px] border pr-1",
              v4 ? "border-brand-softer pl-1" : "border-dashed border-line-strong pl-2",
            )}
          >
            {/* v4 says it in two words, not three: the pair is the label. */}
            {v4 ? null : (
              <span className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
                Viewing
              </span>
            )}
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
                    ? v4
                      ? "bg-surface font-semibold text-[#1e1446]"
                      : "bg-brand-soft font-medium text-[#5223E0]"
                    : "text-muted hover:text-body",
                )}
              >
                {s === "mine" ? "My book" : "Team"}
              </button>
            ))}
          </div>
        ) : null}

        <AskPanel setup={CRM_ASK} />

        <FeedbackButton />

        <button
          onClick={() => setShortcutsOpen(true)}
          title="Keyboard shortcuts"
          aria-label="Keyboard shortcuts"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-[13px] font-medium text-muted hover:bg-canvas hover:text-body"
        >
          ?
        </button>

        <NotificationBell notifications={notifications} />

        {v4 ? null : <span className="mx-1 h-6 w-px bg-divider" />}

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
