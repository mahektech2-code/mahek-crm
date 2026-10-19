import { requireUser } from "@/lib/auth";
import { LeadHub } from "@/components/leads/hub/lead-hub";

/*
 * THE GUARD IS NOT HERE, and that is deliberate — the same decision the
 * Manager Console's own leads layout records, for the same reason.
 *
 * Several separately grantable modules live under this path. A
 * `requireModule(user.id, "crm.leads")` here would refuse somebody holding
 * Qualification on the strength of a module they were deliberately not given.
 * So each module folder carries its own guard, and the two screens that ARE
 * `crm.leads` — the book at this path and the record under `[id]` — carry
 * theirs where they are.
 *
 * What IS here is the Leads frame (`components/leads/hub`): Today, Leads,
 * Pipeline and Insights, drawn from the modules this person holds.
 */
export default async function LeadsLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return <LeadHub>{children}</LeadHub>;
}
