import { ADMIN, ADMIN_TABS, tabIndexOf } from "@/lib/admin-routes";
import { accessOverview, listAccessTemplates } from "@/lib/services/access-overview-service";
import { today } from "@/lib/queries";
import { AdminPage } from "../../_shell/admin-page";
import { requirePlatformAdmin } from "../../_shell/context";
import { PowersScreen } from "../powers-screen";

/* Access seen from the power's side. See `access-overview-service.ts`. */
export default async function PowersPage({ params }: { params: Promise<{ tab?: string[] }> }) {
  await requirePlatformAdmin();
  const { tab } = await params;
  const slug = ADMIN_TABS.powers[tabIndexOf(ADMIN_TABS.powers, tab?.[0])].slug;
  const [overview, templates, day] = await Promise.all([accessOverview(), listAccessTemplates(), today()]);
  return (
    <AdminPage
      title="Powers & screens"
      subtitle="Every power and screen in MahekOne, who holds it, and the work waiting on it. Give or take away for several people at once, or stamp a job template onto them."
      tabs={{ items: ADMIN_TABS.powers, active: slug, href: (s) => ADMIN.powers(s as (typeof ADMIN_TABS.powers)[number]["slug"]) }}
    >
      <PowersScreen tab={slug} overview={overview} templates={templates} today={day} />
    </AdminPage>
  );
}
