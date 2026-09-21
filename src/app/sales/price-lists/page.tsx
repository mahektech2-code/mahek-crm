import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { today } from "@/lib/recompute";
import { listPriceLists, pricingCounts, pricingOptions } from "@/lib/services/price-list-service";
import { PriceListsScreen } from "@/components/pricing/price-lists-screen";

export const metadata = { title: "Price lists — Sales Dashboard — MahekOne" };

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
    canFor(user, "pricelist.manage"),
    today(),
  ]);

  return (
    <div className="p-6">
      <PriceListsScreen
        app="sales"
        basePath="/sales/price-lists"
        canManage={canManage}
        todayIso={todayIso}
        lists={lists}
        counts={counts}
        options={options}
      />
    </div>
  );
}
