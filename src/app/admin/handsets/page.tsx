import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { HandsetsSection } from "../handsets-section";

/** Which MBOS build every salesman's phone is running, read live. */
export default async function HandsetsPage() {
  await requirePlatformAdmin();
  return (
    <AdminPage
      title="Handsets"
      subtitle="Which MBOS build every salesman's phone is running, live. A phone reports its build on every sync, so an upgrade shows here the moment the app is reopened."
    >
      <HandsetsSection />
    </AdminPage>
  );
}
