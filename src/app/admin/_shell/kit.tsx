import Link from "next/link";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * THE CANVAS'S PIECES, as the Admin Console draws them (Nov 2026).
 *
 * Every console screen is drawn to the "Admin Console v4 redesign" canvas, and
 * these are its shared parts — the figure card, the white card with its
 * header row, the tab with its count, the pill, the button, the navy-headed
 * table — so one screen and the next cannot drift by a pixel of padding.
 * Numbers are the canvas's own: cards 8px, controls 7px, 36px buttons, 40px
 * rows, 12px navy table heads, 13px body.
 * ------------------------------------------------------------------------- */

export type Tone = "ok" | "warn" | "danger" | "info" | "brand" | "muted";

const PILL: Record<Tone, string> = {
  ok: "bg-success-soft text-success",
  warn: "bg-warn-soft text-warn-ink",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  brand: "bg-brand-soft text-brand-deep",
  muted: "bg-[#eef1f6] text-[#4a5670]",
};

const DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
  brand: "bg-brand",
  muted: "bg-faint",
};

/** A status pill: 22px, round, 12px semibold. */
export function Pill({ tone = "muted", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex h-[22px] items-center gap-[5px] rounded-full px-2 text-xs font-semibold whitespace-nowrap", PILL[tone])}>
      {children}
    </span>
  );
}

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cx("inline-block h-2 w-2 flex-none rounded-full", DOT[tone], className)} />;
}

/* ----------------------------------------------------------------- figures */

export type Figure = {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** A status dot before the label. */
  dot?: Tone;
  /** Colours the figure itself — amber or red where it is a count of trouble. */
  tone?: "warn" | "danger" | "ok";
  /** The one navy card: the number that matters on this screen. */
  navy?: boolean;
  /** The card is a link. */
  href?: string;
};

/** Figure cards above a screen: as many as fit at 170px, then they wrap. */
export function Figures({ items, min = 170 }: { items: Figure[]; min?: number }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` }}>
      {items.map((f) => {
        const body = (
          <>
            <span className={cx("flex min-w-0 items-center gap-1.5 text-xs font-medium", f.navy ? "text-[#c9d1e3]" : "text-muted")}>
              {f.dot ? <Dot tone={f.dot} /> : null}
              <span className="truncate">{f.label}</span>
            </span>
            <span
              className={cx(
                "truncate text-[22px] leading-8 font-bold tracking-[-0.02em] tabular-nums",
                f.navy ? "text-white" : f.tone === "warn" ? "text-warn-ink" : f.tone === "danger" ? "text-danger" : f.tone === "ok" ? "text-success" : "text-ink",
              )}
            >
              {f.value}
            </span>
            {f.sub ? <span className={cx("truncate text-xs", f.navy ? "text-brand-lime" : "text-muted")}>{f.sub}</span> : null}
          </>
        );
        const cls = cx(
          "flex min-w-0 flex-col gap-0.5 rounded-card border px-3.5 py-3 no-underline hover:no-underline",
          f.navy ? "border-ink bg-ink" : "border-line bg-surface",
          f.href && !f.navy && "hover:border-line-strong",
        );
        return f.href ? (
          <Link key={f.label} href={f.href} className={cls}>
            {body}
          </Link>
        ) : (
          <div key={f.label} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------- cards */

/** The white card. `flush` drops the clip for a card whose popovers must escape it. */
export function Card({ children, className, flush = false }: { children: React.ReactNode; className?: string; flush?: boolean }) {
  return <section className={cx("min-w-0 rounded-card border border-line bg-surface", !flush && "overflow-hidden", className)}>{children}</section>;
}

/** A card's header row: 15px bold title, then whatever follows it, actions pushed right. */
export function CardHead({ title, children, actions }: { title: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-divider px-4 py-3">
      <h2 className="m-0 text-[15px] font-bold text-ink">{title}</h2>
      {children}
      <span className="flex-1" />
      {actions}
    </div>
  );
}

/** A row in a card's list: 11px by 16px, a hairline between. */
export function ListRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("flex items-center gap-3 border-b border-divider px-4 py-[11px] last:border-b-0", className)}>{children}</div>;
}

/* ------------------------------------------------------------------ buttons */

const BTN = "inline-flex items-center gap-1.5 rounded-control border font-semibold whitespace-nowrap no-underline hover:no-underline cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

export function btnClass(kind: "primary" | "plain" | "danger" = "plain", size: "md" | "sm" = "md") {
  return cx(
    BTN,
    size === "sm" ? "h-[30px] px-2.5 text-xs" : "h-9 px-3.5 text-[13px]",
    kind === "primary"
      ? "border-brand bg-brand text-white hover:bg-brand-hover hover:text-white"
      : kind === "danger"
        ? "border-danger bg-surface text-danger hover:bg-danger-soft"
        : "border-line-strong bg-surface text-ink hover:bg-[#f7f9fc]",
  );
}

export function BtnLink({ href, children, kind = "plain", size = "md" }: { href: string; children: React.ReactNode; kind?: "primary" | "plain" | "danger"; size?: "md" | "sm" }) {
  return (
    <Link href={href} className={btnClass(kind, size)}>
      {children}
    </Link>
  );
}

/* --------------------------------------------------------------------- tabs */

export type TabItem = { slug: string; label: string; href: string; count?: number | null };

/** Tabs that are links: 26px apart, the live one inked with a brand underline, a count chip beside. */
export function Tabs({ items, active }: { items: readonly TabItem[]; active: string }) {
  return (
    <nav aria-label="Tabs" className="flex flex-wrap gap-x-[26px] border-b border-line">
      {items.map((t) => {
        const on = t.slug === active;
        return (
          <Link
            key={t.slug}
            href={t.href}
            aria-current={on ? "page" : undefined}
            className={cx(
              "-mb-px flex items-center gap-1.5 border-b-2 py-2.5 text-[13px] font-semibold whitespace-nowrap no-underline hover:no-underline",
              on ? "border-brand text-ink" : "border-transparent text-muted hover:text-body",
            )}
          >
            {t.label}
            {t.count != null ? (
              <span className="rounded-full bg-[#eef1f6] px-[7px] py-px text-[11px] font-semibold text-[#4a5670]">{t.count}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------- tables */

/** A table the canvas's way: navy 12px heads, 40px rows, a hairline between, no wrap. */
export function DataTable({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cx("admin-table w-full border-collapse text-[13px]", className)}>{children}</table>
    </div>
  );
}

export function TH({ children, className, align }: { children?: React.ReactNode; className?: string; align?: "left" | "right" | "center" }) {
  return (
    <th
      className={cx(
        "bg-ink px-3 py-[9px] text-xs font-semibold whitespace-nowrap text-white normal-case",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({ children, className, align, colSpan }: { children?: React.ReactNode; className?: string; align?: "left" | "right" | "center"; colSpan?: number }) {
  return (
    <td
      colSpan={colSpan}
      className={cx(
        "h-10 border-b border-divider px-3 py-2 align-middle",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Mono, for setting keys, ids and builds. */
export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cx("font-mono text-xs", className)}>{children}</span>;
}

/** Initials in a round lavender disc — the canvas's avatar. */
export function Avatar({ name, size = 28, tone = "brand" }: { name: string; size?: number; tone?: "brand" | "ok" | "navy" }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size <= 28 ? 11 : 13 }}
      className={cx(
        "inline-flex flex-none items-center justify-center rounded-full font-bold",
        tone === "ok" ? "bg-success-soft text-success" : tone === "navy" ? "bg-ink text-brand-lime" : "bg-brand-softer text-brand-deep",
      )}
    >
      {initials}
    </span>
  );
}
