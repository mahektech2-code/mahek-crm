import Link from "next/link";
import { money } from "@/lib/format";
import { today } from "@/lib/recompute";
import { endOfMonth } from "@/lib/business-date";
import { MonthNav } from "@/components/ui/month-nav";
import { topAndBottom } from "@/lib/engines/sales-roi";
import {
  customerCosts,
  expenseBreakdown,
  salesmanRoi,
} from "@/lib/services/expense-roi-service";
import {
  Banner,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Row,
  ScreenHeader,
  Table,
} from "../parts";

export const metadata = { title: "Cost & return — Sales Dashboard — MahekOne" };

const km = (metres: number) => `${(metres / 1000).toFixed(0)} km`;
const pct = (bps: number | null) => (bps === null ? "—" : `${(bps / 100).toFixed(1)}%`);

/**
 * §K and §M — what each salesman brought in, against what he cost.
 *
 * **Every figure on this screen is REVENUE, not margin, and it says so at the
 * top rather than in a footnote.** Requirements 61 and 64 ask for
 * "contribution", which is margin — and MahekOne holds no product costs at
 * all, by design, so that no screen shows a confident wrong number. Revenue
 * over cost looks like a return on investment and reads like one; it is off by
 * whatever the margin is, and the only honest thing to do is say which figure
 * this is, in words, where nobody can miss it.
 *
 * A ratio nobody can work out is null with a reason rather than zero. Sales
 * per kilometre on somebody who recorded no travel is not ₹0 — it is a
 * question with no denominator, and a zero on that row reads as "he sold
 * nothing", which is an accusation made out of missing data.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : now.slice(0, 7);
  const from = `${month}-01`;
  const to = endOfMonth(month);

  const [people, costs, breakdown] = await Promise.all([
    salesmanRoi(from, to),
    customerCosts(from, to),
    expenseBreakdown(from, to),
  ]);

  const best = topAndBottom(people, (p) => p.perKm.value, 1);
  const revenue = people.reduce((n, p) => n + Number(p.revenuePaise), 0);
  const cost = people.reduce((n, p) => n + p.cost.totalPaise, 0);
  const noSalary = people.filter((p) => p.cost.salaryMissing);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Cost and return"
        subtitle="What the field brought in against what it cost. These are REVENUE ratios, not profit ratios — MahekOne holds no product costs, so no margin can be worked out and inventing one here would put a believable wrong number on the screen that matters most."
        actions={<MonthNav month={month} basePath="/sales/roi" />}
      />

      {noSalary.length ? (
        <Banner
          tone="warn"
          title={`${noSalary.length} salesman without a salary figure`}
          body={`${noSalary.map((p) => p.name).join(", ")} — payroll has no row matching their account, so their cost is the expenses alone. Treating a missing salary as zero would make whoever payroll has not caught up with look like the cheapest person on the team.`}
        />
      ) : null}

      {breakdown.awaitingPaise > 0 ? (
        <Banner
          tone="warn"
          title={`${money(breakdown.awaitingPaise)} claimed and not yet decided`}
          body="Cost counts APPROVED expenses only, the same way outstanding counts confirmed money only. Until these are decided this month reads cheaper than it was."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Revenue", value: money(revenue) },
          { label: "Total cost", value: money(cost), sub: "salary + approved expenses" },
          {
            label: "Expense to sales",
            value: revenue > 0 ? pct(Math.round((cost / revenue) * 10_000)) : "—",
            sub: revenue > 0 ? undefined : "nothing sold",
          },
          {
            label: "Best sales per km",
            value: best.top[0] ? best.top[0].name : "—",
            sub: best.top[0]?.perKm.value ? money(Math.round(best.top[0].perKm.value)) + " a km" : undefined,
          },
        ]}
      />

      {/* §M67 — the breakdown, because "total expense" alone tells nobody
          whether the month was hotels or fuel, and those are different problems
          with different answers. */}
      <MetricRow
        metrics={[
          { label: "Travel", value: money(breakdown.travelPaise) },
          { label: "Food", value: money(breakdown.foodPaise) },
          { label: "Hotel", value: money(breakdown.lodgingPaise) },
          { label: "Local transport", value: money(breakdown.localTransportPaise) },
          { label: "Other", value: money(breakdown.otherPaise) },
        ]}
      />

      {/* §L — and the two are drawn apart on purpose. Requirement 65 is about
          not MIXING them, and a single "customer cost" tile would be exactly
          the mixing it forbids. */}
      <MetricRow
        metrics={[
          {
            label: "Cost of a new customer",
            value:
              costs.acquisition.perCustomerPaise === null
                ? "—"
                : money(costs.acquisition.perCustomerPaise),
            sub:
              costs.acquisition.reason ??
              `${money(costs.acquisition.costPaise)} over ${costs.acquisition.newCustomers} won`,
          },
          {
            label: "Cost of servicing one",
            value:
              costs.servicing.perCustomerPaise === null
                ? "—"
                : money(costs.servicing.perCustomerPaise),
            sub:
              costs.servicing.reason ??
              `${money(costs.servicing.costPaise)} over ${costs.servicing.customersServed} served`,
          },
          {
            label: "Spending against no customer",
            value: money(costs.unattributedPaise),
            sub: "counted in neither — a figure nobody can account for is worse than one that says why",
            tone: costs.unattributedPaise > 0 ? "warn" : undefined,
          },
        ]}
      />

      {people.length === 0 ? (
        <Empty
          title="Nothing to compare yet"
          body="This reads approved expense days and counting orders. A month with no submitted days, or none yet approved, has nothing to divide."
        />
      ) : (
        <Table
          minWidth={1400}
          head={
            <>
              <HeadCell width={170}>Salesman</HeadCell>
              <HeadCell align="right" width={130}>Revenue</HeadCell>
              <HeadCell align="right" width={110}>Distance</HeadCell>
              <HeadCell align="right" width={90}>Visits</HeadCell>
              <HeadCell align="right" width={120}>New customers</HeadCell>
              <HeadCell align="right" width={130}>Sales per km</HeadCell>
              <HeadCell align="right" width={130}>Sales per visit</HeadCell>
              <HeadCell align="right" width={130}>Travel to sales</HeadCell>
              <HeadCell align="right" width={140}>Total cost</HeadCell>
              <HeadCell align="right" width={140}>Revenue to cost</HeadCell>
            </>
          }
        >
          {people.map((p, i) => (
            <Row key={p.userId} striped={i % 2 === 1}>
              <Cell truncate={170}>
                <Link href={`/sales/people/${p.userId}`} className="font-medium text-ink no-underline">
                  {p.name}
                </Link>
              </Cell>
              <Cell align="right">{money(p.revenuePaise)}</Cell>
              <Cell align="right">{p.metres > 0 ? km(p.metres) : <span className="text-muted">none</span>}</Cell>
              <Cell align="right">{p.visitCount}</Cell>
              <Cell align="right">{p.newCustomerCount}</Cell>
              <Cell align="right">
                {p.perKm.value === null ? (
                  <span className="text-muted" title={p.perKm.reason ?? undefined}>—</span>
                ) : (
                  money(Math.round(p.perKm.value))
                )}
              </Cell>
              <Cell align="right">
                {p.perVisit.value === null ? (
                  <span className="text-muted" title={p.perVisit.reason ?? undefined}>—</span>
                ) : (
                  money(Math.round(p.perVisit.value))
                )}
              </Cell>
              <Cell align="right">
                {p.expenseRatioBps.value === null ? (
                  <span className="text-muted" title={p.expenseRatioBps.reason ?? undefined}>—</span>
                ) : (
                  pct(p.expenseRatioBps.value)
                )}
              </Cell>
              <Cell align="right">
                {money(p.cost.totalPaise)}
                {p.cost.salaryMissing ? (
                  <span className="block text-[12px] text-warn-ink">no salary on file</span>
                ) : null}
              </Cell>
              <Cell align="right">
                {p.ret.multiple === null ? (
                  <span className="text-muted">—</span>
                ) : (
                  <>
                    {p.ret.multiple.toFixed(1)}×
                    <span className="block text-[12px] text-muted">revenue, not profit</span>
                  </>
                )}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}
