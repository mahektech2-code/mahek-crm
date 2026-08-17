import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for Outstanding.
 *
 * A module withheld on the access screen has to be withheld on the URL too —
 * the sidebar not drawing a link is a courtesy, and a bookmark, a shared link
 * or a typed path all reach past it.
 */
export default async function OutstandingModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "crm.outstanding");
  return children;
}
