import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for My tasks — a module withheld on the Access screen is withheld on the URL too. */
export default async function CrmTasksModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.tasks");
  return children;
}
