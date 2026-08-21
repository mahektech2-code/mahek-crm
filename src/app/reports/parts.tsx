import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import type { Change } from "@/lib/engines/owner-kpis";
import {
  isReportPeriod,
  reportRange,
  type BusinessDate,
  type DateRange,
  type ReportPeriod,
} from "@/lib/business-date";
import type { OwnerFilters } from "@/lib/services/owner-dashboard-service";

/* ---------------------------------------------------------------------------
 * The pieces the four Reports screens share.
 *
 * `readParams` is the important one: four server components have to turn the
 * same query string into the same range and the same filters, and four copies
 * of that parsing is four chances for the overview and its own drill-down to
 * disagree about what month is being shown.
 * ------------------------------------------------------------------------- */

export type ReportQuery = {
  period?: string;
  from?: string;
  to?: string;
  salesman?: string;
  salesManager?: string;
  region?: string;
  city?: string;
  customerType?: string;
  distributor?: string;
  customer?: string;
  /** Which health band the customer list is narrowed to. */
  band?: string;
};

export function readParams(
  params: ReportQuery,
  today: BusinessDate,
): {
  period: ReportPeriod;
  range: DateRange;
  filters: OwnerFilters;
  custom: { from: string; to: string };
} {
  const period: ReportPeriod = isReportPeriod(params.period) ? params.period : "month";
  const isDate = (v: string | undefined): v is string =>
    !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

  const custom = {
    from: isDate(params.from) ? params.from : today,
    to: isDate(params.to) ? params.to : today,
  };
  // A range typed backwards is swapped rather than refused. Somebody picking
  // the second date first is the ordinary way it happens, and an empty screen
  // reads as no data rather than as two boxes in the wrong order.
  const range = reportRange(
    today,
    period,
    custom.from <= custom.to
      ? { from: custom.from, to: custom.to }
      : { from: custom.to, to: custom.from },
  );

  return {
    period,
    range,
    custom,
    filters: {
      salesmanId: params.salesman || undefined,
      salesManagerId: params.salesManager || undefined,
      region: params.region || undefined,
      city: params.city || undefined,
      customerType: params.customerType || undefined,
      distributorId: params.distributor || undefined,
      customerId: params.customer || undefined,
    },
  };
}

/** Carry the current filters onto a link, so a drill-down keeps its context. */
export function withParams(href: string, params: ReportQuery, extra: Record<string, string> = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...extra })) {
    if (v) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${href}?${s}` : href;
}

/* -------------------------------------------------------------------- KPI */

/**
 * One of the five, with what it was against.
 *
 * Clickable, always — §23 is explicit that every KPI opens the thing behind
 * it, and a headline figure somebody cannot get behind is a number they have
 * to take on trust.
 */
export function KpiCard({
  label,
  value,
  sub,
  change,
  href,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  change?: Change;
  href: string;
  tone?: "good" | "bad";
}) {
  return (
    <Link
      href={href}
      className="block flex-1 rounded-[6px] border border-line bg-surface px-5 py-4 no-underline transition-colors hover:border-brand hover:no-underline"
    >
      <div className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span
          className={cx(
            "text-[26px] leading-8 font-semibold tabular-nums",
            tone === "bad" ? "text-danger" : tone === "good" ? "text-success" : "text-ink",
          )}
        >
          {value}
        </span>
        {change ? <ChangePill change={change} /> : null}
      </div>
      {sub ? <div className="mt-0.5 text-[12px] text-muted">{sub}</div> : null}
    </Link>
  );
}

/**
 * How a figure moved, in the unit it should be SAID.
 *
 * A rate that went 12.5% → 14.8% rose 2.3 POINTS, not 18.4%, and printing the
 * second is the commonest way a dashboard flatters itself. The engine decides
 * which unit applies; this only renders it, and prints "pp" so the reader can
 * see which they are looking at.
 */
export function ChangePill({ change }: { change: Change }) {
  if (change.value === null) {
    return (
      <span className="text-[12px] text-muted" title="Nothing in the period before to compare against.">
        no comparison
      </span>
    );
  }
  if (change.direction === "flat") {
    return <span className="text-[12px] text-muted">no change</span>;
  }
  const up = change.direction === "up";
  return (
    <span
      className={cx("text-[13px] font-medium", up ? "text-success" : "text-danger")}
    >
      {up ? "↑" : "↓"} {Math.abs(change.value)}
      {change.kind === "points" ? " pp" : "%"}
    </span>
  );
}

export function Section({
  title,
  subtitle,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-1 max-w-[720px] text-[12px] text-pretty text-muted">
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export const BAND_TONE: Record<string, string> = {
  active: "bg-success-soft text-success",
  "at-risk": "bg-warn-soft text-warn-ink",
  dormant: "bg-danger-soft text-danger",
  lost: "bg-divider text-body",
};

/** Two dates, said plainly. A comparison nobody can see the span of is a claim. */
export function rangeLabel(range: DateRange): string {
  const fmt = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(y, m - 1, day)));
  };
  return range.from === range.to ? fmt(range.from) : `${fmt(range.from)} – ${fmt(range.to)}`;
}
