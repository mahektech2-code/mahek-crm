import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { listNotifications } from "@/lib/queries";
import { today } from "@/lib/recompute";
import { pipelineSidebar } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";
import { hatForHeader } from "@/lib/hat-for-header";
import { SalesManagerShell } from "@/components/sales-lead-pipeline/proto/shell";

/**
 * The route guard for this module, and the workspace's frame.
 *
 * `crm.sales-manager` is off by default — see its note in `lib/modules.ts` —
 * so a grant of the whole CRM does not carry it.
 *
 * The frame (the prototype's wordmark bar and seven-link sidebar) is the ONLY
 * navigation drawn here: `app/crm/layout.tsx` keeps sign-in and access checks
 * but draws neither the CRM's header nor its sidebar under this route. The counts on the sidebar are read here, in the same request as the
 * page, so they are counted over the same Sales Manager book (`crm-sales-manager-scope.ts`).
 */
export default async function ModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.sales-manager");

  const day = await today();
  const [counts, notifications, hat] = await Promise.all([
    pipelineSidebar(day),
    listNotifications(user.id),
    hatForHeader(user, "crm"),
  ]);

  return (
    <SalesManagerShell user={user} hat={hat} notifications={notifications} counts={counts}>
      {children}
    </SalesManagerShell>
  );
}
