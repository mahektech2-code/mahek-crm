import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * Hire's design kit (design brief §4–§5). No hooks, so server and client
 * components draw the same pieces.
 *
 * THE AI TREATMENT is the component that matters: indigo means "an AI wrote
 * this" and nothing else; confidence is a word, never a bare percentage; and
 * what a candidate SAID is set in a serif with a left rule, apart from the
 * system's own voice. Every screen that shows an AI score uses `AiCard` and
 * `Quote` — a second rendering would be the one that drifts.
 * ------------------------------------------------------------------------- */

const PATHS: Record<string, string> = {
  menu: "M4 6h16M4 12h16M4 18h16",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  board: "M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v13h-4z",
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  team: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M22 11h-6",
  cal: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  check: "M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11",
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  gavel: "M14 13l-8.5 8.5a2.1 2.1 0 0 1-3-3L11 10M16 16l6-6M8 8l6-6M9 7l8 8M21 11l-8-8",
  cols: "M4 4h7v16H4zM13 4h7v16h-7z",
  doc: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 13h6M9 17h6",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  box: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  key: "M21 2l-2 2M15.5 7.5l3 3L22 7l-3-3M15.5 7.5L11.4 11.6A5.5 5.5 0 1 0 12.4 12.6",
  layers: "M12 2l10 5-10 5L2 7l10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
  funnel: "M3 4h18l-7 8v6l-4 2v-8z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  scale: "M12 3v18M5 7h14M5 7l-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0zM8 21h8",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  cpu: "M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4",
  star: "M12 2l3 6.5 7 .9-5.1 4.8 1.3 7L12 17.8 5.8 21.2l1.3-7L2 9.4l7-.9z",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  plus: "M12 5v14M5 12h14",
  x: "M18 6L6 18M6 6l12 12",
  chevron: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  back: "M15 18l-6-6 6-6",
  play: "M7 4l13 8-13 8z",
  pause: "M7 4h3v16H7zM14 4h3v16h-3z",
  warn: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z",
  message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  download: "M12 4v12M7 11l5 5 5-5M4 20h16",
};

export function Icon({ n, s = 16, className, style }: { n: string; s?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={cx("flex-none", className)} style={style} aria-hidden>
      <path d={PATHS[n] ?? ""} />
    </svg>
  );
}

/* ------------------------------------------------------------------ badges */

export type Tone = "neutral" | "success" | "danger" | "warn" | "info" | "brand" | "ai" | "muted";

const TONE: Record<Tone, string> = {
  neutral: "bg-divider text-body",
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
  warn: "bg-warn-soft text-warn-ink",
  info: "bg-info-soft text-info",
  brand: "bg-brand-soft text-brand-hover",
  ai: "bg-ai-soft text-ai",
  muted: "bg-canvas text-muted",
};

export function Pill({ tone = "neutral", children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cx("inline-flex h-5 items-center rounded-[10px] px-2 text-[11px] font-medium tracking-[0.02em] whitespace-nowrap", TONE[tone], className)}>
      {children}
    </span>
  );
}

export const STATUS_PILL: Record<string, [string, Tone]> = {
  in_progress: ["In progress", "neutral"],
  on_hold: ["On hold", "warn"],
  rejected: ["Rejected", "muted"],
  withdrawn: ["Withdrawn", "muted"],
  offer_declined: ["Offer declined", "muted"],
  hired: ["Hired", "success"],
  archived: ["Archived", "muted"],
};

export function StatusPill({ status, proposal, duplicate }: { status: string; proposal?: boolean; duplicate?: boolean }) {
  if (proposal) return <Pill tone="warn">Rejection proposed</Pill>;
  if (duplicate) return <Pill tone="warn">Possible duplicate</Pill>;
  const [l, t] = STATUS_PILL[status] ?? [status, "neutral"];
  return <Pill tone={t}>{l}</Pill>;
}

/** The ◈ marker — "an AI produced this". */
export function AiMark({ className }: { className?: string }) {
  return (
    <span aria-label="AI" title="Produced by AI — a person confirms it" className={cx("font-semibold text-ai-mid", className)}>
      ◈
    </span>
  );
}

/** A score in tabular figures, with the AI marker where AI produced it. */
export function ScoreChip({ value, ai, pass, title }: { value: number | null; ai?: boolean; pass?: number; title?: string }) {
  if (value == null) return <span className="text-faint">—</span>;
  const low = pass != null && value < pass;
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 font-semibold tabular-nums", low ? "text-danger" : "text-heading")}>
      {ai ? <AiMark /> : null}
      {Math.round(value)}
    </span>
  );
}

/* ----------------------------------------------------------------- buttons */

type BtnKind = "primary" | "secondary" | "ghost" | "danger";
const BTN: Record<BtnKind, string> = {
  primary: "border-transparent bg-brand text-white hover:bg-brand-hover",
  secondary: "border-line-strong bg-surface text-body hover:bg-canvas",
  ghost: "border-transparent bg-transparent text-brand-hover hover:bg-brand-soft",
  danger: "border-transparent bg-danger text-white hover:opacity-90",
};

export function btnClass(kind: BtnKind = "secondary", size: "md" | "sm" = "md", disabled = false) {
  return cx(
    "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[4px] border font-medium whitespace-nowrap no-underline transition-colors duration-100 hover:no-underline",
    size === "md" ? "h-9 px-3.5 text-sm" : "h-[30px] px-2.5 text-[13px]",
    disabled ? "cursor-not-allowed border-divider bg-canvas text-faint hover:bg-canvas" : BTN[kind],
  );
}

export function Btn({
  kind = "secondary",
  size = "md",
  disabled,
  title,
  onClick,
  type = "button",
  children,
  className,
}: {
  kind?: BtnKind;
  size?: "md" | "sm";
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  children: ReactNode;
  className?: string;
}) {
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} className={cx(btnClass(kind, size, disabled), className)}>
      {children}
    </button>
  );
}

export function BtnLink({ href, kind = "secondary", size = "md", children, className }: { href: string; kind?: BtnKind; size?: "md" | "sm"; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={cx(btnClass(kind, size), className)}>
      {children}
    </Link>
  );
}

/** An action a person may SEE but not take: drawn locked, saying which role would unlock it. */
export function Locked({ children, why, size = "md" }: { children: ReactNode; why: string; size?: "md" | "sm" }) {
  return (
    <span title={why} className={cx(btnClass("secondary", size, true))}>
      <Icon n="lock" s={14} />
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ layout */

export function PageHead({ title, sub, actions, back }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 max-w-[820px]">
        {back ? (
          <Link href={back.href} className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted no-underline hover:text-body">
            <Icon n="back" s={14} />
            {back.label}
          </Link>
        ) : null}
        <h1 className="m-0 text-[28px] leading-[34px] font-semibold tracking-[-0.01em] text-heading">{title}</h1>
        {sub ? <p className="mt-1.5 mb-0 text-sm leading-5 text-muted">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Panel({ title, sub, actions, children, className, pad = true }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx("rounded-[6px] border border-line bg-surface", className)}>
      {title ? (
        <header className="flex items-start justify-between gap-3 border-b border-divider px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="m-0 text-[15px] leading-5 font-semibold text-heading">{title}</h2>
            {sub ? <p className="mt-0.5 mb-0 text-[13px] leading-[18px] text-muted">{sub}</p> : null}
          </div>
          {actions ? <div className="flex flex-none items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={pad ? "p-5" : ""}>{children}</div>
    </section>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("text-xs leading-4 font-medium tracking-[0.04em] text-muted uppercase", className)}>{children}</div>;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[6px] border border-dashed border-line bg-surface px-6 py-12 text-center">
      <div className="text-[15px] font-semibold text-heading">{title}</div>
      {children ? <div className="mt-1.5 max-w-[460px] text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Callout({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <div className={cx("rounded-[4px] px-3 py-2.5 text-[13px] leading-[19px]", TONE[tone], tone === "ai" ? "border border-ai-line" : "", className)}>{children}</div>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "danger" | "warn" | "success" }) {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-5 py-4">
      <Label>{label}</Label>
      <div className={cx("mt-1.5 text-[28px] leading-[34px] font-semibold tabular-nums", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn-ink" : tone === "success" ? "text-success" : "text-heading")}>{value}</div>
      {sub ? <div className="mt-0.5 text-[13px] text-muted">{sub}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------- the AI treatment */

export type ConfWord = "High" | "Moderate" | "Low";

/**
 * The AI assessment card (design §5.1–§5.3). High: indigo strip. Moderate:
 * indigo plus an amber dot, "Review recommended". Low: an AMBER strip, the
 * score greyed, "Human scoring recommended". Insufficient: "Not scored" — a
 * short answer is never drawn as 0.
 */
export function AiCard({
  title = "AI assessment",
  confidence,
  insufficient,
  score,
  max,
  reasoning,
  children,
  footer,
  className,
}: {
  title?: string;
  confidence?: ConfWord | null;
  insufficient?: boolean;
  score?: number | null;
  max?: number;
  reasoning?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const low = confidence === "Low" && !insufficient;
  return (
    <div className={cx("overflow-hidden rounded-[6px] border bg-surface", low ? "border-warn-line" : "border-ai-line", className)}>
      <div className={cx("flex items-center justify-between gap-3 px-4 py-2 text-[13px] font-medium", low ? "bg-warn-soft text-warn-ink" : "bg-ai-soft text-ai")}>
        <span className="flex items-center gap-1.5">
          <span className={low ? "text-warn" : "text-ai-mid"}>◈</span>
          {title}
        </span>
        <span className="flex items-center gap-1.5">
          {insufficient ? (
            "Not scored"
          ) : confidence ? (
            <>
              {confidence === "Moderate" ? <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden /> : null}
              Confidence: {confidence}
              {confidence === "Moderate" ? <span className="font-normal text-warn-ink"> · Review recommended</span> : null}
              {low ? <span className="font-normal"> · Human scoring recommended</span> : null}
            </>
          ) : null}
        </span>
      </div>
      <div className="px-4 py-4">
        {score != null && !insufficient ? (
          <div className={cx("mb-2 text-[13px]", low ? "text-faint" : "text-muted")}>
            Score{" "}
            <span className={cx("text-[22px] font-semibold tabular-nums", low ? "text-faint" : "text-heading")}>{fmtScore(score)}</span>
            {max != null ? <span className="tabular-nums"> / {max}</span> : null}
          </div>
        ) : null}
        {reasoning ? <div className="text-sm leading-5 text-body">{reasoning}</div> : null}
        {children}
      </div>
      {footer ? <div className="flex flex-wrap items-center gap-2 border-t border-divider px-4 py-3">{footer}</div> : null}
    </div>
  );
}

/** What the candidate actually said: serif, left rule, verbatim — testimony, not system text. */
export function Quote({ children, caption, tier, className }: { children: ReactNode; caption?: ReactNode; tier?: "full" | "partial" | string; className?: string }) {
  return (
    <figure className={cx("m-0", className)}>
      <blockquote className="m-0 border-l-2 border-line-strong pl-3.5 font-[family-name:var(--font-evidence)] text-base leading-[26px] text-heading">“{children}”</blockquote>
      {caption ? (
        <figcaption className="mt-1 pl-3.5 text-[12px] leading-4 text-muted">
          {tier === "partial" ? "→ Partial: " : tier === "full" ? "→ Supports: " : ""}
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

export function EvidenceList({ spans, className }: { spans: { verbatim: string; criterion?: string; tier?: string; points?: number | null; source?: string }[]; className?: string }) {
  if (!spans.length) return null;
  return (
    <div className={cx("mt-4 border-t border-divider pt-3", className)}>
      <Label className="mb-3">Evidence</Label>
      <div className="flex flex-col gap-4">
        {spans.map((e, i) => (
          <Quote key={i} tier={e.tier} caption={[e.criterion || null, e.tier ? `${e.tier}${e.points != null ? `, ${e.points} pts` : ""}` : null, e.source || null].filter(Boolean).join(" · ")}>
            {e.verbatim}
          </Quote>
        ))}
      </div>
    </div>
  );
}

/** A small "◈ AI-extracted · 0.82" tag for a field the AI filled. */
export function AiField({ source, confidence }: { source: "ai" | "human"; confidence?: number | null }) {
  if (source === "human") return <Pill tone="neutral">Human</Pill>;
  const word: ConfWord = confidence == null ? "Low" : confidence >= 0.8 ? "High" : confidence >= 0.55 ? "Moderate" : "Low";
  return (
    <Pill tone={word === "Low" ? "warn" : "ai"} title={`AI-extracted · confidence ${word}`}>
      ◈ AI · {word}
    </Pill>
  );
}

/* ----------------------------------------------------------------- formats */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "07 Oct" — DD MMM, in IST. */
export function fd(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const s = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00+05:30` : d;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }).formatToParts(new Date(s));
  return `${parts.find((p) => p.type === "day")?.value} ${parts.find((p) => p.type === "month")?.value}`;
}

/** "07 Oct, 14:02" in IST. */
export function fdt(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d));
  return `${fd(d)}, ${t}`;
}

/** Hours in stage: "6h", "3d". */
export const hs = (h: number) => (h < 24 ? `${Math.max(1, Math.round(h))}h` : `${Math.floor(h / 24)}d`);

/** ₹ with Indian grouping, from paise. */
export function inr(paise: number | null | undefined): string {
  if (paise == null) return "—";
  const rupees = Math.round(paise / 100);
  const neg = rupees < 0;
  const t = String(Math.abs(rupees));
  const l3 = t.slice(-3);
  const rest = t.slice(0, -3);
  return `${neg ? "−" : ""}₹${rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + l3 : l3}`;
}

export const fmtScore = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export { MON };
