/* ---------------------------------------------------------------------------
 * WATCH — the CRM's door onto every order line against the book live on its
 * own date. The window is a SEARCH PARAM read against the business day here,
 * because a component may not read the clock.
 *
 * READ-ONLY: no Ask why, no Send to founder (`canManage` is false on this
 * mount whatever the person holds). A telecaller may still ASK for a special
 * price, which is the ordinary request somebody else decides.
 * ------------------------------------------------------------------------- */
import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { watchRange } from "@/lib/engines/price-watch";
import { watchReport } from "@/lib/services/price-watch-service";
import { PageHeader } from "@/components/ui/primitives";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { WatchScreen } from "@/components/pricing/watch/watch-screen";

export const metadata = { title: "Watch - MahekOne CRM" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string; from?: string; to?: string }>;
}) {
  await requireUser();
  const params = await searchParams;
  const range = watchRange(params, await today());
  const report = await watchReport({ from: range.from, to: range.to });

  return (
    <>
      <PageHeader
        title="Watch"
        subtitle="Every priced order line beside the book price live on its own date — and the money billed below it, most first."
      />
      <PricingSubNav basePath="/crm/price-lists" current="watch" />
      <WatchScreen basePath="/crm/price-lists" canManage={false} report={report} preset={range.preset} />
    </>
  );
}
