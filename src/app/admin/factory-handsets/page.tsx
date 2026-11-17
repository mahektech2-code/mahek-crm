import { HANDSET_TABS } from "@/lib/admin-routes";
import { AdminPage, routeTabs } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { FactoryHandsetsSection } from "../factory-handsets-section";

/** Every factory phone, as it last described itself, read live. */
export default async function FactoryHandsetsPage() {
  await requirePlatformAdmin();
  return (
    <AdminPage
      title="Handsets"
      tabs={routeTabs(HANDSET_TABS, "factory")}
      subtitle="Every Factory App phone: who is on it, which app and update it runs, the handset, and anything stopping it working. A phone reports every few minutes while somebody is signed in."
    >
      <FactoryHandsetsSection />
    </AdminPage>
  );
}
