import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for Price lists on the Founder Dashboard.
 *
 * The fourth door onto the same feature, and the second that may WRITE: Mahek
 * named the founder's desk beside the accounts team as who adds, changes and
 * deletes a price list (see `PRICE_DESK` in access-control.ts). Same screens,
 * same service, same actions — never a second price list system.
 *
 * The founder shell has no padding of its own around a page, so the pages
 * under this route supply it exactly as the Accounts ones do.
 */
export default async function FounderPriceListsModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "founder.price-lists");
  return children;
}
