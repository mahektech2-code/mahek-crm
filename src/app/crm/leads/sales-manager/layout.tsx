import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { listNotifications } from "@/lib/queries";
import { hatForHeader } from "@/lib/hat-for-header";
import { SalesManagerShell } from "@/components/sales-lead-pipeline/desk/shell";

/**
 * The route guard for this module, and the workspace's frame.
 *
 * `crm.sales-manager` is off by default — see its note in `lib/modules.ts` —
 * so a grant of the whole CRM does not carry it.
 *
 * The frame (the prototype's wordmark bar) is the ONLY navigation chrome drawn here: `app/crm/layout.tsx` keeps sign-in and access checks
 * but draws neither the CRM's header nor its sidebar under this route. 
 * Everything under it is read over the Sales Manager book (`crm-sales-manager-scope.ts`).
 */
export default async function ModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.sales-manager");

  const [notifications, hat] = await Promise.all([
    listNotifications(user.id),
    hatForHeader(user, "crm"),
  ]);

  return (
    <SalesManagerShell user={user} hat={hat} notifications={notifications}>
      {children}
    </SalesManagerShell>
  );
}
