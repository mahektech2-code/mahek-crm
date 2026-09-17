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
  EntityLink,
  MetricRow,
  Row,
  ScreenHeader,
  SortHead,
  Table,
} from "../parts";
import { readSort, sortHref, sortRows, type SortColumns } from "../sort";

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
  searchParams: Promise<{ month?: string; sort?: string; dir?: string }>;
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

  /* Sorting is DISPLAY ONLY. Every figure in the three metric rows above is
     counted over the whole team and never over the sorted copy — re-ordering a
     list changes nothing about what is in it, and a cost-of-acquisition that
     moved when somebody clicked a column would be the screen disagreeing with
     itself on the one screen where a wrong number is least forgivable.

     "Best sales per km" is the tile this matters most for: it is the top of
     `topAndBottom` over `people`, which is the unsorted set, so it goes on
     naming the same person whatever order the table happens to be in. That is
     the point — a headline that agreed with whatever the reader had just
     clicked would be telling them what they asked for rather than what is
     true. */
  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(people, sort, COLUMNS);
  const head = (key: string, label: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/roi", sort, key, `month=${month}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {label}
    </SortHead>
  );

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
              {head("name", "Salesman", 170)}
              {head("revenue", "Revenue", 130, "right")}
              {head("distance", "Distance", 110, "right")}
              {head("visits", "Visits", 90, "right")}
              {head("new", "New customers", 120, "right")}
              {head("perKm", "Sales per km", 130, "right")}
              {head("perVisit", "Sales per visit", 130, "right")}
              {head("expenseRatio", "Travel to sales", 130, "right")}
              {head("cost", "Total cost", 140, "right")}
              {head("multiple", "Revenue to cost", 140, "right")}
            </>
          }
        >
          {sorted.map((p, i) => (
            <Row key={p.userId} striped={i % 2 === 1}>
              <Cell truncate={170}>
                <EntityLink href={`/sales/people/${p.userId}`}>
                  {p.name}
                </EntityLink>
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

/**
 * What each sortable column is worth.
 *
 * Every column on this table is a quantity and every one of them is the
 * subject of a real question — "who costs most", "who covers the most ground
 * for the least return", "who is winning customers" — so all ten sort. There
 * is nothing here to leave out: the screen carries no labels, no pills and no
 * free text, which is what a comparison table is.
 *
 * A RATIO NOBODY COULD WORK OUT IS NULL RATHER THAN ZERO, and that is the same
 * decision the engine already made: sales per kilometre on a man who recorded
 * no travel is a question with no denominator, not ₹0. Nulls sort last in both
 * directions, so "worst sales per km" lands on somebody who actually travelled
 * rather than on everybody the figure could not be computed for — which is the
 * accusation-out-of-missing-data this whole screen is written against.
 *
 * Distance sorts on METRES and cost on PAISE, never on what the cell prints.
 * "9 km" beside "10 km" and "₹1,20,000" beside "₹99,000" both sort backwards
 * as strings, and a comparison screen that ranks people wrongly is worse than
 * one that does not rank them at all.
 */
const COLUMNS: SortColumns<{
  name: string;
  revenuePaise: number | string;
  metres: number;
  visitCount: number;
  newCustomerCount: number;
  perKm: { value: number | null };
  perVisit: { value: number | null };
  expenseRatioBps: { value: number | null };
  cost: { totalPaise: number };
  ret: { multiple: number | null };
}> = {
  name: (p) => p.name,
  revenue: (p) => Number(p.revenuePaise),
  distance: (p) => p.metres,
  visits: (p) => p.visitCount,
  new: (p) => p.newCustomerCount,
  perKm: (p) => p.perKm.value,
  perVisit: (p) => p.perVisit.value,
  expenseRatio: (p) => p.expenseRatioBps.value,
  cost: (p) => p.cost.totalPaise,
  multiple: (p) => p.ret.multiple,
};
