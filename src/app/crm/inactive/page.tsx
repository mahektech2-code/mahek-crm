import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { listInactive } from "@/lib/queries";
import { InactiveScreen } from "./inactive-screen";

export const metadata = { title: "Inactive watch — MahekOne CRM" };

export default async function InactivePage() {
  const user = await requireUser();
  const scope = await getScope(user);
  const rows = await listInactive(user, scope);

  return (
    <InactiveScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      rows={rows.map((r) => ({
        id: r.customer.id,
        name: r.customer.name,
        phone: r.customer.phone,
        city: r.customer.city,
        lastOrderDate: r.customer.lastOrderDate,
        daysSince: r.daysSince,
        cycleDays: r.customer.cycleDays,
        multiple: r.multiple,
        valueAtRisk: r.valueAtRisk,
        lastContact: r.lastContact ? r.lastContact.toISOString() : null,
        ageWithoutDecision: r.ageWithoutDecision,
        deactivationRequested: r.customer.deactivationRequested,
        deactivationReason: r.customer.deactivationReason,
      }))}
    />
  );
}
