import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { currentPeriod } from "@/lib/queries";
import { listTargets, shortfallAnalysis } from "@/lib/services/worklist-services";
import { TargetsScreen } from "./targets-screen";

export const metadata = { title: "Monthly targets - MahekOne CRM" };

export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period } = await searchParams;
  const user = await requireUser();
  const scope = await getScope(user);
  const activePeriod = period ?? (await currentPeriod());

  const rows = await listTargets(activePeriod);
  // Coverage gap or customer gap — a manager-only read, so telecallers simply
  // do not get the section rather than getting an error.
  const shortfall = isManager(user) ? await shortfallAnalysis(activePeriod) : null;

  return (
    <TargetsScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      period={activePeriod}
      rows={rows}
      shortfall={shortfall}
    />
  );
}
