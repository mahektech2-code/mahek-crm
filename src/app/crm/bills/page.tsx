import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { getCustomer, listBills } from "@/lib/queries";
import { BillsScreen } from "./bills-screen";

export const metadata = { title: "Sales bills — MahekOne CRM" };

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const { customer: customerId } = await searchParams;
  const user = await requireUser();
  const scope = await getScope(user);

  const [rows, customer] = await Promise.all([
    listBills(user, scope),
    customerId ? getCustomer(customerId) : null,
  ]);

  return (
    <BillsScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      rows={rows}
      customerFilter={
        customer ? { id: customer.id, name: customer.name } : null
      }
    />
  );
}
