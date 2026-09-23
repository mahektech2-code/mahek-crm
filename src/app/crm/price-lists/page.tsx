import { priceListDoorCanManage } from "@/lib/price-list-door";
import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { listPriceLists, pricingCounts, pricingOptions } from "@/lib/services/price-list-service";
import { PriceListsScreen } from "@/components/pricing/price-lists-screen";

export const metadata = { title: "Price lists - MahekOne CRM" };

/**
 * Every price list, read once.
 *
 * `pricelist.read` is held by everybody signed in — a price a telecaller
 * cannot see is a price they guess — and `pricelist.manage` is what decides
 * whether the controls that CHANGE one are drawn. The action checks it again,
 * because a hidden button is not a permission.
 *
 * `today()` is read here and handed down, because a component may not read the
 * clock during render.
 */
export default async function Page() {
  const user = await requireUser();
  const [lists, counts, options, canManage, todayIso] = await Promise.all([
    listPriceLists(),
    pricingCounts(),
    pricingOptions(),
    priceListDoorCanManage(user, "crm"),
    today(),
  ]);

  return (
    <div className="px-6 pt-6 pb-10">
      <PriceListsScreen
        app="crm"
        basePath="/crm/price-lists"
        canManage={canManage}
        todayIso={todayIso}
        lists={lists}
        counts={counts}
        options={options}
      />
    </div>
  );
}
