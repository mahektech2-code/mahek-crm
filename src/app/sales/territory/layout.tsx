import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for the Field book. See the Approvals layout. */
export default async function BookModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "sales.territory");
  return children;
}
