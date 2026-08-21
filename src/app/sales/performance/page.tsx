import Link from "next/link";
import { money } from "@/lib/format";
import { APP_TIMEZONE, endOfMonth } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { performance } from "@/lib/services/sales-service";
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

export const metadata = { title: "Performance — Sales Dashboard — MahekOne" };

/**
 * A month, per salesman.
 *
 * **There is no target column, and that is a decision rather than an
 * omission.** `monthly_targets` is the CRM's, set per telecaller; nothing sets
 * one for a field salesman. A percentage against a target nobody set would be
 * a number this screen invented, and the design's own rule — inherited from
 * the order form — is that a confident wrong figure is worse than a blank.
 *
 * Order value is CAPTURED value. An MBOS order sits at pending approval until
 * accounts decide it, so this is what the team sold and not what the business
 * booked. The screen says so under the table rather than leaving it to be
 * assumed.
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

  const rows = await performance(from, to);

  const totals = rows.reduce(
    (a, r) => ({
      visits: a.visits + Number(r.visits),
      orders: a.orders + Number(r.orders),
      value: a.value + Number(r.orderValuePaise),
      collected: a.collected + Number(r.collectedPaise),
      newCustomers: a.newCustomers + Number(r.newCustomers),
    }),
    { visits: 0, orders: 0, value: 0, collected: 0, newCustomers: 0 },
  );

  const best = [...rows].sort(
    (a, b) => Number(b.orderValuePaise) - Number(a.orderValuePaise),
  );
  const widest = Math.max(1, ...rows.map((r) => Number(r.orderValuePaise)));

  return (
    <div className="p-6">
      <ScreenHeader
        title="Performance"
        subtitle={`${monthName(month)} — what each salesman did, measured in what actually happened rather than against a target nobody set.`}
        actions={
          <div className="flex items-center gap-1 text-[13px]">
            <Link
              href={`/sales/performance?month=${shiftMonth(month, -1)}`}
              className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              ←
            </Link>
            <span className="px-2 text-muted">{monthName(month)}</span>
            <Link
              href={`/sales/performance?month=${shiftMonth(month, 1)}`}
              className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              →
            </Link>
          </div>
        }
      />

      <Banner
        tone="info"
        title="No targets are set for the field"
        body="The design shows achievement against a monthly target. MahekOne sets targets per telecaller in the CRM and none for a field salesman, so there is nothing to divide by — a percentage here would be invented. What is shown is what happened."
      />

      <MetricRow
        metrics={[
          { label: "Visits", value: String(totals.visits) },
          { label: "Orders", value: String(totals.orders) },
          { label: "Order value", value: money(totals.value), sub: "captured, not approved" },
          { label: "Collected", value: money(totals.collected), sub: "reported, not banked" },
          { label: "New customers", value: String(totals.newCustomers) },
        ]}
      />

      {rows.length === 0 ? (
        <Empty title="Nobody in the field" body="The field team is whoever holds the Salesman App." />
      ) : (
        <>
          {totals.value ? (
            <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
              <div className="mb-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                Order value, most to least
              </div>
              <div className="space-y-2">
                {best.map((r) => (
                  <div key={r.salesmanId} className="flex items-center gap-3">
                    <span className="w-[180px] flex-none truncate text-[13px] text-body">
                      {r.salesmanName}
                    </span>
                    <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-[4px] bg-canvas">
                      <span
                        className="block h-full rounded-[4px] bg-brand"
                        style={{
                          width: `${Math.round((Number(r.orderValuePaise) / widest) * 100)}%`,
                        }}
                      />
                    </span>
                    <span className="w-[150px] flex-none text-right text-[13px] text-ink tabular-nums">
                      {Number(r.orderValuePaise) ? money(r.orderValuePaise) : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <Table
            minWidth={1160}
            head={
              <>
                <HeadCell width={200}>Salesman</HeadCell>
                <HeadCell align="right" width={110}>Days out</HeadCell>
                <HeadCell align="right" width={130}>Visits</HeadCell>
                <HeadCell align="right" width={150}>Route kept</HeadCell>
                <HeadCell align="right" width={110}>Orders</HeadCell>
                <HeadCell align="right" width={150}>Order value</HeadCell>
                <HeadCell align="right" width={150}>Collected</HeadCell>
                <HeadCell align="right" width={130}>New shops</HeadCell>
              </>
            }
          >
            {rows.map((r, i) => (
              <Row key={r.salesmanId} striped={i % 2 === 1}>
                <Cell truncate={200}>
                  <Link
                    href={`/sales/people/${r.salesmanId}`}
                    className="font-medium text-ink no-underline hover:underline"
                  >
                    {r.salesmanName}
                  </Link>
                </Cell>
                <Cell align="right">{r.daysWorked}</Cell>
                <Cell align="right">
                  {r.visits}
                  {Number(r.visits) !== Number(r.verifiedVisits) ? (
                    <span
                      className="ml-1 text-warn-ink"
                      title="Visits saved with the location checklist unsatisfied. Each carries the reason the salesman gave."
                    >
                      ({r.verifiedVisits} verified)
                    </span>
                  ) : null}
                </Cell>
                <Cell align="right">
                  {r.plannedStops ? (
                    `${r.walkedStops} of ${r.plannedStops}`
                  ) : (
                    <span className="text-muted">no plan</span>
                  )}
                </Cell>
                <Cell align="right">{r.orders || <span className="text-muted">—</span>}</Cell>
                <Cell align="right">
                  {Number(r.orderValuePaise) ? (
                    money(r.orderValuePaise)
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell align="right">
                  {Number(r.collectedPaise) ? (
                    money(r.collectedPaise)
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell align="right">
                  {r.newCustomers || <span className="text-muted">—</span>}
                </Cell>
              </Row>
            ))}
          </Table>

          <p className="mt-3 max-w-[820px] text-[13px] text-pretty text-muted">
            Order value is what was captured in the field and is awaiting accounts&rsquo;
            approval. Collected is what salesmen reported, which becomes money the business has
            seen only when accounts confirm it against the bank. Neither figure has moved a target
            or an outstanding balance.
          </p>
        </>
      )}
    </div>
  );
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: APP_TIMEZONE,
  }).format(new Date(Date.UTC(y, m - 1, 15)));
}

