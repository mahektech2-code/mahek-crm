import { ADMIN_TABS, tabIndexOf } from "@/lib/admin-routes";
import { auditFeed, parseAuditFilters } from "@/lib/services/audit-feed-service";
import { today } from "@/lib/queries";
import { AdminPage } from "../../_shell/admin-page";
import { requirePlatformAdmin } from "../../_shell/context";
import { AuditActions, AuditLogScreen } from "../audit-log-screen";

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePlatformAdmin();
  const [{ tab }, search] = await Promise.all([params, searchParams]);
  const slug = ADMIN_TABS.audit[tabIndexOf(ADMIN_TABS.audit, tab?.[0])].slug;
  const filters = parseAuditFilters(search, slug);
  const open = typeof search.open === "string" ? search.open : null;
  const [feed, day] = await Promise.all([auditFeed(filters), today()]);
  return (
    <AdminPage
      title="Audit log"
      subtitle="Everything that has happened in MahekOne, who did it, and what changed — in plain words. Open any line to see the details."
      actions={<AuditActions feed={feed} filters={filters} today={day} />}
    >
      <AuditLogScreen feed={feed} filters={filters} today={day} open={open} />
    </AdminPage>
  );
}
