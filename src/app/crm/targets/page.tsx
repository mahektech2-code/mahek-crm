import { requireUser } from "@/lib/auth";
import { can } from "@/lib/access-control";
import { getScope, scopeLabel } from "@/lib/scope";
import { currentPeriod } from "@/lib/queries";
import { listTargets, shortfallAnalysis } from "@/lib/services/worklist-services";
import { MonthlyTargetsScreen } from "@/components/customers/monthly-targets-screen";

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

  const canSet = can(user.role, "target.set");
  const rows = await listTargets(activePeriod);
  // Coverage gap or customer gap — a manager-or-accounts read, so a
  // telecaller simply does not get the section rather than getting an error.
  const shortfall = can(user.role, "target.shortfall")
    ? await shortfallAnalysis(activePeriod)
    : null;

  return (
    <MonthlyTargetsScreen
      app="crm"
      basePath="/crm/targets"
      customerHrefTemplate="/crm/customers/{id}"
      scopeLabel={scopeLabel(scope, user)}
      canSet={canSet}
      period={activePeriod}
      rows={rows}
      shortfall={shortfall}
    />
  );
}
