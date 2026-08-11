"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Button, cx } from "./primitives";
import { DictateButton, joinDictation } from "./dictate";
import { Modal, useEscape } from "./modal";

/*
 * Both moved to `modal.tsx` so that `dictate.tsx` — which the confirm dialog
 * below now uses — can open one without the two files importing each other.
 * Re-exported here because half the app imports them from this path.
 */
export { Modal, useEscape };

/* ---------------------------------------------------------------- drawer */

export function Drawer({
  open,
  onClose,
  children,
  width = 520,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  label?: string;
}) {
  useEscape(onClose);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-label={label}>
      <div onClick={onClose} className="flex-1 bg-[rgba(22,22,22,0.2)]" />
      <div
        style={{ width }}
        className="animate-drawer-in flex flex-col bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
      >
        {children}
      </div>
    </div>
  );
}

export function DrawerHeader({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-none items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0">{children}</div>
      <button
        onClick={onClose}
        aria-label="Close"
        className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}

/* --------------------------------------------------------------- confirm */

type ConfirmProps = {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  /**
   * The way out. "Cancel" is right for an action somebody started and can
   * abandon; where the choice is between two outcomes — keep it or remove it —
   * naming the other outcome is clearer than naming the escape.
   */
  cancelLabel?: string;
  destructive?: boolean;
  needsReason?: boolean;
  reasonLabel?: string;
  onConfirm: (reason: string) => void | Promise<void>;
  onClose: () => void;
};

/**
 * Mounts fresh each time it opens, so the reason box is never pre-filled with
 * the last thing somebody typed about a different customer.
 */
export function ConfirmDialog(props: ConfirmProps) {
  if (!props.open) return null;
  return <ConfirmDialogBody {...props} />;
}

function ConfirmDialogBody({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive,
  needsReason,
  reasonLabel = "Reason",
  onConfirm,
  onClose,
}: ConfirmProps) {
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function confirm() {
    if (needsReason && !reason.trim()) {
      setError("A reason is required - it is recorded against the customer.");
      return;
    }
    setBusy(true);
    try {
      await onConfirm(reason.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose} variant="secondary">
            {cancelLabel}
          </Button>
          <Button
            onClick={confirm}
            disabled={busy}
            variant={destructive ? "danger" : "primary"}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-body">{body}</div>
      {needsReason ? (
        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
            {reasonLabel} · required
          </span>
          <span className="relative block">
            <textarea
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setError(null);
              }}
              className={cx(
                "h-16 w-full resize-y rounded-[4px] border bg-surface px-2.5 py-2 pr-9 text-sm outline-none focus:border-brand",
                error ? "border-danger" : "border-line",
              )}
            />
            <DictateButton
              hasExistingText={reason.trim().length > 0}
              onImport={(text, replace) => {
                setReason(replace ? text : joinDictation(reason, text));
                setError(null);
              }}
              className="absolute right-2 bottom-3"
            />
          </span>
          {error ? (
            <span className="mt-1 block text-[13px] text-danger">{error}</span>
          ) : null}
        </label>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------- row menus */

export type MenuItem = {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  title?: string;
};

/** Menu width, in px. Named because the placing maths needs the number. */
const ROW_MENU_WIDTH = 224;
/** Kept clear of the viewport edge, so the menu never touches the glass. */
const VIEWPORT_MARGIN = 8;

/**
 * The row's ⋯ menu.
 *
 * IT IS RENDERED INTO `document.body`, NOT BESIDE THE BUTTON. Every table in
 * this app sits inside a Card carrying `overflow-auto`, because a wide table
 * scrolls sideways rather than wrapping a customer's name across two lines —
 * and an `overflow` ancestor CLIPS an absolutely positioned descendant. The
 * menu was cut off mid-word at the edge of the scroll box: "Request
 * deactivation" rendered as "Request deactivatio", and on a table scrolled
 * sideways the whole menu could be invisible.
 *
 * Positioning it out of the flow means placing it by hand, which is the price
 * of escaping the clip. It is anchored to the button's own rectangle, aligned
 * to its right edge, and it flips above the button when there is not enough
 * room below — a menu that opens off the bottom of the screen is as unusable
 * as one that is clipped.
 *
 * A `fixed` element does not travel with a scrolling ancestor, so the menu
 * CLOSES on any scroll rather than being left behind pointing at nothing.
 */
export function RowMenu({ items }: { items: MenuItem[] }) {
  const [at, setAt] = React.useState<{
    top: number;
    left: number;
  } | null>(null);
  const open = at !== null;
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLSpanElement>(null);

  /** Where the menu goes, from the button's rectangle at the moment of click. */
  const place = () => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const height = items.length * 32 + 8;
    const below = window.innerHeight - rect.bottom;
    setAt({
      // Above when below will not hold it, which is what the last few rows of
      // any long table need.
      top:
        below < height + VIEWPORT_MARGIN
          ? Math.max(VIEWPORT_MARGIN, rect.top - height - 4)
          : rect.bottom + 4,
      // Right-aligned with the button, then pulled back inside the window.
      left: Math.max(
        VIEWPORT_MARGIN,
        Math.min(
          rect.right - ROW_MENU_WIDTH,
          window.innerWidth - ROW_MENU_WIDTH - VIEWPORT_MARGIN,
        ),
      ),
    });
  };

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // Both halves: the button lives in the table, the menu lives in the
      // body, and neither contains the other any more.
      if (buttonRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setAt(null);
    };
    const close = () => setAt(null);
    document.addEventListener("mousedown", onDown);
    // Capture, because the scroll that matters is the Card's, not the window's,
    // and a scroll event on an inner element does not bubble.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <span className="relative inline-block">
      <button
        ref={buttonRef}
        title="More actions"
        aria-label="More actions"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (open) setAt(null);
          else place();
        }}
        className={cx(
          "flex h-7 w-7 cursor-pointer items-center justify-center rounded-[4px] border text-muted",
          open
            ? "border-line-strong bg-canvas text-body"
            : "border-line bg-surface hover:bg-canvas hover:text-body",
        )}
      >
        ⋯
      </button>
      {at
        ? createPortal(
            <span
              ref={menuRef}
              role="menu"
              style={{ top: at.top, left: at.left, width: ROW_MENU_WIDTH }}
              className="animate-fade-in fixed z-50 flex flex-col overflow-hidden rounded-[6px] border border-line bg-surface py-1 shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
            >
              {items.map((item, i) => (
                <button
                  key={i}
                  role="menuitem"
                  title={item.title}
                  disabled={item.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAt(null);
                    item.onSelect();
                  }}
                  className={cx(
                    // The label holds its line: these are short phrases, and a
                    // wrapped one made the menu taller than the maths above
                    // expected, which is how it flipped to the wrong side.
                    "px-3 py-1.5 text-left text-sm whitespace-nowrap",
                    item.disabled
                      ? "cursor-not-allowed text-line-strong"
                      : item.destructive
                        ? "cursor-pointer text-danger hover:bg-danger-soft"
                        : "cursor-pointer text-body hover:bg-canvas",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

/* ------------------------------------------------------------------ tabs */

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: Array<{ key: T; label: string; count?: number }>;
  value: T;
  onChange: (key: T) => void;
  className?: string;
}) {
  return (
    <div className={cx("flex items-center border-b border-line", className)}>
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            "-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-sm whitespace-nowrap",
            value === t.key
              ? "border-brand font-medium text-ink"
              : "border-transparent text-muted hover:text-body",
          )}
        >
          {t.label}
          {t.count !== undefined ? (
            <span className="ml-1.5 text-muted">{t.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function FilterPills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ key: T; label: string; count?: number }>;
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={cx(
            "h-8 cursor-pointer rounded-[4px] border px-2.5 text-[13px]",
            value === o.key
              ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
              : "border-line bg-surface text-body hover:bg-canvas",
          )}
        >
          {o.label}
          {o.count !== undefined ? (
            <span className="ml-1.5 text-muted">{o.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------- selection bar */

export function SelectionBar({
  count,
  children,
  onClear,
}: {
  count: number;
  children: React.ReactNode;
  onClear: () => void;
}) {
  if (!count) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3.5 rounded-[6px] bg-ink px-3.5 py-2.5 text-white shadow-[0_8px_24px_rgba(22,22,22,0.12)]">
      <span className="text-sm font-medium">{count} selected</span>
      <span className="h-[18px] w-px bg-body" />
      {children}
      <button
        onClick={onClear}
        className="cursor-pointer text-[13px] text-line-strong hover:text-white"
      >
        Clear
      </button>
    </div>
  );
}
