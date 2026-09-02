import Link from "next/link";
import { money } from "@/lib/format";
import { today } from "@/lib/recompute";
import { comparableRange, sameRangeLastYear } from "@/lib/business-date";
import { PageHeader, Callout } from "@/components/ui/primitives";
import { StatCard } from "@/components/ui/stat-card";
import { founderOverview } from "@/lib/services/founder-dashboard-service";
import { PeriodBar } from "./period-bar";
import { readPeriod, type FounderQuery } from "./period";

export const metadata = { title: "Founder Dashboard - MahekOne" };

/**
 * The whole company, on one screen.
 *
 * Five tiles, one per app this rolls up — revenue and conversion from the
 * CRM's order book, the team scored, what is owed, and the roster — each
 * opening the tab behind it. Nothing here is computed twice: every figure is
 * `ownerDashboard()`, `readingsForPeriod()`, `accountsHome()` or
 * `employeeMaster()`, read once in `founder-dashboard-service.ts`.
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

  const data = await founderOverview(range, compared, lastYear, now, now.slice(0, 7));

  const scoredTeam = data.team.ranked.filter((r) => r.rank !== null);
  const averageScore = scoredTeam.length
    ? Math.round(
        scoredTeam.reduce((sum, r) => sum + r.totalBp, 0) / scoredTeam.length,
      ) / 100
    : null;
  const top3 = scoredTeam.slice(0, 3);
  const priceRisk = data.team.ranked.filter((r) =>
    r.alerts.some((a) => a.key === "price-not-volume"),
  );

  return (
    <div className="p-6">
      <PageHeader
        title="Company"
        subtitle="Every app this company runs on, rolled up. Each tile opens the app it comes from."
      />

      <PeriodBar period={period} />

      <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(216px,1fr))] gap-4">
        <StatCard
          href="/founder/crm"
          label="Company revenue"
          value={money(data.crm.billSize.current.netValuePaise)}
          foot={`${data.crm.billSize.current.transactions} orders`}
        />
        <StatCard
          href="/founder/crm"
          label="Lead to order"
          value={
            data.crm.conversion.current.ratePercent === null
              ? "—"
              : `${data.crm.conversion.current.ratePercent}%`
          }
          foot={`${data.crm.conversion.current.converted} of ${data.crm.conversion.current.leads} leads ordered`}
        />
        <StatCard
          href="/founder/team"
          label="Team score"
          value={averageScore === null ? "—" : averageScore.toFixed(1)}
          suffix={averageScore === null ? undefined : " avg"}
          foot={`${data.team.scored} of ${data.team.total} scored this month`}
        />
        <StatCard
          href="/founder/money"
          label="Outstanding"
          value={money(data.money.aging.total)}
          foot={`${data.money.aging.bills} bills open`}
        />
        <StatCard
          href="/founder/people"
          label="Headcount"
          value={String(data.people.active)}
          foot={`${data.people.total} on the books`}
        />
      </div>

      {priceRisk.length > 0 ? (
        <Callout tone="warn">
          <span className="text-[13px] text-ink">
            {priceRisk.length === 1
              ? `${priceRisk[0].userName} is at target on revenue but not on volume this month.`
              : `${priceRisk.length} people are at target on revenue but not on volume this month.`}{" "}
            <Link href="/founder/team" className="font-medium text-brand no-underline">
              See the team
            </Link>
          </span>
        </Callout>
      ) : null}

      {data.crm.alerts.length ? (
        <div className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
          <h2 className="mb-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Wants attention — the order book
          </h2>
          <ul className="space-y-2">
            {data.crm.alerts.map((a) => (
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
        </div>
      ) : null}

      <div className="rounded-[6px] border border-line bg-surface px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Top of the team this month
          </h2>
          <Link
            href="/founder/team"
            className="rounded-[4px] border border-line bg-surface px-2.5 py-1 text-[12px] text-body no-underline hover:bg-canvas hover:no-underline"
          >
            See everyone
          </Link>
        </div>
        {top3.length === 0 ? (
          <p className="text-[13px] text-muted">
            Nobody holds a published target for this month yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {top3.map((r) => (
              <li key={r.userId} className="flex items-baseline justify-between gap-3 text-[14px]">
                <span className="text-ink">
                  <span className="mr-2 text-muted tabular-nums">#{r.rank}</span>
                  {r.userName}
                </span>
                <span className="tabular-nums text-muted">
                  {(r.totalBp / 100).toFixed(1)} · {r.rating}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-4 max-w-[860px] text-[13px] text-pretty text-muted">
        Every figure here reads the same tables Reports, the Sales Dashboard, Accounts
        and HRMS already read — nothing is recomputed for this screen. Company revenue
        and lead conversion are the CRM&rsquo;s order book; the team score is
        `readingsForPeriod`, the same reading `/sales/performance` shows a manager for
        their own team; outstanding and headcount are read live from Accounts and HRMS.
      </p>
    </div>
  );
}
