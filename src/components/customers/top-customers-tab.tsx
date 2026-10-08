import "server-only";
import { TopCustomersTable } from "./top-customers-table";
import { FocusCustomersPanel } from "./focus-customers-panel";
import { focusCustomers } from "@/lib/services/focus-customers-service";
import { today } from "@/lib/recompute";
import {
  TOP_CUSTOMER_METRICS,
  topCustomersReport,
  type TopCustomerMetric,
} from "@/lib/services/top-customers-service";
import { TOP_CUSTOMER_SPANS, type TopCustomerSpan } from "@/lib/top-customers-period";

/**
 * The Top customers and Focus customers tabs of Monthly targets, read from the URL the same way by
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
): Promise<{ view: "targets" | "top" | "focus"; topContent?: React.ReactNode }> {
  const view = one("view");
  if (view !== "top" && view !== "focus") return { view: "targets" };
  const spanParam = Number(one("span"));
  const span: TopCustomerSpan = (TOP_CUSTOMER_SPANS as readonly number[]).includes(spanParam)
    ? (spanParam as TopCustomerSpan)
    : 3;
  if (view === "focus") {
    const [data, day] = await Promise.all([focusCustomers(span), today()]);
    return {
      view: "focus",
      topContent: (
        <FocusCustomersPanel
          data={data}
          basePath={basePath}
          customerHrefTemplate={customerHrefTemplate}
          today={day}
        />
      ),
    };
  }
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
