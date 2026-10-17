import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps, requireModule } from "@/lib/access";
import { ToastProvider } from "@/components/ui/toast";

/**
 * Sales Manager — Lead Pipeline.
 *
 * ITS OWN MODULE, `sales.lead-pipeline`, guarded the way every module here is:
 * the `sales` GRANT first, then the module. `requireModule` on its own answers
 * "may this person open this module" and deliberately knows nothing about
 * whether the app was granted (no module rows means every module), so a layout
 * that called only it would open the screens for somebody who was never given
 * the Sales Dashboard at all. That is the failure `canOpenModule` exists to
 * name, and it is asked here in the same order `/sales/layout.tsx` asks it.
 *
 * It used to ride on `sales.leads` — the two screens read the same book, so
 * sharing a key seemed harmless, and it meant this workspace could not be
 * granted or withheld on its own from the Access screen. `sales.leads` still
 * guards `/sales/leads` exactly as before; this route answers to nothing else.
 *
 * Nothing here adds a permission. What a person may SEE is `managerScope` +
 * `leadsVisible` inside the reads; what they may DO is `requireCapability`
 * inside the actions. `proxy.ts` names this route as the `sales` app, so scope
 * is resolved against the Sales Dashboard grant and not the widest level the
 * account holds elsewhere.
 *
 * NO CHROME OF ITS OWN. This flow is Dashboard, Pipeline, All Leads and the Lead
 * Record; each links to the next, so `children` is the whole page.
 */
export default async function SalesLeadPipelineLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  const apps = await listUserApps(user.id);
  if (!apps.includes("sales")) redirect("/apps");
  await requireModule(user.id, "sales.lead-pipeline");

  return (
    <ToastProvider>
      <div className="min-h-screen bg-canvas">
        <div className="mx-auto w-full max-w-[1600px]">{children}</div>
      </div>
    </ToastProvider>
  );
}
