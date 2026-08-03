import * as React from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------------------------------------------------------------- buttons */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dark";
type ButtonSize = "sm" | "md";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-[4px] font-medium " +
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
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-[13px]",
  md: "h-9 px-4 text-sm",
};

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
  brand: "bg-brand-soft text-[#5223E0]",
  success: "bg-success-soft text-success",
  warn: "bg-warn-soft text-warn-ink",
  danger: "bg-danger-soft text-danger",
  muted: "bg-canvas text-muted",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center rounded-[3px] px-1.5 text-[11px] font-medium whitespace-nowrap",
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
        "rounded-[6px] border border-line bg-surface",
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

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------ page header */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-[28px] leading-[34px] font-semibold text-ink">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 text-[13px] leading-[18px] text-muted">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-none items-center gap-2.5">{actions}</div>
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
};

export function MetricStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <Card className="mb-4 flex flex-wrap items-start gap-x-8 gap-y-3.5 px-5 py-3.5">
      {metrics.map((m) => (
        <div key={m.label}>
          <div className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
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
        </div>
      ))}
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
        "sticky top-0 z-10 border-b border-line bg-canvas px-3 py-2 text-xs font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
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
  return (
    <td
      {...rest}
      className={cx(
        "h-[var(--rowh)] px-3 text-sm text-body",
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
      <div className="text-lg font-semibold text-ink">{title}</div>
      {body ? (
        <p className="mx-auto mt-1.5 max-w-[460px] text-[15px] text-muted">
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
  tone?: "warn" | "danger" | "brand";
  children: React.ReactNode;
  className?: string;
}) {
  const tones = {
    warn: "border-warn-line bg-warn-soft border-l-[3px] border-l-warn",
    danger: "border-danger-soft bg-danger-soft border-l-[3px] border-l-danger",
    brand: "border-brand-softer bg-brand-soft border-l-[3px] border-l-brand",
  };
  return (
    <div
      className={cx(
        "mb-4 flex items-center gap-3 rounded-[4px] border px-4 py-2.5",
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
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      {/* Controls fill the field; in filter bars they keep their natural width. */}
      <span className="block [&>select]:w-full">{children}</span>
      {error ? (
        <span className="mt-1 block text-[13px] text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[13px] text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

const CONTROL =
  "w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink " +
  "outline-none focus:border-brand";

export function Input({
  className,
  invalid,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      className={cx(CONTROL, "h-8.5", invalid && "border-danger", className)}
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
        "rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand",
        "h-8.5 max-w-full",
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
      className={cx(
        CONTROL,
        "resize-y py-2 leading-[21px]",
        invalid && "border-danger",
        className,
      )}
    />
  );
}

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
        className="h-[15px] w-[15px] accent-[#6835FB]"
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
        className="h-[15px] w-[15px] accent-[#6835FB]"
      />
      {label}
    </label>
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
        "flex h-8.5 items-center rounded-[4px] border bg-surface px-2.5 focus-within:border-brand",
        invalid ? "border-danger" : "border-line",
        className,
      )}
    >
      <span className="mr-1 text-muted">₹</span>
      <input
        {...props}
        inputMode="numeric"
        className="min-w-0 flex-1 border-none bg-transparent text-sm text-ink outline-none"
      />
    </span>
  );
}
