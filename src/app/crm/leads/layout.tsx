import { requireUser } from "@/lib/auth";

/*
 * THE GUARD IS NOT HERE, and that is deliberate — the same decision the
 * Manager Console's own leads layout records, for the same reason.
 *
 * Nine separately grantable modules live under this path: Funnel, Intake,
 * Qualification, Commercial, Appointments, Next actions, Handovers and
 * Oversight. A `requireModule(user.id, "crm.leads")` here would refuse
 * somebody holding Qualification on the strength of a module they were
 * deliberately not given — a grant they hold, refused by the folder above it.
 *
 * So each module folder carries its own guard, and the two screens that ARE
 * `crm.leads` — the book at this path and the record under `[id]` — carry
 * theirs where they are. Nothing is ungated: `lead-workspace.test.ts` asserts
 * every section names a real module in BOTH workspaces, and the CRM layout
 * above has already refused anybody without the app.
 */
export default async function LeadsLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return children;
}
