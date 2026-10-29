import { ShopsIndexPage } from "@/components/pricing/shops/shops-page";

export const metadata = { title: "What a shop pays - MahekOne CRM" };

export default async function Page() {
  return <ShopsIndexPage basePath="/crm/price-lists" />;
}
