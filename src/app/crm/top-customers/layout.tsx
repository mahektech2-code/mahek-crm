import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for Top customers. A module withheld on the access screen is
 * withheld on the URL too — a bookmark reaches past a sidebar that did not
 * draw the link.
 */
export default async function TopCustomersModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "crm.top-customers");
  return children;
}
