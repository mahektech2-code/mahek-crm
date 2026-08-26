import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for the Accounts Customer targets screen.
 *
 * A module withheld on the access screen has to be withheld on the URL too —
 * the sidebar not drawing a link is a courtesy, and a bookmark, a shared link
 * or a typed path all reach past it. Somebody who does not hold this lands on
 * the first module they do.
 */
export default async function AccountsCustomerTargetsModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "accounts.customer-targets");
  return children;
}
