import { ShopsIndexPage } from "@/components/pricing/shops/shops-page";

export const metadata = { title: "What a shop pays — Founder Command Centre — MahekOne" };

export default async function Page() {
  return (
    <div className="p-6">
      <ShopsIndexPage basePath="/founder/price-lists" />
    </div>
  );
}
