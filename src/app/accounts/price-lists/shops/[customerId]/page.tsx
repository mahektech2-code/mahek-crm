import { ShopPricesPage } from "@/components/pricing/shops/shops-page";

export const metadata = { title: "What a shop pays — Accounts — MahekOne" };

export default async function Page({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params;
  return (
    <div className="p-6">
      <ShopPricesPage basePath="/accounts/price-lists" customerId={customerId} />
    </div>
  );
}
