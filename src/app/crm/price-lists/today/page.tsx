import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { priceDeskToday } from "@/lib/services/price-today-service";
import { TodayScreen } from "@/components/pricing/today/today-screen";

export const metadata = { title: "Price Desk · Today - MahekOne CRM" };

/**
 * The Price Desk's morning, read-only. The CRM quotes prices and never sets
 * them (`priceListDoorCanManage` answers false here whatever the person
 * holds), so Dismiss and Run are not drawn — and the actions refuse anyway.
 */
export default async function Page() {
  const user = await requireUser();
  const day = await today();
  const data = await priceDeskToday(day, user.id);
  return (
    <div className="px-6 pt-6 pb-10">
      <TodayScreen basePath="/crm/price-lists" canManage={false} data={data} />
    </div>
  );
}
