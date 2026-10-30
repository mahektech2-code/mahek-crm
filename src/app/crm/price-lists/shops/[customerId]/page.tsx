import { ShopPricesPage } from "@/components/pricing/shops/shops-page";

export const metadata = { title: "What a shop pays - MahekOne CRM" };

/** Read-only, and narrowed to the reader's own book by `customerPricing`. */
export default async function Page({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params;
  return <ShopPricesPage basePath="/crm/price-lists" customerId={customerId} />;
}
