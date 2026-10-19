import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { LeadHub } from "@/components/leads/hub/lead-hub";

/**
 * The route guard for this module.
 *
 * One per module folder rather than one over the whole workspace: these are
 * ten separately grantable modules, so a guard on `leads/` would refuse
 * somebody holding Qualification on the strength of a module they were
 * deliberately not given.
 */
export default async function ModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.samples");
  /* Samples are a desk of the Leads frame's Pipeline. */
  return <LeadHub>{children}</LeadHub>;
}
