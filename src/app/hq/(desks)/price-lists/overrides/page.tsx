import { OverridesPage } from "@/components/pricing/overrides/overrides-page";

export const metadata = { title: "Special prices — HQ — MahekOne" };

export default async function Page() {
  return (
    <div className="p-6">
      <OverridesPage app="founder" basePath="/hq/price-lists" />
    </div>
  );
}
