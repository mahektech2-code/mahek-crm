import { OverridesPage } from "@/components/pricing/overrides/overrides-page";

export const metadata = { title: "Special prices - MahekOne CRM" };

/** Read-only: the CRM quotes prices and never sets them. */
export default async function Page() {
  return <OverridesPage app="crm" basePath="/crm/price-lists" />;
}
