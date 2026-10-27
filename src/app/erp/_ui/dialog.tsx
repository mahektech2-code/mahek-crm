"use client";

import * as React from "react";
import { Button, cx } from "@/components/ui/primitives";
import { IconButton, popoverClass } from "./look";
import { useBackdropClose, useEscape } from "@/components/ui/modal";
import { BodyPortal } from "@/components/ui/body-portal";

/* ---------------------------------------------------------------------------
 * THE ERP OPENS A RECORD OR A FORM IN THE MIDDLE OF THE SCREEN, NOT AT ITS
 * EDGE. A side drawer is 600px of a 1280px screen: a twenty-field form became a
 * column somebody scrolled down and lost their place in, and a record's panel
 * (a purchase flow, a trace) sat above forty labels nobody could see past. A
 * dialog has the room to show a record's fields three to a row, and to split a
 * long form into PAGES (`StepBar`) or a record into TABS (`TabBar`), so what
 * somebody reads at once is one screenful.
 *
 * It sits at the drawer's layer (z-60), under the prompt, confirm and result
 * dialogs (z-70) a record's action opens on top of it, and under row menus
 * (z-95). It has a FIXED height on a tall screen so moving between tabs or
 * pages does not make the box jump; the body scrolls inside it.
 * ------------------------------------------------------------------------- */

export type DialogSize = "sm" | "md" | "lg" | "xl";

const WIDTH: Record<DialogSize, number> = { sm: 560, md: 760, lg: 920, xl: 1120 };

export function ErpDialog({
  onClose,
  label,
  size = "md",
  width,
  tall = true,
  children,
}: {
  onClose: () => void;
  label?: string;
  size?: DialogSize;
  /** A width in pixels, where a size does not fit (a wide line table). */
  width?: number;
  /** A fixed height (the default), so tabs and pages do not jump; false sizes to the content. */
  tall?: boolean;
  children: React.ReactNode;
}) {
  useEscape(onClose, true);
  const backdrop = useBackdropClose(onClose);
  return (
    <BodyPortal>
      <div
        {...backdrop}
        className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(22,22,22,0.35)] p-4 sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ width: `min(${width ?? WIDTH[size]}px, 100%)` }}
          /* `whitespace-normal`: a dialog inherits from where it was mounted, and a
             list row carries `nowrap` (see Modal). */
          className={cx(
            "flex max-h-[92vh] flex-col overflow-hidden rounded-card bg-surface whitespace-normal shadow-[0_12px_40px_rgba(22,22,22,0.18)]",
            tall && "h-[min(820px,92vh)]",
          )}
        >
          {children}
        </div>
      </div>
    </BodyPortal>
  );
}

/** The dialog's heading row: what it is, the close cross. */
export function DialogHeader({ children, onClose, aside }: { children: React.ReactNode; onClose: () => void; aside?: React.ReactNode }) {
  return (
    <div className="flex flex-none items-start justify-between gap-3 border-b border-line px-6 py-4">
      <div className="min-w-0 flex-1">{children}</div>
      {aside ? <div className="flex flex-none items-center gap-2">{aside}</div> : null}
      <IconButton label="Close" onClick={onClose}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </IconButton>
    </div>
  );
}

/** A dialog's title — the one size every ERP dialog names itself in. */
export function DialogTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("text-xl leading-7 font-semibold text-ink", className)}>{children}</div>;
}

/** The scrolling middle of a dialog. */
export function DialogBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("grid min-h-0 flex-1 auto-rows-max grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto px-6 py-5", className)}>
      {children}
    </div>
  );
}

/** The dialog's foot: the way out on the left, what it does on the right. */
export function DialogFooter({ left, children }: { left?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-none items-center gap-4 border-t border-divider bg-canvas/60 px-6 py-3">
      {/* The note gives way to the buttons: it truncates (whole on hover) rather than pushing them onto a second row. */}
      <div className="min-w-0 flex-1 truncate text-meta text-muted" title={typeof left === "string" ? left : undefined}>
        {left}
      </div>
      <div className="flex flex-none flex-wrap justify-end gap-2.5">{children}</div>
    </div>
  );
}

export type DialogTab = { key: string; label: string; count?: number | string };

/** A record's tabs, under its heading. */
export function TabBar({ tabs, active, onChange }: { tabs: DialogTab[]; active: string; onChange: (key: string) => void }) {
  return (
    <div role="tablist" className="flex flex-none gap-1 overflow-x-auto border-b border-line px-4">
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={cx(
              "-mb-px flex h-11 flex-none cursor-pointer items-center gap-1.5 border-b-2 px-3 text-sm whitespace-nowrap",
              on ? "border-brand font-semibold text-ink" : "border-transparent text-muted hover:text-body",
            )}
          >
            {t.label}
            {t.count != null && t.count !== "" && t.count !== 0 ? (
              <span className={cx("rounded-full px-1.5 text-2xs tabular-nums", on ? "bg-brand-soft text-brand-hover" : "bg-divider text-muted")}>{t.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A form's pages, numbered. A page already reached can be gone back to by
 * clicking it; one ahead cannot — moving forward checks the page you are on.
 */
export function StepBar({
  steps,
  active,
  reached,
  errored,
  onChange,
}: {
  steps: string[];
  active: number;
  /** The furthest page reached; pages up to it are clickable. */
  reached: number;
  /** Pages carrying an error, marked so somebody can find them. */
  errored?: Set<number>;
  onChange: (i: number) => void;
}) {
  return (
    <ol className="flex flex-none items-center gap-1 overflow-x-auto border-b border-line px-5 py-2.5">
      {steps.map((s, i) => {
        const on = i === active;
        const done = i < active;
        const can = i <= reached && !on;
        const bad = errored?.has(i);
        return (
          <li key={`${s}:${i}`} className="flex flex-none items-center gap-1">
            {i > 0 ? <span className={cx("h-px w-5", i <= reached ? "bg-brand" : "bg-line")} /> : null}
            <button
              type="button"
              disabled={!can}
              onClick={() => can && onChange(i)}
              className={cx(
                "flex h-8 items-center gap-2 rounded-full pr-3 pl-1 text-meta whitespace-nowrap",
                can ? "cursor-pointer hover:bg-canvas" : "cursor-default",
                on ? "font-semibold text-ink" : done ? "text-body" : "text-muted",
              )}
            >
              <span
                className={cx(
                  "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
                  bad ? "bg-danger text-white" : on ? "bg-brand text-white" : done ? "bg-brand-soft text-brand-hover" : "bg-divider text-muted",
                )}
              >
                {bad ? "!" : done ? "✓" : i + 1}
              </span>
              {s}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export type MoreItem = { key: string; label: string; onSelect: () => void; disabled?: boolean; why?: string; danger?: boolean };

/**
 * A footer's overflow: "More" and the actions that did not earn a button of
 * their own. It opens UPWARD, over the dialog's body — a footer has nothing
 * below it — and closes on a pick, a click elsewhere or Escape.
 */
export function MoreMenu({ items, label = "More" }: { items: MoreItem[]; label?: string }) {
  const [open, setOpen] = React.useState(false);
  const box = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div ref={box} className="relative">
      <Button type="button" variant="secondary" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)} className={cx(open && "text-ink")}>
        {label}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={cx(open && "rotate-180")}>
          <path d="m6 15 6-6 6 6" />
        </svg>
      </Button>
      {open ? (
        <div
          role="menu"
          className={cx("animate-fade-in absolute left-0 bottom-full z-10 mb-2 flex max-h-[60vh] w-max max-w-[340px] min-w-[220px] flex-col overflow-y-auto py-1", popoverClass)}
        >
          {items.map((it) => (
            <button
              key={it.key}
              role="menuitem"
              type="button"
              title={it.why}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className={cx(
                "cursor-pointer px-3.5 py-2 text-left text-sm hover:bg-canvas",
                it.disabled ? "text-muted" : it.danger ? "text-danger" : "text-ink",
              )}
            >
              <span className="block">{it.label}</span>
              {it.disabled && it.why ? <span className="mt-0.5 block text-xs leading-4 text-muted">{it.why}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
