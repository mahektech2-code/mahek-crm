import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { listCustomers, listTeam } from "@/lib/queries";
import { CustomersScreen } from "./customers-screen";

export const metadata = { title: "Customers — MahekOne CRM" };

export default async function CustomersPage() {
  const user = await requireUser();
  const scope = await getScope(user);

  const [rows, team] = await Promise.all([
    listCustomers(),
    listTeam(),
  ]);

  return (
    <CustomersScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      team={team.map((t) => ({ id: t.id, name: t.name }))}
      rows={rows.map((c) => ({
        id: c.id,
        name: c.name,
        contactPerson: c.contactPerson,
        phone: c.phone,
        city: c.city,
        ownerId: c.ownerId,
        ownerName: c.ownerName,
        kind: c.kind,
        leadSource: c.leadSource,
        salesAmName: c.salesAmName,
        backOfficeAmId: c.backOfficeAmId,
        backOfficeAmName: c.backOfficeAmName,
        status: c.status,
        lastOrderDate: c.lastOrderDate,
        lastContactAt: c.lastContactDate,
        outstanding: c.outstanding,
        slowPayer: c.slowPayer,
        openComplaints: c.openComplaints,
        gstin: c.gstin,
        creditTermDays: c.creditTermDays,
        cycleDays: c.cycleDays,
        route: c.route,
        deactivationRequested: c.deactivationRequested,
      }))}
    />
  );
}
