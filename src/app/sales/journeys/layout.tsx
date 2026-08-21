import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for Journey planning. See the Approvals layout. */
export default async function JourneysModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "sales.journeys");
  return children;
}
