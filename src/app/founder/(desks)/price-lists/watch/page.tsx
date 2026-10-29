/* ---------------------------------------------------------------------------
 * WATCH — the Founder Command Centre's door onto every order line against the
 * book live on its own date. The window is a SEARCH PARAM read against the
 * business day here, because a component may not read the clock.
 * ------------------------------------------------------------------------- */
import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { priceListDoorCanManage } from "@/lib/price-list-door";
import { watchRange } from "@/lib/engines/price-watch";
import { watchReport } from "@/lib/services/price-watch-service";
import { PageHeader } from "@/components/ui/primitives";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { WatchScreen } from "@/components/pricing/watch/watch-screen";

export const metadata = { title: "Watch — Founder Command Centre — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const range = watchRange(params, await today());
  const [report, canManage] = await Promise.all([
    watchReport({ from: range.from, to: range.to }),
    priceListDoorCanManage(user, "founder"),
  ]);

  return (
    <div className="p-6">
      <PageHeader
        title="Watch"
        subtitle="Every priced order line beside the book price live on its own date — and the money billed below it, most first."
      />
      <PricingSubNav basePath="/founder/price-lists" current="watch" />
      <WatchScreen basePath="/founder/price-lists" canManage={canManage} report={report} preset={range.preset} />
    </div>
  );
}
