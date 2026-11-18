import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { partyToAnyDeadRequest } from "@/lib/services/lead-dead-service";

/**
 * The route guard for Dead Leads.
 *
 * `crm.lead-dead` is off by default — see its note in `lib/modules.ts`. It is
 * the grant that shows the WHOLE Dead list. Anybody who is party to a Dead
 * request — the person who asked, or the manager the Org Chart routed it to —
 * is let in as well, because the approver is chosen by the Org Chart and not by
 * a grant, and a manager must be able to open the page their request
 * notification links to. The page shows such a person only their own requests;
 * it never widens what they may read.
 */
export default async function DeadLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (await partyToAnyDeadRequest(user.id)) return children;
  await requireModule(user.id, "crm.lead-dead");
  return children;
}
