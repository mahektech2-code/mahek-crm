import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for the Website Enquiries worklist.
 *
 * A layout rather than a check inside the page: everything under this route
 * is this module, so the guard belongs to the folder rather than to each
 * screen that will ever be added inside it (the detail page included).
 */
export default async function EnquiriesListModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "enquiries.list");
  return children;
}
