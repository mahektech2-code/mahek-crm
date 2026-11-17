import { HANDSET_TABS } from "@/lib/admin-routes";
import { AdminPage, routeTabs } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { HandsetsSection } from "../handsets-section";

/** Which MBOS build every salesman's phone is running, read live. */
export default async function HandsetsPage() {
  await requirePlatformAdmin();
  return (
    <AdminPage
      title="Handsets"
      tabs={routeTabs(HANDSET_TABS, "field")}
      subtitle="Which MBOS build every salesman's phone is running, live. A phone reports its build on every sync, so an upgrade shows here the moment the app is reopened."
    >
      <HandsetsSection />
    </AdminPage>
  );
}
