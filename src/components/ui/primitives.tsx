import * as React from "react";
import { Icon } from "@/components/shell/icons";
import { HintTip } from "./hint-tip";
import type { SortDirection } from "@/lib/sort-param";
import { cleanDecimal, parseDecimal, parseRupees, rupeesFromPaise } from "@/lib/format";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Whether the caller's className already says something about one property.
 *
 * `cx` is a plain join, not a Tailwind merge: when a default and an override
 * both set one property, the stylesheet's order decides, not intent — and the
 * default often wins. `<Callout className="mb-0">` kept its 16px margin on
 * every screen that asked for none. A primitive therefore applies a default
 * only where the caller has not spoken, which this answers.
 */
export function says(className: string | undefined, prop: "mb" | "h" | "w" | "display"): boolean {
  if (!className) return false;
  const re = {
    mb: /(^|\s)(-?mb|-?my|-?m)-/,
    h: /(^|\s)h-/,
    w: /(^|\s)w-/,
    display: /(^|\s)(block|inline|inline-block|grid|inline-grid|hidden|contents)(\s|$)/,
  }[prop];
  return re.test(className);
}

/* ---------------------------------------------------------------- buttons */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dark" | "whatsapp";
type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-control font-medium " +
  "whitespace-nowrap transition-colors duration-100 disabled:cursor-not-allowed";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border border-brand bg-brand text-white hover:bg-brand-hover hover:border-brand-hover " +
    "disabled:bg-line-strong disabled:border-line-strong",
  secondary:
    "border border-line-strong bg-surface text-body hover:bg-canvas " +
    "disabled:text-line-strong disabled:hover:bg-surface",
  ghost:
    "border border-line bg-surface text-body hover:bg-canvas " +
    "disabled:text-line-strong disabled:hover:bg-surface",
  danger:
    "border border-danger bg-danger text-white hover:brightness-110 " +
    "disabled:bg-line-strong disabled:border-line-strong",
  dark: "border border-body bg-transparent text-white hover:bg-white/10",
  /* Opens a WhatsApp chat — WhatsApp's own green, so it reads as leaving for WhatsApp. */
  whatsapp: "border border-whatsapp bg-whatsapp text-white hover:brightness-95 disabled:bg-line-strong disabled:border-line-strong",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-[13px]",
  md: "h-9 px-4 text-sm",
};

/** `Button`'s look as a class, for a link (`<a>`, `Link`) that is an action. A
    button inside a link is invalid HTML, and a link with its own border drifts. */
export function buttonClass({ variant = "secondary", size = "md", className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return cx(BUTTON_BASE, `ui-btn ui-btn-${variant}`, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], "cursor-pointer no-underline hover:no-underline", className);
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      {...props}
      className={cx(
        BUTTON_BASE,
        `ui-btn ui-btn-${variant}`,
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        props.disabled ? "" : "cursor-pointer",
        className,
      )}
    />
  );
}

/* ----------------------------------------------------------------- badges */

export type Tone =
  | "neutral"
  | "brand"
  | "success"
  | "warn"
  | "danger"
  | "muted";

const BADGE_TONES: Record<Tone, string> = {
  neutral: "bg-divider text-body",
  brand: "bg-brand-soft text-brand-hover",
  success: "bg-success-soft text-success",
  warn: "bg-warn-soft text-warn-ink",
  danger: "bg-danger-soft text-danger",
  muted: "bg-canvas text-muted",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  title,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
  /** The whole text, where the badge is narrow enough to have cut it short. */
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "ui-badge inline-flex h-5 items-center rounded-[3px] px-1.5 text-[11px] font-medium whitespace-nowrap",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SlowPayerBadge() {
  return (
    <Badge tone="warn" className="border border-warn-line">
      Slow payer
    </Badge>
  );
}

export function Dot({ tone = "neutral" }: { tone?: Tone }) {
  const colours: Record<Tone, string> = {
    neutral: "bg-line-strong",
    brand: "bg-brand",
    success: "bg-success",
    warn: "bg-warn",
    danger: "bg-danger",
    muted: "bg-muted",
  };
  return (
    <span
      className={cx("block h-2 w-2 flex-none rounded-full", colours[tone])}
      aria-hidden
    />
  );
}

/* --------------------------------------------------------------- surfaces */

export function Card({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cx(
        "rounded-card border border-line bg-surface",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  hint,
  action,
  className,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex items-center justify-between gap-3 border-b border-divider px-5 py-3.5",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-lg leading-6 font-semibold text-ink">{title}</div>
        {hint ? <div className="mt-0.5 text-[13px] text-muted">{hint}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("ui-section-label text-xs font-medium tracking-label text-muted uppercase", className)}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------ page header */

export function PageHeader({
  title,
  subtitle,
  subtitleShown = false,
  actions,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Keep the subtitle written in the v4 look — for one that is a FACT (a
   *  month, a date range, a record's name), not an explanation. */
  subtitleShown?: boolean;
  actions?: React.ReactNode;
}) {
  /* In the v4 look a written explanation moves behind an ⓘ beside the title:
     the page says what it is once, and the sentence is a hover away. Only a
     string can be a tooltip, so anything else stays written. */
  const tip = typeof subtitle === "string" && !subtitleShown ? subtitle : null;
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-[28px] leading-[34px] font-semibold text-ink">
          <span>{title}</span>
          {tip ? <HintTip text={tip} className="ui-hint-tip hidden" /> : null}
        </h1>
        {subtitle ? (
          <p className={cx("mt-1 text-[13px] leading-[18px] text-muted", tip ? "ui-hint" : null)}>{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-none items-center gap-2.5 print:hidden">{actions}</div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- metric strip */

export type Metric = {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "success" | "danger" | "muted";
  sub?: string;
  tone?: "ink" | "danger" | "success";
  /**
   * Optional. A tile with this set is a real control, not just a number —
   * every existing caller omits it and keeps rendering exactly as before;
   * only a caller that opts in gets a clickable tile.
   */
  onClick?: () => void;
};

export function MetricStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <Card className="mb-4 flex flex-wrap items-start gap-x-8 gap-y-3.5 px-5 py-3.5">
      {metrics.map((m) => {
        const Tag = m.onClick ? "button" : "div";
        return (
          <Tag
            key={m.label}
            type={m.onClick ? "button" : undefined}
            onClick={m.onClick}
            className={cx("text-left", m.onClick && "cursor-pointer")}
          >
            <div className="text-[11px] font-medium tracking-label whitespace-nowrap text-muted uppercase">
              {m.label}
            </div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <span
                className={cx(
                  "text-[22px] leading-7 font-semibold",
                  m.tone === "danger"
                    ? "text-danger"
                    : m.tone === "success"
                      ? "text-success"
                      : "text-ink",
                )}
              >
                {m.value}
              </span>
              {m.delta ? (
                <span
                  className={cx(
                    "text-[13px] font-medium",
                    m.deltaTone === "danger"
                      ? "text-danger"
                      : m.deltaTone === "muted"
                        ? "text-muted"
                        : "text-success",
                  )}
                >
                  {m.delta}
                </span>
              ) : null}
            </div>
            {m.sub ? (
              <div className="text-xs whitespace-nowrap text-muted">{m.sub}</div>
            ) : null}
          </Tag>
        );
      })}
    </Card>
  );
}

/* -------------------------------------------------------------- progress */

export function Progress({
  value,
  tone = "brand",
  className,
}: {
  value: number;
  tone?: "brand" | "success" | "warn" | "danger";
  className?: string;
}) {
  const colours = {
    brand: "bg-brand",
    success: "bg-success",
    warn: "bg-warn",
    danger: "bg-danger",
  };
  return (
    <span
      className={cx(
        "block h-1.5 overflow-hidden rounded-[3px] bg-divider",
        className,
      )}
    >
      <span
        className={cx("block h-full rounded-[3px]", colours[tone])}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </span>
  );
}

/* ---------------------------------------------------------------- tables */

export function Th({
  children,
  align = "left",
  className,
  ...rest
}: React.ThHTMLAttributes<HTMLTableCellElement> & {
  align?: "left" | "right";
}) {
  return (
    <th
      {...rest}
      className={cx(
        "sticky top-0 z-10 border-b border-line bg-canvas px-3 py-2 text-xs font-medium tracking-label whitespace-nowrap text-muted uppercase",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

/**
 * A `Th` that sorts its column when clicked — the chevron shows the CURRENT
 * direction on the active column and sits faint and unrotated on every other
 * sortable one, so a person scanning the header can tell which columns even
 * offer it without having to click each one to find out.
 */
export function SortableTh({
  children,
  align = "left",
  className,
  active,
  direction,
  onSort,
  after,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
  /** Whether THIS column is the one currently sorted on. */
  active: boolean;
  /** The direction to show — only meaningful while `active`. */
  direction: SortDirection;
  onSort: () => void;
  /** A control drawn beside the sort button — a column's filter. */
  after?: React.ReactNode;
}) {
  const sortButton = (
      <button
        type="button"
        onClick={onSort}
        className={cx(
          /* A <button> does not inherit text-transform — the preflight resets
             it — so without saying it again here a sortable heading read
             "Customer" beside a plain one reading "CONTACT PERSON". */
          "inline-flex cursor-pointer items-center gap-1 tracking-label uppercase hover:text-body",
          align === "right" ? "flex-row-reverse" : undefined,
          active ? "text-body" : undefined,
        )}
      >
        {children}
        <Icon
          name="chevron"
          size={12}
          className={cx(
            "shrink-0 transition-transform",
            active ? "text-brand" : "text-muted opacity-40",
            active && direction === "asc" ? "-rotate-90" : "rotate-90",
          )}
        />
      </button>
  );
  return (
    <Th align={align} className={className} aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : undefined}>
      {after ? (
        <span className={cx("flex min-w-0 items-center gap-0.5", align === "right" ? "justify-end" : undefined)}>
          {sortButton}
          {after}
        </span>
      ) : (
        sortButton
      )}
    </Th>
  );
}

export function Td({
  children,
  align = "left",
  className,
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement> & {
  align?: "left" | "right";
}) {
  /*
   * A table cell holds its line unless the caller says otherwise.
   *
   * The browser default is the opposite, and it is wrong for every table in
   * this app. A cell wraps, so the column can be made narrow, so the browser
   * makes it narrow — and a telephone number comes out as
   *
   *     +91
   *     99606
   *     85455
   *
   * three lines tall, in a row that is now four lines tall, in a list somebody
   * is scanning. The value never needed the space; the column gave it away
   * because wrapping said it could.
   *
   * Every screen with a table already puts it inside a horizontally scrolling
   * container, so the width is there to be taken. Scrolling a wide table
   * sideways is something people do without thinking; reading a phone number
   * down three lines is not.
   *
   * Callers that genuinely want prose to flow say so — `whitespace-normal`, or
   * `truncate` with a `title`, which several already do. `cx` is a plain join
   * with no Tailwind conflict resolution, so two whitespace utilities on one
   * element would be settled by stylesheet order rather than by intent. The
   * default is therefore only applied when the caller has not spoken.
   */
  const callerControlsWrapping = /(^|\s)whitespace-/.test(className ?? "");

  return (
    <td
      {...rest}
      className={cx(
        "h-[var(--rowh)] px-3 text-sm text-body",
        callerControlsWrapping ? null : "whitespace-nowrap",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      {...rest}
      className={cx("border-b border-divider last:border-0", className)}
    >
      {children}
    </tr>
  );
}

/* ---------------------------------------------------------- empty states */

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="px-6 py-14 text-center">
      {icon ? <div className="mb-3 flex justify-center">{icon}</div> : null}
      <div className="flex items-center justify-center gap-2 text-lg font-semibold text-ink">
        <span>{title}</span>
        {/* v4: the sentence moves behind an ⓘ — an empty list is its title
            and its one action. */}
        {body ? <HintTip text={body} className="ui-hint-tip hidden" /> : null}
      </div>
      {body ? (
        <p className="ui-hint mx-auto mt-1.5 max-w-[460px] text-[15px] text-muted">
          {body}
        </p>
      ) : null}
      {action ? (
        <div className="mt-4 flex justify-center gap-2.5">{action}</div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- callouts */

export function Callout({
  tone = "warn",
  children,
  className,
}: {
  tone?: "warn" | "danger" | "brand" | "success" | "info" | "neutral";
  children: React.ReactNode;
  className?: string;
}) {
  const tones = {
    warn: "border-warn-line bg-warn-soft border-l-[3px] border-l-warn",
    danger: "border-danger-soft bg-danger-soft border-l-[3px] border-l-danger",
    brand: "border-brand-softer bg-brand-soft border-l-[3px] border-l-brand",
    success: "border-success-soft bg-success-soft border-l-[3px] border-l-success",
    /* Information that asks nothing of the reader — what the system did, how a figure was read. */
    info: "border-info-soft bg-info-soft border-l-[3px] border-l-info",
    /* A plain aside, where no colour would be true. */
    neutral: "border-line bg-canvas border-l-[3px] border-l-line-strong",
  };
  return (
    <div
      className={cx(
        "rounded-control border px-4 py-2.5",
        says(className, "display") ? null : "flex items-center gap-3",
        says(className, "mb") ? null : "mb-4",
        tones[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ----------------------------------------------------------------- forms */

export function Field({
  label,
  hint,
  hintShown = false,
  required = false,
  optional = false,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  /** Keep the hint written under the box even in the v4 look — for a hint
   *  that changes what is typed. Otherwise v4 puts it behind an ⓘ. */
  hintShown?: boolean;
  /** A red * after the label (said as "required" to a screen reader). */
  required?: boolean;
  /** A small grey "optional" after the label — never a pill, never a word in
   *  the label itself. */
  optional?: boolean;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      {/* `ui-field-label`, `ui-hint` and `ui-hint-tip` style nothing on their
          own: the v4 sheet reads them, setting the label in sentence case and
          trading the line of hint for the ⓘ. Every other app is unchanged. */}
      <span className="ui-field-label mb-1 flex items-center gap-1 text-xs font-medium tracking-label text-muted uppercase">
        <span>{label}</span>
        {required ? (
          <>
            <span aria-hidden="true" className="text-danger">*</span>
            <span className="sr-only">(required)</span>
          </>
        ) : null}
        {optional ? (
          <span className="text-[11.5px] font-normal tracking-normal text-faint normal-case">optional</span>
        ) : null}
        {hint && !hintShown && !error ? <HintTip text={hint} className="ui-hint-tip hidden" /> : null}
      </span>
      {/* Controls fill the field; in filter bars they keep their natural width. */}
      <span className="block [&>select]:w-full">{children}</span>
      {error ? (
        <span className="mt-1 block text-[13px] text-danger">{error}</span>
      ) : hint ? (
        <span className={cx("mt-1 block text-[13px] text-muted", hintShown ? null : "ui-hint")}>{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * A text control's look — border, radius, padding, focus ring — said ONCE, so
 * a screen that has to draw a bare `<input>` (a date in a toolbar, a cell in a
 * line table) draws the same box as `Input`. The border colour is chosen here
 * rather than layered, because two border colours on one element are decided
 * by stylesheet order, not by which was meant.
 */
export function controlClass({
  invalid = false,
  warn = false,
  className,
}: { invalid?: boolean; warn?: boolean; className?: string } = {}): string {
  return cx(
    "ui-control rounded-control border bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand",
    says(className, "w") ? null : "w-full",
    invalid ? "border-danger" : warn ? "border-warn" : "border-line",
    className,
  );
}

export function Input({
  className,
  invalid,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      className={controlClass({ invalid, className: cx(says(className, "h") ? null : "h-8.5", className) })}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        "ui-control",
        "max-w-full rounded-control border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand",
        says(className, "h") ? null : "h-8.5",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Textarea({
  className,
  invalid,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...props}
      className={controlClass({
        invalid,
        className: cx("resize-y py-2 leading-[21px]", className),
      })}
    />
  );
}

/** A bare checkbox's look, for a table cell or a header where `Checkbox`'s own
    label would be in the way. One size and one tint, said once. */
export const checkboxClass = "h-[15px] w-[15px] shrink-0 cursor-pointer accent-brand disabled:cursor-not-allowed";

export function Checkbox({
  label,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode }) {
  return (
    <label
      className={cx("flex cursor-pointer items-center gap-2 text-sm text-body", className)}
    >
      <input
        {...props}
        type="checkbox"
        className={checkboxClass}
      />
      {label}
    </label>
  );
}

export function Radio({
  label,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode }) {
  return (
    <label
      className={cx("flex cursor-pointer items-center gap-2 text-sm text-body", className)}
    >
      <input
        {...props}
        type="radio"
        className={checkboxClass}
      />
      {label}
    </label>
  );
}

/**
 * A rupee box bound to a figure in PAISE rather than to text.
 *
 * Deriving the box from the figure is what made decimals untypeable: "30."
 * parses to 3000 paise, which renders back as "30", and the point is gone
 * before the 5 can follow it. So the box keeps what was typed and shows it for
 * as long as it still means the figure it is bound to; the moment the parent
 * moves the figure itself — an automatic spread, a reset — the box follows.
 */
export function PaiseInput({
  paise,
  onPaise,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  paise: number | null | undefined;
  onPaise: (paise: number | null) => void;
}) {
  const [text, setText] = React.useState(() => (paise ? rupeesFromPaise(paise) : ""));
  const shown = (parseRupees(text) ?? 0) === (paise ?? 0) ? text : paise ? rupeesFromPaise(paise) : "";
  return (
    <input
      inputMode="decimal"
      {...props}
      value={shown}
      onChange={(e) => {
        const next = cleanDecimal(e.target.value);
        setText(next);
        onPaise(parseRupees(next));
      }}
    />
  );
}

/**
 * The same, for a plain number — a percent, litres, kilometres — bound to a
 * figure rather than to text. `places` caps what can be typed after the point.
 */
export function DecimalInput({
  value,
  onValue,
  places = 2,
  className,
  invalid,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: number | null | undefined;
  onValue: (value: number | null) => void;
  places?: number;
  invalid?: boolean;
}) {
  const [text, setText] = React.useState(() => (value == null ? "" : String(value)));
  const shown = (parseDecimal(text) ?? null) === (value ?? null) ? text : value == null ? "" : String(value);
  return (
    <input
      inputMode="decimal"
      {...props}
      value={shown}
      onChange={(e) => {
        const next = cleanDecimal(e.target.value, places);
        setText(next);
        onValue(parseDecimal(next));
      }}
      className={controlClass({ invalid, className: cx("h-8.5", className) })}
    />
  );
}

/** Rupee-prefixed money input. */
export function MoneyInput({
  invalid,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <span
      className={cx(
        "flex h-8.5 items-center rounded-control border bg-surface px-2.5 focus-within:border-brand",
        invalid ? "border-danger" : "border-line",
        className,
      )}
    >
      <span className="mr-1 text-muted">₹</span>
      {/* "decimal", never "numeric": on a phone the second is a keypad with
          no point on it, and every rupee box in the product is this one. */}
      <input
        inputMode="decimal"
        {...props}
        className="min-w-0 flex-1 border-none bg-transparent text-sm text-ink outline-none"
      />
    </span>
  );
}
