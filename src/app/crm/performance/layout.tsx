import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for My Performance.
 *
 * Same rule as every other module folder: a screen withheld on the access
 * page has to be withheld on the URL too. What is different here is who is
 * expected to hold it — this is not a manager's screen, it is everybody's own,
 * so withholding it is the unusual case rather than the ordinary one.
 */
export default async function PerformanceModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "crm.performance");
  return children;
}
