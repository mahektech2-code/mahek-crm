import Link from "next/link";
import { MonthNav, monthName } from "@/components/ui/month-nav";
import { money, moneyShort } from "@/lib/format";
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
  ScreenHeader,
  Table,
} from "../parts";

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

  const scored = rows.filter((r) => r.hasTarget);
  const totals = rows.reduce(
    (a, r) => ({
      revenue: a.revenue + r.actuals.revenuePaise,
      millilitres: a.millilitres + r.actuals.millilitres,
      collected: a.collected + r.actuals.collectionPaise,
      newCustomers: a.newCustomers + r.actuals.newCustomers,
      unmatched: a.unmatched + r.unmatchedPaise,
    }),
    { revenue: 0, millilitres: 0, collected: 0, newCustomers: 0, unmatched: 0 },
  );

  const days = rows[0];
  const priceRisk = rows.filter((r) =>
    r.alerts.some((a) => a.key === "price-not-volume"),
  );

  return (
    <div className="p-6">
      <ScreenHeader
        title="Performance"
        subtitle={`${monthName(month)} — revenue, litres, product mix, new customers, collection and activity, scored out of 100.`}
        actions={
          <div className="flex items-center gap-1 text-[13px]">
            <Link
              href={`/sales/targets?period=${month}`}
              className="mr-2 rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              ← Back to targets
            </Link>
            <MonthNav month={month} basePath="/sales/performance" />
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
          body="Revenue can rise on a price revision alone. Where volume has not risen with it, the month is a price effect rather than more selling — the litres column is the one to read."
        />
      ) : null}

      {orphaned.revenuePaise > 0 ? (
        <Banner
          tone="info"
          title={`${money(orphaned.revenuePaise)} is not counted towards anybody`}
          body={`${orphaned.customers} ${orphaned.customers === 1 ? "customer has" : "customers have"} neither a salesperson nor a back office person, so their orders belong to no one's target. Setting either seat on the customer record fixes it — nothing here guesses.`}
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Revenue", value: money(totals.revenue) },
          {
            label: "Volume",
            value: litres(totals.millilitres),
            sub: totals.unmatched
              ? `${money(totals.unmatched)} on unrecognised products`
              : undefined,
          },
          { label: "Collected", value: money(totals.collected), sub: "confirmed only" },
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
          body="Nobody holds a published target for this month and nothing has been sold against a customer with a salesperson or a back office person."
        />
      ) : (
        <>
          <Table
            minWidth={1240}
            head={
              <>
                <HeadCell width={170}>Person</HeadCell>
                <HeadCell align="right" width={90}>Score</HeadCell>
                <HeadCell width={130}>Rating</HeadCell>
                <HeadCell align="right" width={160}>Revenue</HeadCell>
                <HeadCell align="right" width={150}>Volume</HeadCell>
                <HeadCell align="right" width={90}>Mix</HeadCell>
                <HeadCell align="right" width={100}>New</HeadCell>
                <HeadCell align="right" width={110}>Collection</HeadCell>
                <HeadCell align="right" width={100}>Activity</HeadCell>
                <HeadCell width={180}>Wants attention</HeadCell>
              </>
            }
          >
            {rows.map((r, i) => {
              const by = (k: string) =>
                r.score.components.find((c) => c.key === k)?.achievementBp ?? null;
              const revenue = by("revenue");
              const volume = by("volume");
              const diverging =
                revenue !== null && volume !== null && revenue >= BP && volume < BP;

              return (
                <Row key={r.userId} striped={i % 2 === 1}>
                  <Cell truncate={170}>
                    <span className="font-medium text-ink">{r.userName}</span>
                  </Cell>
                  <Cell align="right">
                    {r.hasTarget ? (
                      <span className="font-medium text-ink tabular-nums">
                        {(r.score.totalBp / 100).toFixed(1)}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Cell>
                  <Cell>
                    {r.hasTarget ? (
                      <Pill tone={ratingTone(r.score.totalBp)}>{r.rating}</Pill>
                    ) : (
                      <span
                        className="text-[12px] text-muted"
                        title="Nothing has been asked of this person for this month, so there is nothing to score them against."
                      >
                        no target set
                      </span>
                    )}
                  </Cell>
                  <Cell align="right">
                    <Achieved
                      actual={money(r.actuals.revenuePaise)}
                      bp={revenue}
                      emphasise={diverging}
                    />
                  </Cell>
                  <Cell align="right">
                    <Achieved
                      actual={litres(r.actuals.millilitres)}
                      bp={volume}
                      emphasise={diverging}
                    />
                  </Cell>
                  <Cell align="right">{pct(r.mix.achievementBp)}</Cell>
                  <Cell align="right">
                    <Achieved actual={String(r.actuals.newCustomers)} bp={by("newCustomers")} />
                  </Cell>
                  <Cell align="right">
                    <Achieved
                      actual={moneyShort(r.actuals.collectionPaise)}
                      bp={by("collection")}
                    />
                  </Cell>
                  <Cell align="right">
                    <Achieved actual={String(r.actuals.activity)} bp={by("activity")} />
                  </Cell>
                  <Cell truncate={180}>
                    {r.alerts.length ? (
                      <span
                        className="text-[12px] text-warn-ink"
                        title={r.alerts.map((a) => a.message).join("\n")}
                      >
                        {r.alerts[0].message}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Cell>
                </Row>
              );
            })}
          </Table>

          <p className="mt-3 max-w-[860px] text-[13px] text-pretty text-muted">
            A customer&rsquo;s figures count towards their salesperson, and where an
            account has none, towards the back office person who works it — one person
            per customer, never both, so these rows add up to the company rather than
            past it. Revenue is orders accounts have accepted; collection is money
            accounts have confirmed against the bank. Litres are known only for order
            lines whose product could be matched to the catalogue
            {totals.unmatched
              ? `, and ${money(totals.unmatched)} this month could not be`
              : ""}
            .{" "}
            {scored.length < rows.length
              ? `${rows.length - scored.length} of these people have no published target for ${monthName(month)}.`
              : ""}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * A figure and what it is against.
 *
 * Both, always. The percentage alone hides that somebody's target was tiny,
 * and the rupees alone hide that they missed it — a manager comparing two
 * people needs the pair.
 */
function Achieved({
  actual,
  bp,
  emphasise,
}: {
  actual: string;
  bp: number | null;
  emphasise?: boolean;
}) {
  return (
    <span className="tabular-nums">
      <span className="text-ink">{actual}</span>
      {bp === null ? null : (
        <span
          className={
            emphasise
              ? "ml-1.5 text-[12px] font-medium text-warn-ink"
              : bp >= BP
                ? "ml-1.5 text-[12px] text-success"
                : "ml-1.5 text-[12px] text-muted"
          }
        >
          {(bp / 100).toFixed(0)}%
        </span>
      )}
    </span>
  );
}

function pct(bp: number | null) {
  return bp === null ? (
    <span className="text-muted">—</span>
  ) : (
    <span className="tabular-nums text-ink">{(bp / 100).toFixed(0)}%</span>
  );
}

/** Millilitres are what is stored; litres are what anybody says out loud. */
function litres(ml: number): string {
  if (!ml) return "0 L";
  return `${Math.round(ml / 1000).toLocaleString("en-IN")} L`;
}

function ratingTone(bp: number): "success" | "brand" | "warn" | "danger" {
  const score = bp / 100;
  if (score >= 90) return "success";
  if (score >= 80) return "brand";
  if (score >= 60) return "warn";
  return "danger";
}

