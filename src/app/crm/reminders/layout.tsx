import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for Reminders.
 *
 * A module withheld on the access screen has to be withheld on the URL too —
 * the sidebar not drawing a link is a courtesy, and a bookmark, a shared link
 * or a typed path all reach past it. Somebody who does not hold this lands on
 * the first module they do.
 *
 * A layout rather than a check inside the page: everything under this route is
 * this module, so the guard belongs to the folder rather than to each screen
 * that will ever be added inside it.
 */
export default async function RemindersModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "crm.reminders");
  return children;
}
