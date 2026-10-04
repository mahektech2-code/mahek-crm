import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  Badge,
  Card,
  EmptyState,
  MetricStrip,
  PageHeader,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { money, phoneDisplay, shortDateWithYear } from "@/lib/format";
import {
  TOP_CUSTOMER_METRICS,
  topCustomers,
  type TopCustomerMetric,
} from "@/lib/services/top-customers-service";

export const metadata = { title: "Top customers - MahekOne CRM" };

const METRIC_LABEL: Record<TopCustomerMetric, string> = {
  value: "Order value",
  orders: "Number of orders",
};

/**
 * The company's top customers over the last few months.
 *
 * Ranked across EVERY book, then narrowed to the viewer's — see
 * `top-customers-service.ts` for why it is that way round. An admin sees the
 * whole list; a telecaller sees the ones of it they would also find on their
 * own Customers screen, each still carrying its company rank, so "#4" means
 * the same account on everybody's screen.
 */
export default async function TopCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ by?: string }>;
}) {
  await requireUser();
  const { by } = await searchParams;
  const metric: TopCustomerMetric = TOP_CUSTOMER_METRICS.includes(by as TopCustomerMetric)
    ? (by as TopCustomerMetric)
    : "value";
  const data = await topCustomers(metric);

  const shownValue = data.rows.reduce((s, r) => s + r.valuePaise, 0);
  const shownOrders = data.rows.reduce((s, r) => s + r.orders, 0);
  const share = (part: number, whole: number) =>
    whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
  const window = `${shortDateWithYear(data.from, data.to)} – ${shortDateWithYear(data.to, data.to)}`;

  return (
    <div className="p-5">
      <PageHeader
        title="Top customers"
        subtitle={
          data.wholeCompany
            ? `The company's top ${data.limit} accounts by ${METRIC_LABEL[metric].toLowerCase()}, over the last ${data.months} months (${window}). Approved orders only.`
            : `The company's top ${data.limit} accounts by ${METRIC_LABEL[metric].toLowerCase()} over the last ${data.months} months (${window}) — showing the ones in your book. The rank is the account's place across the whole company.`
        }
      />

      <MetricStrip
        metrics={
          data.wholeCompany
            ? [
                {
                  label: "Accounts on the list",
                  value: String(data.companyCount),
                  sub:
                    data.companyCount < data.limit
                      ? `only ${data.companyCount} accounts ordered in the window`
                      : `the top ${data.limit}`,
                },
                {
                  label: "Their order value",
                  value: money(data.companyTopValuePaise),
                  sub: `${share(data.companyTopValuePaise, data.companyValuePaise)} of everything sold in the window`,
                },
                { label: "Their orders", value: shownOrders.toLocaleString("en-IN") },
              ]
            : [
                {
                  label: "In your book",
                  value: `${data.rows.length} of ${data.companyCount}`,
                  sub: "of the company's top accounts",
                },
                {
                  label: "Their order value",
                  value: money(shownValue),
                  sub: `${share(shownValue, data.companyTopValuePaise)} of the top list's value`,
                },
                { label: "Their orders", value: shownOrders.toLocaleString("en-IN") },
              ]
        }
      />

      <Card className="mb-0 flex flex-wrap items-center gap-2 rounded-b-none px-4 py-3">
        <span className="text-sm text-muted">Rank by</span>
        {/* Links rather than a control with state: the server answers the
            ranking, and the URL is what somebody shares. */}
        {TOP_CUSTOMER_METRICS.map((m) => (
          <Link
            key={m}
            href={m === "value" ? "/crm/top-customers" : `/crm/top-customers?by=${m}`}
            className={cx(
              "inline-flex h-8 items-center rounded-[4px] border px-3 text-sm no-underline",
              m === metric
                ? "border-brand bg-brand text-white"
                : "border-line-strong bg-surface text-body hover:bg-canvas",
            )}
          >
            {METRIC_LABEL[m]}
          </Link>
        ))}
      </Card>

      <Card className="max-h-[calc(100vh-300px)] overflow-auto rounded-t-none">
        {data.rows.length ? (
          <table>
            <thead>
              <tr>
                <Th align="right">Rank</Th>
                <Th>Customer</Th>
                <Th>City</Th>
                <Th>Salesperson / back office</Th>
                <Th align="right">Orders</Th>
                <Th align="right">Order value</Th>
                <Th align="right">Average order</Th>
                <Th>Last order</Th>
                <Th align="right">Outstanding</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <Tr key={r.id} className="hover:bg-canvas">
                  <Td align="right" className="font-semibold text-ink tabular-nums">
                    #{r.rank}
                  </Td>
                  <Td>
                    <Link
                      href={`/crm/customers/${r.id}`}
                      className="font-medium text-ink no-underline hover:underline"
                    >
                      {r.name}
                    </Link>
                    {r.thirdParty ? (
                      <Badge className="ml-2" tone="neutral">
                        Third party
                      </Badge>
                    ) : null}
                    <div className="text-[13px] text-muted">{phoneDisplay(r.phone)}</div>
                  </Td>
                  <Td>{r.place.city ?? r.city}</Td>
                  <Td className="text-sm">
                    <div>
                      <span className="text-muted">Sales </span>
                      {r.salesAmName ?? "Unassigned"}
                    </div>
                    <div>
                      <span className="text-muted">Back office </span>
                      {r.backOfficeAmName ?? "Unassigned"}
                    </div>
                  </Td>
                  <Td align="right" className={cx("tabular-nums", metric === "orders" && "font-semibold")}>
                    {r.orders.toLocaleString("en-IN")}
                  </Td>
                  <Td align="right" className={cx("tabular-nums", metric === "value" && "font-semibold")}>
                    {money(r.valuePaise)}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {money(Math.round(r.valuePaise / Math.max(r.orders, 1)))}
                  </Td>
                  <Td>{shortDateWithYear(r.lastOrderedOn, data.to)}</Td>
                  <Td align="right" className="tabular-nums">
                    {money(r.outstandingPaise)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title={
              data.wholeCompany || data.companyCount === 0
                ? "No approved orders in the window"
                : "None of the top accounts are in your book"
            }
            body={
              data.wholeCompany || data.companyCount === 0
                ? `Nothing ordered between ${window} has been approved yet.`
                : `The company's top ${data.companyCount} accounts are all looked after by other people. Your own customers are on the Customers screen.`
            }
          />
        )}
      </Card>
    </div>
  );
}
