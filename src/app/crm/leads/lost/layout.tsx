import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for this module.
 *
 * `crm.lead-lost` is off by default — see its note in `lib/modules.ts` — so a
 * grant of the whole CRM does not carry it. This is the ONLY gate: there is no
 * separate check in the sidebar, because a hidden link is not a permission.
 */
export default async function ModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.lead-lost");
  return children;
}
