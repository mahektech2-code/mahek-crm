import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for this module.
 *
 * `crm.sales-manager` is off by default — see its note in `lib/modules.ts` —
 * so a grant of the whole CRM does not carry it.
 */
export default async function ModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.sales-manager");
  return children;
}
