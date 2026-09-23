import { priceListDoorCanManage } from "@/lib/price-list-door";
/* ---------------------------------------------------------------------------
 * WHO IS ON A LIST AND WHO IS ON NONE — the CRM's door onto the coverage
 * report.
 *
 * The read is the same function in both apps for the same reason the requests
 * screen's is: two readings of "which shops can be priced" is how two screens
 * come to disagree about one book.
 * ------------------------------------------------------------------------- */
import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { coverageReport, pricingOptions } from "@/lib/services/price-list-service";
import { PageHeader } from "@/components/ui/primitives";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { CoveragePanel } from "@/components/pricing/coverage-panel";

export const metadata = { title: "Coverage - MahekOne CRM" };

export default async function Page() {
  const user = await requireUser();
  const day = await today();
  const [canManage, report, options] = await Promise.all([
    priceListDoorCanManage(user, "crm"),
    coverageReport(day),
    pricingOptions(),
  ]);

  return (
    <>
      <PageHeader
        title="Coverage"
        subtitle="Which shops a published list names, and which are priced from nothing at all."
      />
      <PricingSubNav basePath="/crm/price-lists" current="coverage" />
      <CoveragePanel
        basePath="/crm/price-lists"
        report={report}
        canManage={canManage}
        lists={options.lists}
      />
    </>
  );
}
