import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { today } from "@/lib/recompute";
import { priceListDetail, pricingOptions } from "@/lib/services/price-list-service";
import { PriceListDetailScreen } from "@/components/pricing/price-list-detail";

export const metadata = { title: "Price list - MahekOne CRM" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const [detail, options, canManage, todayIso] = await Promise.all([
    priceListDetail(id),
    pricingOptions(),
    canFor(user, "pricelist.manage"),
    today(),
  ]);
  if (!detail) notFound();

  return (
    <div className="px-6 pt-6 pb-10">
      <PriceListDetailScreen
        app="crm"
        basePath="/crm/price-lists"
        canManage={canManage}
        todayIso={todayIso}
        detail={detail}
        options={options}
      />
    </div>
  );
}
