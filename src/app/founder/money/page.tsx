import Link from "next/link";
import { money } from "@/lib/format";
import { Card, MetricStrip, PageHeader, Progress } from "@/components/ui/primitives";
import { founderMoney } from "@/lib/services/founder-dashboard-service";

export const metadata = { title: "Money - Founder Dashboard - MahekOne" };

/**
 * The founder's-eye view of Accounts — `accountsHome()`, unchanged, which is
 * already company-wide (Accounts has no My book / Team split), rendered as
 * headline tiles instead of a worklist. Accounts' own Today screen is where
 * any of this is actually acted on.
 */
export default async function Page() {
  const data = await founderMoney();

  return (
    <div className="p-6">
      <PageHeader
        title="Money"
        subtitle="What is outstanding, what is waiting on a decision, and what has been collected — read straight from Accounts."
        actions={
          <Link
            href="/accounts"
            className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Open Accounts
          </Link>
        }
      />

      <MetricStrip
        metrics={[
          { label: "Outstanding", value: money(data.aging.total), sub: `${data.aging.bills} bills open` },
          {
            label: "Orders to approve",
            value: String(data.orders.count),
            sub: data.orders.count ? money(data.orders.value) : undefined,
            tone: data.orders.stale ? "danger" : undefined,
          },
          {
            label: "Payments to confirm",
            value: String(data.payments.count),
            sub: data.payments.count ? money(data.payments.value) : undefined,
            tone: data.payments.stale ? "danger" : undefined,
          },
          { label: "Credit note requests", value: String(data.credits.count), sub: data.credits.count ? money(data.credits.value) : undefined },
          { label: "Collected this month", value: money(data.money.confirmedThisMonth), sub: `${data.money.confirmedThisMonthCount} receipts, confirmed only` },
          { label: "On account", value: money(data.money.onAccount), sub: "received, not yet pointed at a bill" },
        ]}
      />

      <Card className="px-5 py-4">
        <h2 className="mb-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Aging across the book
        </h2>
        {data.aging.buckets.length === 0 ? (
          <p className="text-[13px] text-muted">No bills carry an unconfirmed balance right now.</p>
        ) : (
          <div className="space-y-3">
            {data.aging.buckets.map((b) => (
              <div key={b.label}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-body">{b.label}</span>
                  <span className="text-[13px] text-ink tabular-nums">
                    {money(b.amount)}
                    <span className="ml-1.5 text-muted">
                      {data.aging.total ? `${Math.round((b.amount / data.aging.total) * 100)}%` : ""}
                    </span>
                  </span>
                </div>
                <Progress
                  className="mt-1.5"
                  value={data.aging.total ? (b.amount / data.aging.total) * 100 : 0}
                  tone={b.from <= 0 ? "success" : b.from < 30 ? "brand" : b.from < 90 ? "warn" : "danger"}
                />
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 max-w-[760px] text-[12px] text-pretty text-muted">
          Only bills accounts have taken a position on count here — a bill nobody has
          stated paid or owed is not late, it is unknown, and is held out of this total
          rather than counted as debt.
        </p>
      </Card>

      <p className="mt-4 max-w-[860px] text-[13px] text-pretty text-muted">
        Confirmed money only, everywhere on this page. A payment a telecaller reported
        counts towards &ldquo;payments to confirm&rdquo; and nowhere else until accounts find it
        in the bank.
      </p>
    </div>
  );
}
