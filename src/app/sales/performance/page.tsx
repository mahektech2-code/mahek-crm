import Link from "next/link";
import { MonthNav } from "@/components/ui/month-nav";
import { ExportMenu } from "@/components/ui/export-menu";
import { monthName } from "@/components/ui/month";
import { money, moneyShort } from "@/lib/format";
import {
  activityLine,
  bpPercent,
  collectionLine,
  NOTHING_OVERDUE,
  shareBp,
} from "@/lib/performance-labels";
import { PersonPerformanceButton } from "./person-performance";
import { ratingTone } from "./rating-tone";
import { today } from "@/lib/recompute";
import { BP } from "@/lib/engines/performance";
import {
  readingsForPeriod,
  unattributedForPeriod,
} from "@/lib/services/performance-service";
import {
  Banner,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  RowMenu,
  ScreenHeader,
  Table,
} from "@/components/console/parts";

export const metadata = { title: "Performance — Sales Dashboard — MahekOne" };

/**
 * The month, per person, scored.
 *
 * This screen used to carry a banner saying no targets existed for the field
 * and that a percentage here would be invented. That was true and is not any
 * more: `sales_targets` sets one per PERSON, and every figure below is
 * measured against what somebody actually asked for. Where a target was not
 * set the column still says so rather than showing a zero — the old rule
 * survives, it just applies to fewer cells.
 *
 * **The two columns to read together are Revenue and Volume.** A price
 * revision moves the first and cannot move the second, so revenue at target
 * with volume well below it is the month somebody would otherwise be
 * congratulated for. That comparison is the reason this screen exists in this
 * shape, and it is why the alert column is not at the far right where it would
 * be scrolled past.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const month = /^\d{4}-\d{2}$/.test(params.month ?? "")
    ? params.month!
    : now.slice(0, 7);

  const [rows, orphaned] = await Promise.all([
    readingsForPeriod(month, now),
    unattributedForPeriod(month),
  ]);

  const totals = rows.reduce(
    (a, r) => ({
      revenue: a.revenue + r.actuals.revenuePaise,
      millilitres: a.millilitres + r.actuals.millilitres,
      collected: a.collected + r.actuals.collectionPaise,
      overdue: a.overdue + r.actuals.overdueAtStartPaise,
      newCustomers: a.newCustomers + r.actuals.newCustomers,
      unmatched: a.unmatched + r.unmatchedPaise,
    }),
    { revenue: 0, millilitres: 0, collected: 0, overdue: 0, newCustomers: 0, unmatched: 0 },
  );

  const days = rows[0];
  const priceRisk = rows.filter((r) =>
    r.alerts.some((a) => a.key === "price-not-volume"),
  );

  return (
    <div className="p-6">
      <ScreenHeader
        title="Performance"
        subtitle={`${monthName(month)} · scored out of 100 · click a name for detail`}
        actions={
          <div className="flex items-center gap-1 text-[13px]">
            <Link
              href={`/sales/targets?period=${month}`}
              className="mr-2 rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              ← Back to targets
            </Link>
            <MonthNav month={month} basePath="/sales/performance" />
            <span className="ml-2">
              <ExportMenu
                name={`Performance, ${monthName(month)}`}
                csv={[
                  [
                    "Person",
                    "Score (of 100)",
                    "Rating",
                    "Revenue excl. GST (Rs)",
                    "Revenue achieved (%)",
                    "Volume (L)",
                    "Volume achieved (%)",
                    "Mix achieved (%)",
                    "New customers",
                    "Collected (Rs)",
                    "Overdue at start (Rs)",
                    "Collected of overdue (%)",
                    "Collection achieved (%)",
                    "Activity",
                    "Activity achieved (%)",
                    "Wants attention",
                  ],
                  ...rows.map((r) => {
                    const by = (k: string) => {
                      const bp = r.score.components.find((c) => c.key === k)?.achievementBp;
                      return bp === null || bp === undefined ? "" : Math.round(bp / 100);
                    };
                    return [
                      r.userName,
                      r.hasTarget ? (r.score.totalBp / 100).toFixed(1) : "",
                      r.hasTarget ? r.rating : "No target set",
                      Math.round(r.actuals.revenuePaise / 100),
                      by("revenue"),
                      Math.round(r.actuals.millilitres / 1000),
                      by("volume"),
                      r.mix.achievementBp === null ? "" : Math.round(r.mix.achievementBp / 100),
                      r.actuals.newCustomers,
                      Math.round(r.actuals.collectionPaise / 100),
                      Math.round(r.actuals.overdueAtStartPaise / 100),
                      r.actuals.overdueAtStartPaise > 0
                        ? Math.round((r.actuals.collectionPaise / r.actuals.overdueAtStartPaise) * 100)
                        : "",
                      by("collection"),
                      r.actuals.activity,
                      by("activity"),
                      r.alerts.map((a) => a.message).join(" | "),
                    ];
                  }),
                ]}
              />
            </span>
          </div>
        }
      />

      {priceRisk.length > 0 ? (
        <Banner
          tone="warn"
          title={
            priceRisk.length === 1
              ? `${priceRisk[0].userName} is at target on revenue but not on volume`
              : `${priceRisk.length} people are at target on revenue but not on volume`
          }
        />
      ) : null}

      {orphaned.revenuePaise > 0 ? (
        <Banner
          tone="info"
          title={`${money(orphaned.revenuePaise)} from ${orphaned.customers} ${orphaned.customers === 1 ? "customer" : "customers"} with no salesperson counts towards nobody`}
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Revenue excl. GST", value: money(totals.revenue) },
          {
            label: "Volume",
            value: litres(totals.millilitres),
            sub: totals.unmatched
              ? `${moneyShort(totals.unmatched)} unmatched`
              : undefined,
          },
          {
            // A SHARE, because that is what collection is asked as: the old
            // debt the team worked down, of what was overdue when the month
            // opened. The rupees are the line under it.
            label: "Collection",
            value: bpPercent(shareBp({ done: totals.collected, base: totals.overdue })),
            sub: totals.overdue > 0
              ? collectionLine({ done: totals.collected, base: totals.overdue }, moneyShort)
              : NOTHING_OVERDUE,
          },
          { label: "New customers", value: String(totals.newCustomers) },
          {
            label: "Working days",
            value: days ? `${days.workingDaysElapsed} of ${days.workingDaysTotal}` : "—",
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="Nobody to score yet"
          body="No published targets and no sales this month."
        />
      ) : (
        <>
          {/*
            FITS BESIDE THE SIDEBAR AT 1280, with no sideways scroll. It was
            eleven columns over 1,324px, so on a laptop the alert column —
            the one this screen exists to show — sat off the right-hand edge.
            Each figure now carries its achievement UNDER it rather than beside
            it, the rating sits under the score, and what wants attention sits
            under the name, where it is read with the person it is about.
          */}
          <Table
            minWidth={936}
            head={
              <>
                <HeadCell width={230}>Person</HeadCell>
                <HeadCell align="right" width={100}>Score</HeadCell>
                <HeadCell align="right" width={130}>Revenue</HeadCell>
                <HeadCell align="right" width={100}>Volume</HeadCell>
                <HeadCell align="right" width={64}>Mix</HeadCell>
                <HeadCell align="right" width={64}>New</HeadCell>
                <HeadCell align="right" width={100}>Collection</HeadCell>
                <HeadCell align="right" width={84}>Tasks</HeadCell>
                <HeadCell width={64} />
              </>
            }
          >
            {rows.map((r, i) => {
              const comp = (k: string) => r.score.components.find((c) => c.key === k);
              const by = (k: string) => comp(k)?.achievementBp ?? null;
              const revenue = by("revenue");
              const volume = by("volume");
              const diverging =
                revenue !== null && volume !== null && revenue >= BP && volume < BP;
              /* Collection is asked as a SHARE of the old debt, so it is
                 shown as one: collected ÷ overdue when the month opened, with
                 the share that was asked under it. */
              const base = r.actuals.overdueAtStartPaise;
              const collectedBp = shareBp({ done: r.actuals.collectionPaise, base });
              const collectionAsk = comp("collection")?.target ?? 0;
              const askedBp = base > 0 && collectionAsk > 0 ? Math.round((collectionAsk * BP) / base) : null;
              const tasksBp = shareBp({ done: r.actuals.activity, base: r.actuals.activityAssigned });
              const tasksAsk = comp("activity")?.target ?? 0;
              const tasksAskedBp =
                r.actuals.activityAssigned > 0 && tasksAsk > 0
                  ? Math.round((tasksAsk * BP) / r.actuals.activityAssigned)
                  : null;

              return (
                <Row key={r.userId} striped={i % 2 === 1}>
                  <Cell>
                    <PersonPerformanceButton
                      userId={r.userId}
                      name={r.userName}
                      month={month}
                      today={now}
                    />
                    {r.alerts.length ? (
                      <span
                        className="block truncate text-[12px] text-warn-ink"
                        title={r.alerts.map((a) => a.message).join("\n")}
                      >
                        {r.alerts[0].message}
                        {r.alerts.length > 1 ? ` (+${r.alerts.length - 1})` : ""}
                      </span>
                    ) : null}
                  </Cell>
                  <Cell align="right">
                    {r.hasTarget ? (
                      <>
                        <span className="block font-medium text-ink tabular-nums">
                          {(r.score.totalBp / 100).toFixed(1)}
                        </span>
                        <Pill tone={ratingTone(r.score.totalBp)}>{r.rating}</Pill>
                      </>
                    ) : (
                      <span
                        className="text-[12px] text-muted"
                        title="Nothing has been asked of this person for this month, so there is nothing to score them against."
                      >
                        no target
                      </span>
                    )}
                  </Cell>
                  <Cell align="right">
                    <Stacked
                      value={moneyShort(r.actuals.revenuePaise)}
                      title={money(r.actuals.revenuePaise)}
                      sub={bpOf(revenue)}
                      tone={subTone(revenue, diverging)}
                    />
                  </Cell>
                  <Cell align="right">
                    <Stacked
                      value={litres(r.actuals.millilitres)}
                      sub={bpOf(volume)}
                      tone={subTone(volume, diverging)}
                    />
                  </Cell>
                  <Cell align="right">
                    <Stacked value={bpPercent(r.mix.achievementBp)} />
                  </Cell>
                  <Cell align="right">
                    <Stacked
                      value={String(r.actuals.newCustomers)}
                      sub={bpOf(by("newCustomers"))}
                      tone={subTone(by("newCustomers"), false)}
                    />
                  </Cell>
                  <Cell align="right">
                    <Stacked
                      value={collectedBp === null ? "—" : bpPercent(collectedBp)}
                      title={collectionLine(
                        { done: r.actuals.collectionPaise, base },
                        money,
                      )}
                      sub={
                        askedBp !== null
                          ? `target ${bpPercent(askedBp)}`
                          : base > 0
                            ? `of ${moneyShort(base)}`
                            : "none overdue"
                      }
                      tone={askedBp !== null ? subTone(by("collection"), false) : "muted"}
                    />
                  </Cell>
                  <Cell align="right">
                    <Stacked
                      value={tasksBp === null ? "—" : bpPercent(tasksBp)}
                      title={activityLine({ done: r.actuals.activity, base: r.actuals.activityAssigned })}
                      sub={
                        r.actuals.activityAssigned > 0
                          ? `${r.actuals.activity} of ${r.actuals.activityAssigned}`
                          : "none set"
                      }
                      tone={tasksAskedBp !== null ? subTone(by("activity"), false) : "muted"}
                    />
                  </Cell>
                  <Cell align="right">
                    <RowMenu
                      items={[
                        { label: "Open their record", href: `/sales/people/${r.userId}` },
                        { label: "Set their target", href: `/sales/targets?period=${month}` },
                        { label: "Assign a task", href: "/sales/tasks" },
                      ]}
                    />
                  </Cell>
                </Row>
              );
            })}
          </Table>

        </>
      )}
    </div>
  );
}

/**
 * A figure and, under it, what it is against.
 *
 * Stacked rather than side by side so every column stays narrow enough for
 * the table to fit beside the sidebar. The second line is the achievement
 * against what was asked — or, for the two shares, what the share is of.
 */
function Stacked({
  value,
  sub,
  title,
  tone = "muted",
}: {
  value: string;
  sub?: string;
  title?: string;
  tone?: "success" | "warn" | "muted";
}) {
  return (
    <span className="block tabular-nums" title={title}>
      <span className="block text-ink">{value}</span>
      {sub ? (
        <span
          className={
            tone === "success"
              ? "block text-[11px] text-success"
              : tone === "warn"
                ? "block text-[11px] font-medium text-warn-ink"
                : "block text-[11px] text-muted"
          }
        >
          {sub}
        </span>
      ) : null}
    </span>
  );
}

/** Achievement against target as "64%", or nothing where nothing was asked. */
function bpOf(bp: number | null): string | undefined {
  return bp === null ? undefined : `${(bp / 100).toFixed(0)}%`;
}

function subTone(bp: number | null, emphasise: boolean): "success" | "warn" | "muted" {
  if (emphasise) return "warn";
  return bp !== null && bp >= BP ? "success" : "muted";
}

/** Millilitres are what is stored; litres are what anybody says out loud. */
function litres(ml: number): string {
  if (!ml) return "0 L";
  return `${Math.round(ml / 1000).toLocaleString("en-IN")} L`;
}
