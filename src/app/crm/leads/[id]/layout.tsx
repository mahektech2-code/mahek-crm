import { requireUser } from "@/lib/auth";
import { canOpenModule, requireModule } from "@/lib/access";

/**
 * The route guard for this module.
 *
 * One per module folder rather than one over the whole workspace: these are
 * ten separately grantable modules, so a guard on `leads/` would refuse
 * somebody holding Qualification on the strength of a module they were
 * deliberately not given.
 *
 * THE LEAD RECORD IS ONE SCREEN FOR EVERYBODY WHO WORKS A LEAD, so it opens
 * for All Leads, the Calling desk or the Sales Manager workspace. Holding
 * either desk is NOT holding All Leads: what such a person may read is still
 * narrowed by the read itself (a Sales Manager to their seat, see
 * `holdsSeatWithoutAllLeads`; a Telecaller to their book), and every action
 * goes on asking its own capability.
 */
export default async function ModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  for (const key of ["crm.leads", "crm.lead-calling-desk", "crm.sales-manager"]) {
    if (await canOpenModule(user.id, key)) return children;
  }
  await requireModule(user.id, "crm.leads");
  return children;
}
