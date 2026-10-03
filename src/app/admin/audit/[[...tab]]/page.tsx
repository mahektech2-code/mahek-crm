import { ADMIN, ADMIN_TABS, tabIndexOf, type TabsOf } from "@/lib/admin-routes";
import { auditRows } from "@/lib/services/admin-platform-service";
import { AdminPage } from "../../_shell/admin-page";
import { requirePlatformAdmin } from "../../_shell/context";
import { AuditTab } from "../../platform-real";

export default async function AuditPage({ params }: { params: Promise<{ tab?: string[] }> }) {
  await requirePlatformAdmin();
  const { tab } = await params;
  const slug = ADMIN_TABS.audit[tabIndexOf(ADMIN_TABS.audit, tab?.[0])].slug;
  return (
    <AdminPage
      title="Audit log"
      subtitle="Everything MahekOne has recorded happening. Read-only, and never editable."
      tabs={{ items: ADMIN_TABS.audit, active: slug, href: (s) => ADMIN.audit(s as TabsOf<"audit">) }}
    >
      <AuditTab data={{ audit: await auditRows() }} kind={slug} />
    </AdminPage>
  );
}
