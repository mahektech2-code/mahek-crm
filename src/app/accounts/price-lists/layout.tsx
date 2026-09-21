import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for Price lists on the Accounts side.
 *
 * WHY THIS DOOR EXISTS. `pricelist.manage` sits in `ACCOUNTS_OR_MANAGER`, so
 * an accounts manager has held it since the capability shipped — and accounts
 * hold `apps: ["accounts"]`, which `src/app/crm/layout.tsx` and
 * `src/app/sales/layout.tsx` both redirect away before they reach a screen. So
 * the people the capability was written for had nowhere to use it. That is the
 * same gap `accounts.targets` was added to close, and it is the gap this
 * closes: two accounts managers on the production book held the capability and
 * could not open a price list.
 *
 * It is the SAME screens, the same service and the same actions — one feature
 * reached from a third door, never a second price list system.
 *
 * A module withheld on the Access screen is withheld on the URL too: the
 * sidebar not drawing a link is a courtesy, and a bookmark reaches past it.
 */
export default async function AccountsPriceListsModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "accounts.price-lists");
  return children;
}
