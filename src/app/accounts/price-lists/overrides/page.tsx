import { OverridesPage } from "@/components/pricing/overrides/overrides-page";

export const metadata = { title: "Special prices — Accounts — MahekOne" };

export default async function Page() {
  return (
    <div className="p-6">
      <OverridesPage app="accounts" basePath="/accounts/price-lists" />
    </div>
  );
}
