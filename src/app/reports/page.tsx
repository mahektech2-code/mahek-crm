import Link from "next/link";
import { money } from "@/lib/format";
import { today } from "@/lib/recompute";
import {
  REPORT_PERIOD_LABELS,
  comparableRange,
  sameRangeLastYear,
} from "@/lib/business-date";
import { HEALTH_BANDS, HEALTH_BAND_LABELS } from "@/lib/engines/inactivity";
import {
  filterOptions,
  ownerDashboard,
} from "@/lib/services/owner-dashboard-service";
import { Callout, Card, Progress } from "@/components/ui/primitives";
import { FilterBar } from "./filters";
import {
  BAND_TONE,
  KpiCard,
  Section,
  rangeLabel,
  readParams,
  withParams,
  type ReportQuery,
} from "./parts";

export const metadata = { title: "Reports - MahekOne" };

/**
 * The owner's five.
 *
 * They are not five reports. They are one funnel read at five points — new
 * business, what became of it, what an order was worth, how often one came,
 * and whether the customers it produced are still buying — which is why they
 * sit on one row in that order and why each of them opens the thing behind it.
 *
 * MARGIN IS ABSENT, deliberately and on two counts. The brief excludes it, and
 * the data could not answer it: `products.priceSource` is still `unset`, so a
 * cost here would be an invention on the one screen where a wrong number does
 * the most damage.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<ReportQuery>;
}) {
  const params = await searchParams;
  const now = await today();
  const { period, range, filters, custom } = readParams(params, now);

  const compared = comparableRange(range, period);
  const lastYear = sameRangeLastYear(range);

  const [data, options] = await Promise.all([
    ownerDashboard(range, compared, lastYear, now, filters),
    filterOptions(),
  ]);

  const link = (href: string) => withParams(href, params);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-[34px] font-semibold text-ink">
            {REPORT_PERIOD_LABELS[period]}
          </h1>
          <p className="mt-1 text-[13px] text-muted">
            {rangeLabel(range)} · measured against {rangeLabel(compared)}
          </p>
        </div>
      </div>

      <FilterBar
        options={options}
        period={period}
        from={custom.from}
        to={custom.to}
      />

      {/* ------------------------------------------------------ the five */}
      <div className="mb-4 flex flex-wrap gap-3">
        <KpiCard
          label="New leads"
          value={String(data.newLeads.current)}
          sub="opportunities created"
          change={data.newLeads.change}
          href={link("/reports/leads")}
        />
        <KpiCard
          label="Lead to order"
          value={
            data.conversion.current.ratePercent === null
              ? "—"
              : `${data.conversion.current.ratePercent}%`
          }
          sub={`${data.conversion.current.converted} of ${data.conversion.current.leads} ordered`}
          change={data.conversion.change}
          href={link("/reports/leads")}
        />
        <KpiCard
          label="Average bill size"
          value={
            data.billSize.current.averagePaise === null
              ? "—"
              : money(data.billSize.current.averagePaise)
          }
          sub={`over ${data.billSize.current.transactions} transactions`}
          change={data.billSize.change}
          href={link("/reports/sales")}
        />
        <KpiCard
          label="Orders per customer"
          value={
            data.frequency.current.perActiveCustomer === null
              ? "—"
              : String(data.frequency.current.perActiveCustomer)
          }
          sub={`${data.frequency.current.activeCustomers} customers ordered`}
          change={data.frequency.change}
          href={link("/reports/sales")}
        />
        <KpiCard
          label="Active customers"
          value={String(data.retention.counts.active)}
          sub={`${data.retention.share.active}% of ${data.retention.total} banded`}
          href={link("/reports/customers")}
        />
      </div>

      {/* An incomplete cohort is the single most misread figure here. */}
      {!data.conversion.current.windowClosed ? (
        <Callout tone="brand">
          <strong className="font-medium">
            This cohort has not finished.
          </strong>{" "}
          {data.conversion.current.stillOpen} of the{" "}
          {data.conversion.current.leads} leads created in this period are still
          inside their {data.conversion.current.windowDays}-day window, so the
          conversion rate can only rise from here. It is not a low rate, it is
          an unfinished one.
        </Callout>
      ) : null}

      {/* ------------------------------------------ management alerts, §27 */}
      {data.alerts.length ? (
        <Section
          title="Wants attention"
          subtitle="Raised against the period before, except conversion, which is measured against its own target — a rate that has been flat all year is a different problem to one that slipped this month."
        >
          <ul className="space-y-2">
            {data.alerts.map((a) => (
              <li key={a.key} className="flex items-start gap-2 text-[14px] leading-5">
                <span
                  className={
                    a.severity === "high"
                      ? "text-danger"
                      : a.severity === "good"
                        ? "text-success"
                        : "text-warn-ink"
                  }
                >
                  {a.severity === "good" ? "▲" : "●"}
                </span>
                <span className="text-ink">{a.message}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* ------------------------------------------------ customer health */}
      <Section
        title="Customer health"
        subtitle="Measured against each customer's OWN buying cycle, not a flat 30/60/90 — a fortnightly buyer and a twice-a-year buyer are both a quarter late at 1.25 of their own rhythm. It is the same reading the Call Log times its calls from."
        actions={
          <Link
            href={link("/reports/customers")}
            className="rounded-[4px] border border-line bg-surface px-2.5 py-1 text-[12px] text-body no-underline hover:bg-canvas hover:no-underline"
          >
            See the customers
          </Link>
        }
      >
        <div className="flex flex-wrap gap-3">
          {HEALTH_BANDS.map((band) => {
            const n = data.retention.counts[band];
            const before = data.previousRetention?.counts[band] ?? null;
            return (
              <Link
                key={band}
                href={withParams("/reports/customers", params, { band })}
                className="min-w-[150px] flex-1 rounded-[6px] border border-line bg-canvas px-4 py-3 no-underline hover:border-brand hover:no-underline"
              >
                <span
                  className={`inline-flex rounded-[9px] px-2 py-[3px] text-[11px] font-medium tracking-[0.03em] uppercase ${BAND_TONE[band]}`}
                >
                  {HEALTH_BAND_LABELS[band]}
                </span>
                <div className="mt-2 text-[22px] leading-7 font-semibold text-ink tabular-nums">
                  {n}
                </div>
                <div className="text-[12px] text-muted">
                  {data.retention.share[band]}% of the book
                  {before !== null ? ` · was ${before}` : ""}
                </div>
                <Progress
                  className="mt-2"
                  value={data.retention.share[band]}
                  tone={
                    band === "active"
                      ? "success"
                      : band === "at-risk"
                        ? "warn"
                        : band === "dormant"
                          ? "danger"
                          : "brand"
                  }
                />
              </Link>
            );
          })}
        </div>

        {data.previousRetention === null ? (
          <p className="mt-3 text-[12px] text-muted">
            There is no earlier reading to compare against yet. A band is a statement
            about a day and cannot be reconstructed afterwards, so the first
            comparison appears once tonight&rsquo;s snapshot has a month behind it.
          </p>
        ) : null}

        {(data.neverOrdered || data.defaultCycle) > 0 ? (
          <p className="mt-3 max-w-[760px] text-[12px] text-pretty text-muted">
            {data.neverOrdered > 0 ? (
              <>
                {data.neverOrdered} customer{data.neverOrdered === 1 ? "" : "s"} ha
                {data.neverOrdered === 1 ? "s" : "ve"} never ordered and so are in no
                band — they have not stopped buying, they have not started, and folding
                them into Active is how a retention figure flatters itself.
              </>
            ) : null}{" "}
            {data.defaultCycle > 0 ? (
              <>
                {data.defaultCycle} of the banded have no measured buying cycle yet and
                are judged against the configured default.
              </>
            ) : null}
          </p>
        ) : null}
      </Section>

      {/* ------------------------------------- lead and conversion, §27 */}
      <Section
        title="Leads and what became of them"
        subtitle={`Conversion follows a COHORT — the leads created in this period, and how many of them ordered within ${data.conversion.current.windowDays} days. Dividing this period's first orders by this period's leads would ask a lead created on the 29th to have ordered by the 31st.`}
        actions={
          <Link
            href={link("/reports/leads")}
            className="rounded-[4px] border border-line bg-surface px-2.5 py-1 text-[12px] text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Break it down
          </Link>
        }
      >
        <Funnel
          leads={data.conversion.current.leads}
          qualified={data.conversion.current.qualified}
          converted={data.conversion.current.converted}
          stillOpen={data.conversion.current.stillOpen}
        />
      </Section>

      {/* --------------------------------------- purchase behaviour, §27 */}
      <Section
        title="Customer purchase behaviour"
        subtitle="Average bill size is net of credit notes issued in the period — a credit note reduces the value and never the count, because it is not a sale that un-happened."
      >
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          <Figure
            label="Sales value"
            value={money(data.billSize.current.netValuePaise)}
            sub={
              data.billSize.current.creditNotePaise
                ? `${money(data.billSize.current.grossValuePaise)} billed, less ${money(data.billSize.current.creditNotePaise)} in credit notes`
                : "no credit notes in this period"
            }
          />
          <Figure
            label="Transactions"
            value={String(data.billSize.current.transactions)}
            sub="orders accounts have accepted"
          />
          <Figure
            label="Customers who ordered"
            value={String(data.frequency.current.activeCustomers)}
          />
          <Figure
            label="Orders each"
            value={
              data.frequency.current.perActiveCustomer === null
                ? "—"
                : String(data.frequency.current.perActiveCustomer)
            }
            sub="a thousand orders from 250 customers is a different business to a thousand from 900"
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          {data.frequency.current.segments.map((s) => (
            <Card key={s.segment} className="min-w-[160px] flex-1 px-4 py-3">
              <div className="text-[12px] text-muted">{s.label}</div>
              <div className="text-[20px] leading-7 font-semibold text-ink tabular-nums">
                {s.customers}
              </div>
            </Card>
          ))}
        </div>
      </Section>

      <p className="max-w-[860px] text-[13px] text-pretty text-muted">
        Every figure here reads the same tables the rest of MahekOne does — orders
        accounts have accepted, receipts they have confirmed, and the buying cycle the
        Call Log already times its calls from. That is the point of the dashboard being
        on the same database: the owner and the telecaller cannot be told two different
        things about one customer.
      </p>
    </div>
  );
}

/**
 * The funnel, as four bars rather than a diagram.
 *
 * §10 draws seven rungs; this book has four that are actually recorded — a
 * lead exists, some of them reached qualification, some ordered, and some are
 * still inside their window. Drawing the other three would be a picture of a
 * process rather than a report on one, with three stages permanently at zero
 * because nothing writes them.
 */
function Funnel({
  leads,
  qualified,
  converted,
  stillOpen,
}: {
  leads: number;
  qualified: number;
  converted: number;
  stillOpen: number;
}) {
  const rows = [
    { label: "Leads created", n: leads, tone: "brand" as const },
    { label: "Reached qualified (field leads only)", n: qualified, tone: "brand" as const },
    { label: "Placed a first order", n: converted, tone: "success" as const },
    { label: "Still inside their window", n: stillOpen, tone: "warn" as const },
  ];
  if (!leads) {
    return <p className="text-[13px] text-muted">No leads were created in this period.</p>;
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] text-body">{r.label}</span>
            <span className="text-[13px] text-ink tabular-nums">
              {r.n}
              <span className="ml-1.5 text-muted">
                {leads ? `${Math.round((r.n / leads) * 100)}%` : ""}
              </span>
            </span>
          </div>
          <Progress className="mt-1.5" value={(r.n / leads) * 100} tone={r.tone} />
        </div>
      ))}
    </div>
  );
}

function Figure({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="max-w-[260px]">
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </div>
      <div className="text-[22px] leading-7 font-semibold text-ink tabular-nums">
        {value}
      </div>
      {sub ? <div className="text-[12px] text-pretty text-muted">{sub}</div> : null}
    </div>
  );
}
