/* ---------------------------------------------------------------------------
 * BILLED AGAINST THE LIST — the Sales Dashboard's door onto the variance report.
 *
 * The month is a SEARCH PARAM and the twelve options are built on the server
 * from the business day, because a month is a business date and a browser's
 * idea of today is its own. Reading the clock in the panel would also break
 * the React Compiler rules the rest of this app keeps.
 * ------------------------------------------------------------------------- */
import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { varianceReport } from "@/lib/services/price-list-service";
import { PageHeader } from "@/components/ui/primitives";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { VariancePanel } from "@/components/pricing/variance-panel";
import { lastTwelveMonths, monthOf } from "@/components/pricing/months";

export const metadata = { title: "Billed against the list — Accounts — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  await requireUser();
  const { month } = await searchParams;
  const day = await today();
  const months = lastTwelveMonths(day);
  // A month nobody offered is a month nobody can have meant — a typed URL
  // falls back to the current one rather than reporting an empty month.
  const chosen = month && months.includes(month) ? month : monthOf(day);
  const report = await varianceReport(chosen);

  return (
    <div className="p-6">
      <PageHeader
        title="Billed against the list"
        subtitle="Every priced order line in the month, beside what the list resolved for that shop on that day."
      />
      <PricingSubNav basePath="/accounts/price-lists" current="variance" />
      <VariancePanel basePath="/accounts/price-lists" report={report} monthOptions={months} />
    </div>
  );
}
