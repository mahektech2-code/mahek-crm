import "server-only";
import { TopCustomersTable } from "./top-customers-table";
import {
  TOP_CUSTOMER_METRICS,
  topCustomersReport,
  type TopCustomerMetric,
} from "@/lib/services/top-customers-service";
import { TOP_CUSTOMER_SPANS, type TopCustomerSpan } from "@/lib/top-customers-period";

/**
 * The Top customers tab of Monthly targets, read from the URL the same way by
 * both doors onto that screen — the CRM's and Accounts'. Only fetched when the
 * tab is open: the report is a separate read and a closed tab should cost
 * nothing.
 *
 * An unrecognised `span` or `by` reads as the default rather than as an error,
 * the safe direction for a link somebody typed.
 */
export async function readTopCustomersTab(
  one: (key: string) => string | undefined,
  basePath: string,
  customerHrefTemplate: string,
): Promise<{ view: "targets" | "top"; topContent?: React.ReactNode }> {
  if (one("view") !== "top") return { view: "targets" };
  const spanParam = Number(one("span"));
  const span: TopCustomerSpan = (TOP_CUSTOMER_SPANS as readonly number[]).includes(spanParam)
    ? (spanParam as TopCustomerSpan)
    : 3;
  const by = one("by");
  const metric: TopCustomerMetric = TOP_CUSTOMER_METRICS.includes(by as TopCustomerMetric)
    ? (by as TopCustomerMetric)
    : "value";
  const report = await topCustomersReport(span, metric);
  return {
    view: "top",
    topContent: (
      <TopCustomersTable
        report={report}
        basePath={basePath}
        customerHrefTemplate={customerHrefTemplate}
      />
    ),
  };
}
