import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for this module.
 *
 * `crm.sales-manager` is off by default — see its note in `lib/modules.ts` —
 * so a grant of the whole CRM does not carry it.
 *
 * No bar is drawn here: the CRM's own header (search, notifications, account)
 * and sidebar frame this workspace like every other CRM screen, so there is
 * one of each rather than a second set. Everything under it is read over the
 * Sales Manager book (`crm-sales-manager-scope.ts`).
 */
export default async function ModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.sales-manager");
  return children;
}
