"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Card, EmptyState, MetricStrip, Td, Th, Tr } from "@/components/ui/primitives";
import { FilterPills } from "@/components/ui/overlays";
import { money, stamp } from "@/lib/format";
import {
  SPAN_LABEL,
  TOP_CUSTOMER_SPANS,
  monthHeading,
  type TopCustomerSpan,
} from "@/lib/top-customers-period";
import type {
  TopCustomerMetric,
  TopCustomersReport,
} from "@/lib/services/top-customers-service";

/* ---------------------------------------------------------------------------
 * The Top customers report: party, location, then sales and sales bills each
 * AVERAGED PER MONTH, a column per month and the share of the
 * company's sales. Per month rather than totals so a 3-month list and a
 * 1-year list read on the same scale; the totals are in the strip above. Read from the report generated on the 1st,
 * never from live figures — see `top-customers-service.ts`.
 *
 * DRAWN WITH THE DESIGN SYSTEM, NOT THE SHEET. The sheet decides which
 * columns there are; how they look is MahekOne's: `FilterPills` for the two
 * choices, `MetricStrip` for the totals (the way the bills ledger carries its
 * own), and a plain table. No tinted header, no coloured cells.
 * ------------------------------------------------------------------------- */

const METRIC_LABEL: Record<TopCustomerMetric, string> = {
  value: "sales",
  orders: "number of orders",
};

const pct = (part: number, whole: number) =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—";

/** A count averaged over the months — "2.3", or "2" when it is whole. */
const perMonth = (count: number, months: number) => {
  const v = count / months;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

/*
 * THE HEADINGS ARE WRITTEN OUT IN FULL. They are read by people deciding who
 * to ring, not by people who built the report, so "Average sales bills per
 * month" beats any abbreviation of it. They wrap onto two lines rather than
 * stretch the table.
 */
const WRAP = "min-w-[110px] !whitespace-normal";

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
  const router = useRouter();
  const { rows, months, span, metric } = report;
  const crossesYear = months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4);
  const go = (patch: { span?: TopCustomerSpan; by?: TopCustomerMetric }) => {
    const p = new URLSearchParams({ view: "top" });
    const s = patch.span ?? span;
    const b = patch.by ?? metric;
    if (s !== 3) p.set("span", String(s));
    if (b !== "value") p.set("by", b);
    router.push(`${basePath}?${p.toString()}`, { scroll: false });
  };

  const shownValue = rows.reduce((s, r) => s + r.valuePaise, 0);
  const shownOrders = rows.reduce((s, r) => s + r.orders, 0);
  const first = monthHeading(months[0], true);
  const last = monthHeading(months[months.length - 1], true);

  return (
    <>
      <MetricStrip
        metrics={
          report.wholeCompany
            ? [
                {
                  label: "Top customers",
                  value: String(report.companyCount),
                  sub: `ranked by ${METRIC_LABEL[metric]}`,
                },
                { label: "Their sales", value: money(report.companyTopValuePaise) },
                { label: "Their orders", value: shownOrders.toLocaleString("en-IN") },
                {
                  label: "Share of all sales",
                  value: pct(report.companyTopValuePaise, report.totalPaise),
                  sub: `of ${money(report.totalPaise)} in the period`,
                },
              ]
            : [
                {
                  label: "In this book",
                  value: `${rows.length} of ${report.companyCount}`,
                  sub: "of the company's top customers",
                },
                { label: "Their sales", value: money(shownValue) },
                { label: "Their orders", value: shownOrders.toLocaleString("en-IN") },
                {
                  label: "Share of all sales",
                  value: pct(shownValue, report.totalPaise),
                  sub: `of ${money(report.totalPaise)} in the period`,
                },
              ]
        }
      />

      <Card className="mb-0 flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-b-none border-b-0 px-4 py-3">
        <FilterPills
          options={TOP_CUSTOMER_SPANS.map((s) => ({ key: String(s), label: SPAN_LABEL[s] }))}
          value={String(span)}
          onChange={(k) => go({ span: Number(k) as TopCustomerSpan })}
        />
        <FilterPills
          options={(["value", "orders"] as const).map((m) => ({
            key: m,
            label: `Rank by ${METRIC_LABEL[m]}`,
          }))}
          value={metric}
          onChange={(k) => go({ by: k })}
        />
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {`${first} – ${last} · `}
          {report.generatedAt
            ? `generated ${stamp(report.generatedAt)}, refreshed on the 1st of every month at 10:00`
            : "not generated yet"}
          {report.wholeCompany ? "" : " · # is the rank across the whole company"}
        </span>
      </Card>

      <Card className="max-h-[calc(100vh-300px)] overflow-auto rounded-t-none">
        {rows.length ? (
          <table>
            <thead>
              <tr>
                <Th align="right" className={WRAP} title="The customer's place across the whole company, not only this list">
                  Company rank
                </Th>
                <Th>Party name</Th>
                <Th>Location</Th>
                <Th align="right" className={WRAP} title="Sales in the period, divided by the months in it">
                  Average sales per month
                </Th>
                <Th align="right" className={WRAP} title="Sales bills raised in the period, divided by the months in it">
                  Average sales bills per month
                </Th>
                {months.map((m) => (
                  <Th key={m} align="right">
                    {monthHeading(m, crossesYear)}
                  </Th>
                ))}
                <Th align="right" className={WRAP} title="This customer's sales as a share of every approved order in the period, company-wide">
                  Share of company sales
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id} className="hover:bg-canvas">
                  <Td align="right" className="font-medium text-ink">
                    {r.rank}
                  </Td>
                  <Td>
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
                    <div className="text-xs text-muted">
                      Sales {r.salesAmName ?? "unassigned"} · Back office{" "}
                      {r.backOfficeAmName ?? "unassigned"}
                    </div>
                  </Td>
                  <Td>{r.location}</Td>
                  <Td
                    align="right"
                    className="font-medium text-ink"
                    title={`${money(r.valuePaise)} in ${months.length} months`}
                  >
                    {money(Math.round(r.valuePaise / months.length))}
                  </Td>
                  <Td align="right" title={`${r.bills} bills in ${months.length} months`}>
                    {perMonth(r.bills, months.length)}
                  </Td>
                  {r.months.map((m) => (
                    <Td
                      key={m.month}
                      align="right"
                      className={m.valuePaise > 0 ? undefined : "text-muted"}
                      title={`${m.orders} order${m.orders === 1 ? "" : "s"}`}
                    >
                      {m.valuePaise > 0 ? money(m.valuePaise) : "—"}
                    </Td>
                  ))}
                  <Td align="right">{pct(r.valuePaise, report.totalPaise)}</Td>
                </Tr>
              ))}
            </tbody>
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
