import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for this module.
 *
 * The calling desk is a fourth view of the book — List, Board, Dashboard, and
 * the phone work — so it is guarded by `crm.leads` exactly as the other three
 * are. One per module folder rather than one over the whole workspace: a guard
 * on `leads/` would refuse somebody holding Qualification on the strength of a
 * module they were deliberately not given.
 */
export default async function ModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.leads");
  return children;
}
