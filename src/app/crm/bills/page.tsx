import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { getCustomer } from "@/lib/queries";
import { agingSummary, listBills } from "@/lib/services/payment-service";
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

  const [rows, aging, customer] = await Promise.all([
    listBills(),
    agingSummary(),
    customerId ? getCustomer(customerId) : null,
  ]);

  return (
    <BillsScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      rows={rows}
      aging={aging}
      customerFilter={customer ? { id: customer.id, name: customer.name } : null}
    />
  );
}
