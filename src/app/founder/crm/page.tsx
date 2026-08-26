import Link from "next/link";
import { money } from "@/lib/format";
import { today } from "@/lib/recompute";
import { comparableRange, sameRangeLastYear } from "@/lib/business-date";
import { PageHeader } from "@/components/ui/primitives";
import { ownerDashboard } from "@/lib/services/owner-dashboard-service";
import { PeriodBar } from "../period-bar";
import { readPeriod, type FounderQuery } from "../period";

export const metadata = { title: "CRM - Founder Dashboard - MahekOne" };

/**
 * The order book's own five, and nothing rebuilt.
 *
 * This is deliberately the headline only — the Reports app already has the
 * cohort tables, the bill-size breakdown and the customer-health list behind
 * each of these, and a second copy of those screens here is exactly the
 * duplication this whole app was built to avoid. Every card opens the real
 * one.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<FounderQuery>;
}) {
  const params = await searchParams;
  const now = await today();
  const { period, range } = readPeriod(params, now);
  const compared = comparableRange(range, period);
  const lastYear = sameRangeLastYear(range);

  const data = await ownerDashboard(range, compared, lastYear, now, {});

  return (
    <div className="p-6">
      <PageHeader
        title="CRM"
        subtitle="The owner's five, read straight from the Reports app. Every card opens the full breakdown there."
      />

      <PeriodBar period={period} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Figure
          label="New leads"
          value={String(data.newLeads.current)}
          sub="opportunities created"
          href="/reports/leads"
        />
        <Figure
          label="Lead to order"
          value={data.conversion.current.ratePercent === null ? "—" : `${data.conversion.current.ratePercent}%`}
          sub={`${data.conversion.current.converted} of ${data.conversion.current.leads} ordered`}
          href="/reports/leads"
        />
        <Figure
          label="Average bill size"
          value={data.billSize.current.averagePaise === null ? "—" : money(data.billSize.current.averagePaise)}
          sub={`over ${data.billSize.current.transactions} transactions`}
          href="/reports/sales"
        />
        <Figure
          label="Orders per customer"
          value={data.frequency.current.perActiveCustomer === null ? "—" : String(data.frequency.current.perActiveCustomer)}
          sub={`${data.frequency.current.activeCustomers} customers ordered`}
          href="/reports/sales"
        />
        <Figure
          label="Active customers"
          value={String(data.retention.counts.active)}
          sub={`${data.retention.share.active}% of ${data.retention.total} banded`}
          href="/reports/customers"
        />
      </div>

      <p className="mt-4 max-w-[860px] text-[13px] text-pretty text-muted">
        This is the headline `ownerDashboard()` computes for the Reports app&rsquo;s own
        Overview — the cohort funnel, the bill-size trend and the customer-health list
        each of these is drawn from live behind the link, rather than rebuilt here.
      </p>

      <Link
        href="/reports"
        className="mt-3 inline-block rounded-[4px] border border-line bg-surface px-3 py-1.5 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
      >
        Open Reports
      </Link>
    </div>
  );
}

function Figure({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string;
  sub: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="block rounded-[6px] border border-line bg-surface px-5 py-4 no-underline transition-colors hover:border-brand hover:no-underline"
    >
      <div className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
        {label}
      </div>
      <div className="mt-1 text-[26px] leading-8 font-semibold tabular-nums text-ink">{value}</div>
      <div className="mt-0.5 text-[12px] text-muted">{sub}</div>
    </Link>
  );
}
