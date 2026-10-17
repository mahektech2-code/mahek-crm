import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { requireModule } from "@/lib/access";

/**
 * The route guard for Status Requests.
 *
 * TWO CHECKS, because they answer different questions.
 *
 * `requireModule` asks whether this person was given the screen — the same
 * check every other CRM module makes, so the access console can withhold it
 * from one manager without touching another.
 *
 * The capability check is the one this screen needs on top. A module nobody has
 * narrowed is HELD by everybody holding the app: "no module rows for an app
 * means every module of it". So without this, adding the module would have put
 * an approval queue in front of every telecaller — including the ones whose own
 * requests are sitting in it.
 *
 * Deciding is `customer.deactivate`, and the actions enforce that themselves.
 * This asks the SAME capability rather than `isManager` — the widest level held
 * in any app, which let a telecaller who managed Reports open the queue and
 * shut out nobody the capability would have — so the screen agrees with the
 * actions rather than rendering Approve buttons that would refuse.
 */
export default async function DeactivationsModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  // The KEY, not the route. This folder is `status-requests` and the grant is
  // still `crm.deactivations` — see lib/modules.ts, where the two are written
  // out separately for exactly this reason.
  await requireModule(user.id, "crm.deactivations");
  // To the dashboard rather than /apps: they hold the CRM, just not this.
  if (!(await canFor(user, "customer.deactivate"))) redirect("/crm/dashboard");
  return children;
}
