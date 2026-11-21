"use client";

import { useMemo, useState } from "react";
import { controlClass, cx } from "@/components/ui/primitives";
import { Icon as ShellIcon } from "@/components/shell/icons";
import { BodyPortal } from "@/components/ui/body-portal";
import { Button } from "@/components/ui/primitives";
import type { QuoteStatus } from "@/lib/erp/engines/quotes";
import { eyebrowClass, LinkButton, popoverClass } from "../_ui/look";

/* ---------------------------------------------------------------------------
 * The table's floating pieces: the marks' colours, the right-click menu, a
 * toolbar button's drop-down, the option picker of a party or text cell, and
 * the PO note of a bought rate.
 * ------------------------------------------------------------------------- */

/* A mark is a coloured LEFT EDGE on the cell, so the rate in it stays as
   readable as any other: green Ready to buy, orange bought, red cancelled,
   blue picked up. A cancelled rate is also struck through, because it is a
   rate nobody bought at and it counts for no figure. */
export const MARK_EDGE: Record<QuoteStatus, string> = {
  ready: "shadow-[inset_3px_0_0_var(--color-success)]",
  po: "shadow-[inset_3px_0_0_var(--color-warn)]",
  cancel: "text-muted line-through decoration-danger/50 shadow-[inset_3px_0_0_var(--color-danger)]",
  pickup: "shadow-[inset_3px_0_0_var(--color-info)]",
};

export const MARK_SWATCH: Record<QuoteStatus, string> = {
  ready: "border-success bg-success-soft",
  po: "border-warn bg-warn-soft",
  cancel: "border-danger bg-danger-soft",
  pickup: "border-info bg-info-soft",
};

export const MARK_DOT: Record<QuoteStatus, string> = {
  ready: "bg-success",
  po: "bg-warn",
  cancel: "bg-danger",
  pickup: "bg-info",
};

export function Swatch({ status, className }: { status: QuoteStatus; className?: string }) {
  return <span aria-hidden className={cx("inline-block h-3 w-3 flex-none rounded-[3px] border-[1.5px]", MARK_SWATCH[status], className)} />;
}

export type MenuItem = {
  /** What the item does, handed back to `onPick`. */
  id: string;
  label: string;
  hint?: string;
  swatch?: QuoteStatus;
  strong?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
};

/**
 * THE RIGHT-CLICK MENU, in groups: what to look at, what to change, and what
 * to take back — take-backs red and last. The caller leaves out what the
 * person may not do (a missing Edit or Delete tick), rather than greying it.
 * ↑ ↓ Enter work it; Esc or a click outside closes it.
 */
export function ContextMenu({
  x,
  y,
  title,
  sub,
  groups,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  title?: string;
  sub?: string;
  groups: MenuItem[][];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const shown = groups.filter((g) => g.length);
  const flat = shown.flat();
  const [hl, setHl] = useState(() =>
    Math.max(
      0,
      flat.findIndex((i) => i.strong && !i.disabled),
    ),
  );
  const W = 280;
  const H = flat.length * 34 + shown.length * 9 + (title ? 52 : 12);
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(x, window.innerWidth - W - 8)),
    top: y + H + 8 < window.innerHeight ? y : Math.max(8, y - H),
    width: W,
  };
  const pick = (i: number) => {
    const it = flat[i];
    if (!it || it.disabled) return;
    onClose();
    onPick(it.id);
  };
  const offset = shown.map((_, gi) => shown.slice(0, gi).reduce((t, g) => t + g.length, 0));
  return (
    <BodyPortal>
      <div
        className="fixed inset-0 z-[94]"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        aria-hidden
      />
      <div
        role="menu"
        aria-label={title ?? "Actions"}
        tabIndex={-1}
        ref={(el) => {
          if (el && !el.contains(document.activeElement)) el.focus();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setHl((h) => Math.min(flat.length - 1, h + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHl((h) => Math.max(0, h - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(hl);
          }
        }}
        style={style}
        className={cx("animate-fade-in fixed z-[95] flex flex-col overflow-hidden p-1.5 outline-none", popoverClass)}
      >
        {title ? (
          <div className="mb-1 border-b border-divider px-2.5 pt-1.5 pb-2">
            <div className="truncate text-sm font-semibold text-ink">{title}</div>
            {sub ? <div className="truncate text-xs text-muted">{sub}</div> : null}
          </div>
        ) : null}
        {shown.map((g, gi) => (
          <div key={gi} className={cx(gi > 0 && "mt-1 border-t border-divider pt-1")}>
            {g.map((it, ii) => {
              const i = offset[gi] + ii;
              return (
                <button
                  key={it.id}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  title={it.title}
                  onMouseEnter={() => setHl(i)}
                  onClick={() => pick(i)}
                  className={cx(
                    "flex h-8.5 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-sm",
                    it.disabled
                      ? "cursor-default text-line-strong"
                      : it.danger
                        ? cx("cursor-pointer text-danger", i === hl && "bg-danger-soft")
                        : it.strong
                          ? cx("cursor-pointer font-semibold text-brand-hover", i === hl ? "bg-brand-soft" : "")
                          : cx("cursor-pointer text-body", i === hl && "bg-canvas"),
                  )}
                >
                  {it.swatch ? <Swatch status={it.swatch} /> : null}
                  <span className="truncate">{it.label}</span>
                  {it.hint ? <span className="ml-auto shrink-0 text-xs text-muted">{it.hint}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </BodyPortal>
  );
}

/**
 * A toolbar button with a drop-down under it — Mark, Filter, Sort, Freeze.
 * The panel is the caller's; `close` is handed to it.
 */
export function ToolMenu({
  label,
  icon,
  badge,
  disabled,
  title,
  width = 260,
  align = "left",
  children,
}: {
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
  title?: string;
  width?: number;
  align?: "left" | "right";
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <ToolButton disabled={disabled} title={title} onClick={() => setOpen((o) => !o)} pressed={open} aria-haspopup="menu" aria-expanded={open}>
        {icon}
        {label}
        {badge}
        <ShellIcon name="chevron" size={12} className="rotate-90 text-muted" />
      </ToolButton>
      {open ? (
        <>
          <div className="fixed inset-0 z-[94]" onMouseDown={() => setOpen(false)} aria-hidden />
          <div
            onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
            style={{ width }}
            className={cx("animate-fade-in absolute top-[calc(100%+4px)] z-[95] p-1.5", align === "right" ? "right-0" : "left-0", popoverClass)}
          >
            {children(() => setOpen(false))}
          </div>
        </>
      ) : null}
    </span>
  );
}

/** A flat toolbar button: an icon, a word, or both. */
export function ToolButton({ pressed, className, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex h-7.5 min-w-7.5 flex-none items-center justify-center gap-1.5 rounded-control px-2 text-meta whitespace-nowrap text-body",
        props.disabled ? "cursor-not-allowed text-line-strong" : "cursor-pointer hover:bg-surface hover:text-ink",
        pressed && "bg-surface text-ink shadow-[inset_0_0_0_1px_var(--color-line)]",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** One choice in a ToolMenu: a tick where it is the current one. */
export function MenuChoice({ on, disabled, title, onClick, children }: { on?: boolean; disabled?: boolean; title?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={!!on}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cx(
        "flex h-8.5 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-sm",
        disabled ? "cursor-not-allowed text-line-strong" : "cursor-pointer text-body hover:bg-canvas",
      )}
    >
      <span className="w-4 shrink-0 text-brand">{on ? <ShellIcon name="tick" size={14} /> : null}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
    </button>
  );
}

/* The toolbar's own icons, in the shell icons' stroke. */
const ICON_PATHS = {
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
    </>
  ),
  redo: (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9a5 5 0 0 0 0 10h3" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  sort: <path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4" />,
  freeze: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18M3 9h18" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="19" cy="12" r="1.3" />
    </>
  ),
} as const;

export function ToolIcon({ name, size = 16, className }: { name: keyof typeof ICON_PATHS; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/** Where a floating panel goes beside a cell: below it, or above where there is no room. */
function placeBy(anchor: DOMRect, height: number, width: number): React.CSSProperties {
  const below = anchor.bottom + height + 8 < window.innerHeight || anchor.top < height + 8;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
  return below ? { left, top: anchor.bottom + 4 } : { left, bottom: window.innerHeight - anchor.top + 4 };
}

const PAGE = 10;

/**
 * THE OPTION PICKER — a select menu in the app's own surface, not a list of
 * suggestions. It names what is being chosen and how many there are, marks
 * the current value, and shows ten at a time: past ten options it carries a
 * search box, and "Show more" brings the next ten. A name that is not on the
 * list is added from the same box. ↑ ↓ Enter work it; Esc or a click outside
 * closes it without changing anything.
 */
export function OptionPicker({
  anchor,
  title,
  noun,
  options,
  value,
  initialQuery,
  onPick,
  onClose,
}: {
  anchor: DOMRect;
  title: string;
  noun: string;
  options: string[];
  value: string;
  initialQuery: string;
  onPick: (v: string) => void;
  onClose: () => void;
}) {
  const searchable = options.length > PAGE;
  const [query, setQuery] = useState(initialQuery);
  const [adding, setAdding] = useState(!searchable && !!initialQuery);
  const [limit, setLimit] = useState(PAGE);
  const [hl, setHl] = useState(0);
  const q = query.trim().toLowerCase();
  const matched = useMemo(() => {
    if (!q || (!searchable && !adding)) return options;
    const starts: string[] = [];
    const has: string[] = [];
    for (const v of options) {
      const l = v.toLowerCase();
      if (l.startsWith(q)) starts.push(v);
      else if (l.includes(q)) has.push(v);
    }
    return [...starts, ...has];
  }, [options, q, searchable, adding]);
  const shown = matched.slice(0, limit);
  const canAdd = !!q && !options.some((v) => v.toLowerCase() === q);
  /* The rows the keyboard walks: the shown options, then "Add". */
  const total = shown.length + (canAdd ? 1 : 0);
  const pick = (i: number) => (i < shown.length ? onPick(shown[i]) : canAdd ? onPick(query.trim()) : undefined);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHl((h) => Math.min(total - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHl((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (total) pick(Math.min(hl, total - 1));
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose();
    }
  }

  const showInput = searchable || adding;
  return (
    <BodyPortal>
      <div className="fixed inset-0 z-[94]" onMouseDown={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={`Choose ${title}`}
        tabIndex={-1}
        ref={(el) => {
          if (el && !showInput && document.activeElement !== el && !el.contains(document.activeElement)) el.focus();
        }}
        onKeyDown={onKey}
        style={{
          ...placeBy(anchor, 380, 300),
          width: Math.max(anchor.width, 300),
        }}
        className={cx("animate-fade-in fixed z-[95] flex max-h-[380px] flex-col overflow-hidden outline-none", popoverClass)}
      >
        <div className="flex items-center justify-between gap-2 border-b border-divider px-3 py-2">
          <span className={eyebrowClass}>{title}</span>
          <span className="text-xs text-muted">{q && showInput ? `${matched.length} of ${options.length}` : `${options.length} ${noun}`}</span>
        </div>
        {showInput ? (
          <div className="relative border-b border-divider p-2">
            <ShellIcon name="search" size={15} className="pointer-events-none absolute top-[17px] left-4.5 text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(PAGE);
                setHl(0);
              }}
              placeholder={searchable ? `Search ${noun}, or type a new one` : "Type a new name"}
              className={controlClass({ className: "h-8 pr-2 pl-7.5" })}
            />
          </div>
        ) : null}
        <div role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {shown.map((v, i) => {
            const at = q && showInput ? v.toLowerCase().indexOf(q) : -1;
            const current = v === value;
            return (
              <div
                key={v}
                role="option"
                aria-selected={current}
                ref={(el) => {
                  if (el && i === hl) el.scrollIntoView({ block: "nearest" });
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(v);
                }}
                onMouseEnter={() => setHl(i)}
                title={v}
                className={cx("flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm", i === hl ? "bg-canvas text-ink" : "text-body")}
              >
                <span className="w-4 shrink-0 text-brand">{current ? <ShellIcon name="tick" size={14} /> : null}</span>
                <span className={cx("truncate", current && "font-medium text-ink")}>
                  {at >= 0 ? (
                    <>
                      {v.slice(0, at)}
                      <span className="font-semibold text-ink">{v.slice(at, at + q.length)}</span>
                      {v.slice(at + q.length)}
                    </>
                  ) : (
                    v
                  )}
                </span>
              </div>
            );
          })}
          {!shown.length && !canAdd ? (
            <div className="px-3 py-3 text-sm text-muted">
              No {noun} match “{query.trim()}”.
            </div>
          ) : null}
          {canAdd ? (
            <div
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(query.trim());
              }}
              onMouseEnter={() => setHl(shown.length)}
              className={cx("flex cursor-pointer items-center gap-2 border-t border-divider px-3 py-2 text-sm text-brand-hover", hl === shown.length ? "bg-brand-soft" : "")}
            >
              <ShellIcon name="plus" size={14} className="w-4 shrink-0" />
              <span className="truncate">
                Add “<span className="font-medium">{query.trim()}</span>”
              </span>
            </div>
          ) : null}
        </div>
        {matched.length > limit || (!showInput && !adding) || value ? (
          <div className="flex items-center gap-2 border-t border-divider bg-canvas px-3 py-1.5">
            {matched.length > limit ? (
              <LinkButton onMouseDown={(e) => e.preventDefault()} onClick={() => setLimit((l) => l + PAGE)} className="text-meta">
                Show {Math.min(PAGE, matched.length - limit)} more · {matched.length - limit} left
              </LinkButton>
            ) : !showInput ? (
              <LinkButton onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 text-meta">
                <ShellIcon name="plus" size={13} /> Add new
              </LinkButton>
            ) : null}
            <span className="flex-1" />
            {value ? (
              <LinkButton tone="muted" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick("")} className="text-meta">
                Clear
              </LinkButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </BodyPortal>
  );
}

/**
 * THE PO NOTE — Excel's cell comment for a bought rate. Hovering an orange
 * cell shows it; clicking pins it with its actions; the small corner mark on
 * the cell says a note is there. Undo purchase is offered only to somebody
 * holding Delete on the Quotation manager, Edit only with Edit.
 */
export function PoNote({
  at,
  pinned,
  date,
  party,
  column,
  rate,
  drums,
  poNo,
  by,
  when,
  canEdit,
  canUndo,
  onClose,
  onEdit,
  onUndo,
}: {
  at: DOMRect;
  pinned: boolean;
  date: string;
  party: string;
  column: string;
  rate: string;
  drums: number | null;
  poNo: string | null;
  by: string | null;
  when: string;
  canEdit: boolean;
  canUndo: boolean;
  onClose: () => void;
  onEdit: () => void;
  onUndo: () => void;
}) {
  const W = 300;
  const right = at.right + W + 12 < window.innerWidth;
  const style: React.CSSProperties = right
    ? {
        left: at.right + 6,
        top: Math.min(at.top - 4, window.innerHeight - 280),
      }
    : {
        left: Math.max(8, at.left - W - 6),
        top: Math.min(at.top - 4, window.innerHeight - 280),
      };
  return (
    <BodyPortal>
      {pinned ? <div className="fixed inset-0 z-[94]" onMouseDown={onClose} aria-hidden /> : null}
      <div
        role="note"
        style={{ ...style, width: W }}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className={cx("animate-fade-in fixed z-[95] overflow-hidden rounded-card border border-warn-line bg-surface shadow-pop", !pinned && "pointer-events-none")}
      >
        <div className="border-b border-warn-line bg-warn-soft px-3.5 py-2.5 shadow-[inset_3px_0_0_var(--color-warn)]">
          <div className={eyebrowClass}>PO made in Tally &amp; mailed</div>
          <div className="mt-0.5 font-mono text-md font-semibold text-ink">{poNo || "—"}</div>
        </div>
        <dl className="grid grid-cols-[92px_1fr] gap-x-3 gap-y-1.5 px-3.5 py-3 text-meta">
          <dt className="text-muted">Drums</dt>
          <dd className="font-semibold text-ink tabular-nums">{drums ?? "—"}</dd>
          <dt className="text-muted">Rate</dt>
          <dd className="text-ink tabular-nums">{rate || "—"}</dd>
          <dt className="text-muted">Material</dt>
          <dd className="text-ink">{column}</dd>
          <dt className="text-muted">Party</dt>
          <dd className="text-ink">{party || "—"}</dd>
          <dt className="text-muted">Quoted</dt>
          <dd className="text-ink">{date}</dd>
        </dl>
        <div className="border-t border-divider px-3.5 py-2 text-xs text-muted">
          {by ? `Bought by ${by}` : "Bought"}
          {when ? ` · ${when}` : ""}
        </div>
        {pinned && (canEdit || canUndo) ? (
          <div className="flex items-center justify-end gap-2 border-t border-divider bg-canvas px-3.5 py-2">
            {canUndo ? (
              <Button size="sm" variant="ghost" onClick={onUndo} className="text-danger">
                Undo purchase
              </Button>
            ) : null}
            {canEdit ? (
              <Button size="sm" onClick={onEdit}>
                Edit
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </BodyPortal>
  );
}
