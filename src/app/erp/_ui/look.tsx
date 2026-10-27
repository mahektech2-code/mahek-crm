import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * THE ERP'S TYPE SCALE, AS COMPONENTS.
 *
 * Every ERP screen names a thing at one of five sizes, and these are they. The
 * screens used to type the class strings out, and the copies had drifted into
 * twenty-two spellings of "a small grey uppercase label" — some semibold, some
 * regular, some 11px and some 12px, for the same job on neighbouring screens.
 *
 *   page title       `Page` / `PageHeader` (28px) — one per screen
 *   SectionTitle     a block of a page: "Today", "Exceptions", "History"
 *   SubTitle         a part inside one block or card
 *   SectionLabel     (primitives) a section inside a dialog or panel, a field's
 *                    name, a table heading — 12px uppercase
 *   Eyebrow          the caption over a figure in a tile, a column of a dense
 *                    strip — 11px uppercase
 *
 * Never a heading drawn by hand: `erp-design.test.ts` fails on `<h2`/`<h3`
 * and on a hand-typed uppercase label anywhere under `src/app/erp`.
 * ------------------------------------------------------------------------- */

/** The heading of a block on a page. */
export function SectionTitle({ children, aside, className }: { children: React.ReactNode; aside?: React.ReactNode; className?: string }) {
  return (
    <div className={cx("mb-2 flex items-baseline justify-between gap-3", className)}>
      <h2 className="text-md font-semibold text-ink">{children}</h2>
      {aside ? <div className="text-meta text-muted">{aside}</div> : null}
    </div>
  );
}

/** A part inside a block or a card. */
export function SubTitle({ children, aside, className }: { children: React.ReactNode; aside?: React.ReactNode; className?: string }) {
  return (
    <div className={cx("mb-2 flex items-baseline justify-between gap-3", className)}>
      <h3 className="text-sm font-semibold text-ink">{children}</h3>
      {aside ? <div className="text-meta text-muted">{aside}</div> : null}
    </div>
  );
}

/** The 11px caption over a figure — a tile's label, a dense strip's column. */
export const eyebrowClass = "text-2xs font-medium tracking-label text-muted uppercase";

export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx(eyebrowClass, className)}>{children}</div>;
}

/** The 12px label — a section in a dialog, a field's name. `SectionLabel` is
    the block form; this is for a `<label>`, `<span>` or `<th>` that needs it. */
export const labelClass = "text-xs font-medium tracking-label text-muted uppercase";

/** The heading row of a grid drawn from boxes rather than a <table>: the v4
    navy band, white uppercase, the same as every table head in the ERP. */
export const gridHeadClass = "sticky top-0 z-3 border-b border-ink bg-ink text-2xs font-bold tracking-label text-white uppercase";

/** A form field's name, as the v4 design sets it: sentence case, 12px, semibold.
    `labelClass` stays the uppercase heading of a column or a dialog section. */
export const fieldLabelClass = "text-xs font-semibold text-muted";

/** Anything that floats over the page: a menu, a picker's list, a suggestion box. */
export const popoverClass = "rounded-card border border-line bg-surface shadow-pop";

/** A boxed area inside a card or dialog — a group of fields, a panel's block. */
export const insetClass = "rounded-card border border-line p-3.5";

/* ---------------------------------------------------------------------------
 * The two small controls every screen draws and every screen had spelled
 * differently: a word that acts (Change, Remove, Show all) and an icon that
 * acts (close, remove a row, more).
 * ------------------------------------------------------------------------- */

const LINK_TONE = {
  brand: "text-brand-hover",
  muted: "text-muted hover:text-body",
  danger: "text-danger",
} as const;

/** The class of a word that acts — for a `Link` that should read as one. */
export function linkClass(tone: keyof typeof LINK_TONE = "brand", className?: string): string {
  return cx("cursor-pointer font-medium underline-offset-2 hover:underline", LINK_TONE[tone], className);
}

/** A word that acts — "Change", "Remove", "Show all" — set in the text around it. */
export function LinkButton({
  tone = "brand",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof LINK_TONE }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(linkClass(tone), "disabled:cursor-not-allowed disabled:text-line-strong disabled:no-underline", className)}
    />
  );
}

/** An icon that acts. It has no words, so it must be given a label. */
export function IconButton({
  label,
  tone = "muted",
  bordered = false,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: "muted" | "danger"; bordered?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx(
        "flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-control text-muted hover:bg-canvas disabled:cursor-not-allowed disabled:text-line-strong",
        tone === "danger" ? "hover:text-danger" : "hover:text-body",
        bordered && "border border-line bg-surface",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A control that is on or off — a toolbar toggle (Columns, Group by), a chip
    picked from a row of chips. One look for pressed and one for not. */
export function toggleClass(on: boolean, className?: string): string {
  return cx(
    "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control border px-2.5 text-meta whitespace-nowrap",
    on ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line bg-surface text-body hover:bg-canvas",
    className,
  );
}
