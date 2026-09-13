"use client";

import * as React from "react";
import { Icon } from "./icons";
import { cx } from "@/components/ui/primitives";
import { signOut } from "@/lib/actions/auth";
import { ChangePasswordDialog } from "./change-password-dialog";

/**
 * My account: the chip that was a label, made into a menu.
 *
 * IT REPLACES A BARE SIGN-OUT ICON, and that icon was the whole of what an
 * account could do to itself. Everything else about a person — their apps,
 * their level, their password — was somebody else's screen in the Admin
 * Console, which meant the one thing a person genuinely owns took a phone call
 * to a manager to change. `/login/forgot` existed and is the wrong door for
 * somebody already signed in: it mails a link to an inbox to prove an identity
 * the session has already proved.
 *
 * ONE COMPONENT IN TWO SHAPES, like `navigate.tsx` on the handset. The sidebar
 * chip is a full-width row that opens upward because it sits on the floor of
 * the sidebar; a header chip is compact and opens down. Two components would
 * be two answers to "what is on my account menu", and the half that drifts is
 * always the half somebody is looking at.
 *
 * @param variant  where the chip is drawn: the sidebar's floor, or a header.
 * @param collapsed  sidebar only — the rail with no room for a name. The
 *   avatar is the trigger there, which is also the first time a collapsed
 *   sidebar has offered sign-out at all: it used to draw the chip and hide
 *   every control on it.
 */
export function AccountMenu({
  user,
  variant,
  collapsed = false,
}: {
  user: {
    name: string;
    /*
     * BOTH, and both are DRAWN where both exist. Either one is a way in —
     * `/login` takes a work number or an email, because telecallers know
     * their phone and office staff know their email — so showing one of them
     * answers "is this my account" for half the company and leaves the other
     * half looking at a detail they never type. Neither is nullable in
     * practice for a working account and both are in the schema, so the menu
     * prints what is there and says nothing where there is nothing.
     */
    email: string | null;
    phone: string | null;
    initials: string;
    role: string;
  };
  variant: "sidebar" | "header";
  collapsed?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  /*
   * Counted rather than a boolean, so each opening REMOUNTS the dialog with
   * fresh state — a `key`, which is how everything in this app resets a form
   * rather than clearing it in an effect. Without it the second visit opens
   * on the first visit's error, or on "Password changed" from ten minutes ago.
   */
  const [changing, setChanging] = React.useState(0);
  const boxRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const avatar = (
    <span className="flex h-7.5 w-7.5 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-[#5223E0]">
      {user.initials}
    </span>
  );

  const identity = (
    <span className="min-w-0 flex-1 text-left">
      <span className="block truncate text-[13px] leading-4 font-medium text-ink">
        {user.name}
      </span>
      <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {user.role}
      </span>
    </span>
  );

  return (
    <div ref={boxRef} className={cx("relative flex-none", variant === "sidebar" && "w-full")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="My account"
        aria-label="My account"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cx(
          "flex cursor-pointer items-center rounded-[4px] hover:bg-canvas",
          open && "bg-canvas",
          variant === "sidebar"
            ? collapsed
              ? "justify-center p-1"
              : "w-full gap-2.5 px-1 py-1"
            : "gap-2.5 px-1.5 py-1",
        )}
      >
        {avatar}
        {collapsed ? null : (
          <>
            {identity}
            <Icon
              name="chevron"
              size={14}
              className={cx(
                "flex-none text-muted transition-transform duration-100",
                variant === "sidebar"
                  ? open
                    ? "rotate-90"
                    : "-rotate-90"
                  : open
                    ? "-rotate-90"
                    : "rotate-90",
              )}
            />
          </>
        )}
      </button>

      {open ? (
        <div
          role="menu"
          className={cx(
            "animate-fade-in absolute z-50 w-[236px] rounded-[6px] border border-line bg-surface shadow-[0_4px_16px_rgba(22,22,22,0.10)]",
            variant === "sidebar"
              ? "bottom-full left-0 mb-1.5"
              : "top-full right-0 mt-1.5",
          )}
        >
          {/*
            WHICH ACCOUNT THIS IS, said in the one place it is unambiguous.
            A shared machine on the sales floor is signed in as whoever used it
            last, and initials in a corner are not an answer to "is this me" —
            what they typed to get in is. Both ways in are listed, because
            which one a person recognises depends on which one they use.
          */}
          <div className="border-b border-divider px-3.5 py-2.5">
            <div className="truncate text-[13px] font-medium text-ink">
              {user.name}
            </div>
            {user.email ? (
              <div className="truncate text-[12px] text-muted">{user.email}</div>
            ) : null}
            {user.phone ? (
              <div className="truncate text-[12px] text-muted">{user.phone}</div>
            ) : null}
          </div>

          <div className="py-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setChanging((n) => n + 1);
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left text-sm text-body hover:bg-canvas hover:text-ink"
            >
              <Icon name="lock" size={16} className="flex-none text-muted" />
              Change password
            </button>

            <form action={signOut}>
              <button
                type="submit"
                role="menuitem"
                title="Ends your session on this device"
                className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left text-sm text-body hover:bg-canvas hover:text-ink"
              >
                <Icon name="signOut" size={16} className="flex-none text-muted" />
                Sign out
              </button>
            </form>
          </div>
        </div>
      ) : null}

      {/*
        Mounted outside the menu, which closes the moment the item is clicked:
        a dialog rendered inside it would be unmounted by its own trigger.
      */}
      {changing ? (
        <ChangePasswordDialog
          key={changing}
          onClose={() => setChanging(0)}
        />
      ) : null}
    </div>
  );
}
