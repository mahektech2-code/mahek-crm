import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for Price lists on the Sales Dashboard.
 *
 * A module withheld on the access screen has to be withheld on the URL too —
 * the sidebar not drawing a link is a courtesy, and a bookmark reaches past
 * it. A layout rather than a check in each page, so every screen added under
 * this route carries the guard by existing.
 */
export default async function PriceListsModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "sales.price-lists");
  return children;
}
