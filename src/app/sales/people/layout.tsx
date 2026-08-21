import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for The team. See the Approvals layout. */
export default async function TeamModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "sales.people");
  return children;
}
