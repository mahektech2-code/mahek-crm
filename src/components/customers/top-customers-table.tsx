import Link from "next/link";
import { Badge, Card, EmptyState, Td, Th, cx } from "@/components/ui/primitives";
import { money, stamp } from "@/lib/format";
import {
  SPAN_LABEL,
  TOP_CUSTOMER_SPANS,
  monthHeading,
} from "@/lib/top-customers-period";
import type {
  TopCustomerMetric,
  TopCustomersReport,
} from "@/lib/services/top-customers-service";

/* ---------------------------------------------------------------------------
 * The Top customers report, laid out the way the office's own "Top 1 to 50"
 * sheet is: party, location, invoices, total, average, a column per month and
 * the share of the company's sales. Read from the report generated on the 1st,
 * never from live figures — see `top-customers-service.ts`.
 *
 * No hooks and no handlers, so it renders on the server and is handed to the
 * Monthly targets screen as its second tab.
 * ------------------------------------------------------------------------- */

const METRIC_LABEL: Record<TopCustomerMetric, string> = {
  value: "Total sales",
  orders: "No. of orders",
};

const pct = (part: number, whole: number) =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—";

export function TopCustomersTable({
  report,
  basePath,
  customerHrefTemplate,
}: {
  report: TopCustomersReport;
  /** The Monthly targets route this tab sits on, so its links stay in the right app. */
  basePath: string;
  customerHrefTemplate: string;
}) {
  const { rows, months, span, metric } = report;
  const crossesYear = months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4);
  const href = (patch: { span?: number; by?: TopCustomerMetric }) => {
    const p = new URLSearchParams({ view: "top" });
    const s = patch.span ?? span;
    const b = patch.by ?? metric;
    if (s !== 3) p.set("span", String(s));
    if (b !== "value") p.set("by", b);
    return `${basePath}?${p.toString()}`;
  };

  const monthTotals = months.map((_, i) =>
    rows.reduce((sum, r) => sum + (r.months[i]?.valuePaise ?? 0), 0),
  );
  const shownValue = rows.reduce((s, r) => s + r.valuePaise, 0);
  const shownOrders = rows.reduce((s, r) => s + r.orders, 0);
  const first = monthHeading(months[0], true);
  const last = monthHeading(months[months.length - 1], true);

  const pill = (active: boolean) =>
    cx(
      "inline-flex h-8 items-center rounded-[4px] border px-3 text-sm no-underline",
      active
        ? "border-brand bg-brand text-white"
        : "border-line-strong bg-surface text-body hover:bg-canvas",
    );

  return (
    <>
      <Card className="mb-0 flex flex-wrap items-center gap-2 rounded-b-none border-b-0 px-4 py-3">
        <span className="text-sm text-muted">Period</span>
        {TOP_CUSTOMER_SPANS.map((s) => (
          <Link key={s} href={href({ span: s })} className={pill(s === span)}>
            {SPAN_LABEL[s]}
          </Link>
        ))}
        <span className="ml-3 text-sm text-muted">Rank by</span>
        {(["value", "orders"] as const).map((m) => (
          <Link key={m} href={href({ by: m })} className={pill(m === metric)}>
            {METRIC_LABEL[m]}
          </Link>
        ))}
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {first} – {last} ·{" "}
          {report.generatedAt
            ? `generated ${stamp(report.generatedAt)}, refreshed on the 1st of every month at 10:00`
            : "not generated yet"}
        </span>
      </Card>

      <div className="border border-b-0 border-line bg-surface px-4 py-2.5 text-[13px] text-body">
        {report.wholeCompany ? (
          <>
            The company&apos;s top {report.companyCount} customers by{" "}
            {METRIC_LABEL[metric].toLowerCase()} — {money(report.companyTopValuePaise)},{" "}
            {pct(report.companyTopValuePaise, report.totalPaise)} of the{" "}
            {money(report.totalPaise)} sold in the period. Approved orders only.
          </>
        ) : (
          <>
            <strong className="text-ink">{rows.length}</strong>
            {` of the company's top ${report.companyCount} customers are in this book — ${money(shownValue)} between them. The # is the customer's rank across the whole company.`}
          </>
        )}
      </div>

      <Card className="max-h-[calc(100vh-300px)] overflow-auto rounded-t-none">
        {rows.length ? (
          <table className="text-[13px]">
            <thead>
              <tr className="[&>th]:bg-success-soft">
                <Th align="right">#</Th>
                <Th>Party name</Th>
                <Th>Location</Th>
                <Th align="right">No. of orders</Th>
                <Th align="right">Total sales</Th>
                <Th align="right" title="Total sales divided by the months in the period">
                  Average
                </Th>
                {months.map((m) => (
                  <Th key={m} align="right">
                    {monthHeading(m, crossesYear)}
                  </Th>
                ))}
                <Th align="right" title="Share of every approved order in the period, company-wide">
                  Contribution to sales
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const average = Math.round(r.valuePaise / months.length);
                return (
                  <tr key={r.id} className="border-b border-divider hover:bg-canvas">
                    <Td align="right" className="font-semibold text-ink tabular-nums">
                      {r.rank}
                    </Td>
                    <Td className="min-w-[220px]">
                      <Link
                        href={customerHrefTemplate.replace("{id}", r.id)}
                        className="font-medium text-ink no-underline hover:underline"
                      >
                        {r.name}
                      </Link>
                      {r.thirdParty ? (
                        <Badge className="ml-2" tone="neutral">
                          Third party
                        </Badge>
                      ) : null}
                      <div className="text-[12px] text-muted">
                        Sales {r.salesAmName ?? "unassigned"} · Back office{" "}
                        {r.backOfficeAmName ?? "unassigned"}
                      </div>
                    </Td>
                    <Td>{r.location}</Td>
                    <Td align="right" className={cx("tabular-nums", metric === "orders" && "font-semibold text-ink")}>
                      {r.orders}
                    </Td>
                    <Td align="right" className={cx("tabular-nums", metric === "value" && "font-semibold text-ink")}>
                      {money(r.valuePaise)}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {money(average)}
                    </Td>
                    {r.months.map((m) => (
                      /* Green where the month came in at or above the
                         customer's own average, red where it fell short or
                         nothing was ordered — the sheet's way of showing which
                         months carried the account and which did not. */
                      <Td
                        key={m.month}
                        align="right"
                        className={cx(
                          "tabular-nums",
                          m.valuePaise >= average && m.valuePaise > 0
                            ? "bg-success-soft text-success"
                            : "bg-danger-soft text-danger",
                        )}
                        title={`${m.orders} order${m.orders === 1 ? "" : "s"}`}
                      >
                        {m.valuePaise > 0 ? money(m.valuePaise) : "—"}
                      </Td>
                    ))}
                    <Td align="right" className="tabular-nums">
                      {pct(r.valuePaise, report.totalPaise)}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line-strong font-semibold text-ink [&>td]:bg-canvas">
                <Td />
                <Td>Total of these {rows.length}</Td>
                <Td />
                <Td align="right" className="tabular-nums">
                  {shownOrders}
                </Td>
                <Td align="right" className="tabular-nums">
                  {money(shownValue)}
                </Td>
                <Td align="right" className="tabular-nums">
                  {money(Math.round(shownValue / months.length))}
                </Td>
                {monthTotals.map((v, i) => (
                  <Td key={months[i]} align="right" className="tabular-nums">
                    {money(v)}
                  </Td>
                ))}
                <Td align="right" className="tabular-nums">
                  {pct(shownValue, report.totalPaise)}
                </Td>
              </tr>
            </tfoot>
          </table>
        ) : (
          <EmptyState
            title={
              report.companyCount === 0
                ? "No approved orders in the period"
                : "None of the top customers are in your book"
            }
            body={
              report.companyCount === 0
                ? `Nothing ordered between ${first} and ${last} has been approved.`
                : `The company's top ${report.companyCount} customers are all looked after by other people. Your own customers are on the Targets tab and the Customers screen.`
            }
          />
        )}
      </Card>
    </>
  );
}
