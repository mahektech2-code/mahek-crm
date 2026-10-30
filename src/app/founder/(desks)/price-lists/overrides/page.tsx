import { OverridesPage } from "@/components/pricing/overrides/overrides-page";

export const metadata = { title: "Special prices — Founder Command Centre — MahekOne" };

export default async function Page() {
  return (
    <div className="p-6">
      <OverridesPage app="founder" basePath="/founder/price-lists" />
    </div>
  );
}
