import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { currentPeriod, listTargets, today } from "@/lib/queries";
import { daysBetween } from "@/lib/format";
import { TargetsScreen } from "./targets-screen";

export const metadata = { title: "Monthly targets — MahekOne CRM" };

export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period } = await searchParams;
  const user = await requireUser();
  const scope = await getScope(user);
  const activePeriod = period ?? currentPeriod();

  const rows = await listTargets(user, scope, activePeriod);
  const t = today();

  return (
    <TargetsScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      period={activePeriod}
      rows={rows.map((r) => ({
        customerId: r.customerId,
        customerName: r.customerName,
        ownerName: r.ownerName,
        target: r.target,
        achieved: r.achieved,
        gap: r.gap,
        percent: r.percent,
        isDefault: r.isDefault,
        cycleDays: r.cycleDays,
        daysSinceContact: r.lastContact
          ? daysBetween(r.lastContact.toISOString().slice(0, 10), t)
          : null,
      }))}
    />
  );
}
