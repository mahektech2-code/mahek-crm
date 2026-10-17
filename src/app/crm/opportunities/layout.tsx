import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for Opportunities — the folder is the module, so the guard
 * belongs to it rather than to each screen that will ever be added inside.
 */
export default async function OpportunitiesModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.opportunities");
  return children;
}
