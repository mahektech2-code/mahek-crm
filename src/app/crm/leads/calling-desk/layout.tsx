import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for this module.
 *
 * The calling desk is a module of its own, `crm.lead-calling-desk`, granted to
 * a person on the Access screen — NOT a view of All Leads, which every CRM user
 * can open. It is `offByDefault`, so granting somebody the whole CRM does not
 * carry it. One per module folder rather than one over the whole workspace: a
 * guard on `leads/` would refuse somebody holding Qualification on the strength
 * of a module they were deliberately not given.
 */
export default async function ModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.lead-calling-desk");
  return children;
}
