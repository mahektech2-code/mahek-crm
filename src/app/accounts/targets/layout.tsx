import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for the Accounts Sales targets screen.
 *
 * A module withheld on the access screen has to be withheld on the URL too —
 * the sidebar not drawing a link is a courtesy, and a bookmark, a shared link
 * or a typed path all reach past it. Somebody who does not hold this lands on
 * the first module they do. The page itself checks `target.set` again, the
 * same as `/sales/targets` does — this layout is about which SCREEN somebody
 * may open, the capability is about which ACTION they may take, and a bare
 * module grant with no capability behind it must not draw a screen that then
 * refuses every save.
 */
export default async function AccountsTargetsModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "accounts.targets");
  return children;
}
