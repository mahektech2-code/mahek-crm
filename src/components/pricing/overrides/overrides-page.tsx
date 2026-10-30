import "server-only";
import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { getConfig } from "@/lib/config/store";
import { priceListDoorCanManage } from "@/lib/price-list-door";
import { listOverrides } from "@/lib/services/price-book-service";
import { askersOf } from "@/lib/services/price-override-service";
import { PageHeader } from "@/components/ui/primitives";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import type { PricingApp } from "@/lib/price-list-views";
import { OverridesScreen } from "./overrides-screen";

/**
 * The Overrides tab, the same in all three doors. The CRM's is read-only —
 * `priceListDoorCanManage` answers no there for everybody — and the actions
 * check the Price Desk again whatever is drawn.
 */
export async function OverridesPage({ app, basePath }: { app: PricingApp; basePath: string }) {
  const user = await requireUser();
  const [canManage, day, overrides, config] = await Promise.all([
    priceListDoorCanManage(user, app),
    today(),
    listOverrides({ state: "all" }),
    getConfig(),
  ]);
  const askers = await askersOf([...new Set(overrides.map((o) => o.requestId).filter((x): x is string => !!x))]);
  return (
    <>
      <PageHeader
        title="Special prices"
        subtitle="One shop, one product, a price and the days it holds — and whether the shop is buying the volume it was agreed against."
      />
      <PricingSubNav basePath={basePath} current="overrides" />
      <OverridesScreen
        basePath={basePath}
        canManage={canManage}
        todayIso={day}
        endingDays={config["pricing.overrides.reminderDays"]}
        overrides={overrides}
        askers={askers}
      />
    </>
  );
}
