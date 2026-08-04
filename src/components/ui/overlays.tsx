"use client";

import * as React from "react";
import { Button, cx } from "./primitives";

export function useEscape(onClose: () => void) {
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
}

/* ----------------------------------------------------------------- modal */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  useEscape(onClose);
  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="animate-fade-in fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(22,22,22,0.35)] p-6"
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width }}
        className="max-h-[88vh] overflow-hidden rounded-[6px] bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
      >
        <div className="border-b border-divider px-5 py-4 text-lg font-semibold text-ink">
          {title}
        </div>
        <div className="max-h-[62vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2.5 border-t border-divider px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

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
      setError("A reason is required — it is recorded against the customer.");
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
            Cancel
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
          <textarea
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
            className={cx(
              "h-16 w-full resize-y rounded-[4px] border bg-surface px-2.5 py-2 text-sm outline-none focus:border-brand",
              error ? "border-danger" : "border-line",
            )}
          />
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

export function RowMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <span ref={ref} className="relative inline-block">
      <button
        title="More actions"
        aria-label="More actions"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
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
      {open ? (
        <span className="animate-fade-in absolute top-8 right-0 z-50 flex w-56 flex-col overflow-hidden rounded-[6px] border border-line bg-surface py-1 shadow-[0_8px_24px_rgba(22,22,22,0.12)]">
          {items.map((item, i) => (
            <button
              key={i}
              title={item.title}
              disabled={item.disabled}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                item.onSelect();
              }}
              className={cx(
                "px-3 py-1.5 text-left text-sm",
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
        </span>
      ) : null}
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
