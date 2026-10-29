import { priceListDoorCanManage } from "@/lib/price-list-door";
import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { priceDeskToday } from "@/lib/services/price-today-service";
import { TodayScreen } from "@/components/pricing/today/today-screen";

export const metadata = { title: "Price Desk · Today — Founder Command Centre — MahekOne" };

/**
 * What needs the Price Desk this morning. `today()` is read here and handed
 * down, because a component may not read the clock during render; whether the
 * Dismiss and Run controls are drawn is the door's answer, and the actions
 * check it again.
 */
export default async function Page() {
  const user = await requireUser();
  const day = await today();
  const [data, canManage] = await Promise.all([priceDeskToday(day, user.id), priceListDoorCanManage(user, "founder")]);
  return (
    <div className="p-6">
      <TodayScreen basePath="/founder/price-lists" canManage={canManage} data={data} />
    </div>
  );
}
