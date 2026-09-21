import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { today } from "@/lib/recompute";
import { priceListDetail, pricingOptions } from "@/lib/services/price-list-service";
import { PriceListDetailScreen } from "@/components/pricing/price-list-detail";

export const metadata = { title: "Price list — Sales Dashboard — MahekOne" };

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
    <div className="p-6">
      <PriceListDetailScreen
        app="sales"
        basePath="/sales/price-lists"
        canManage={canManage}
        todayIso={todayIso}
        detail={detail}
        options={options}
      />
    </div>
  );
}
