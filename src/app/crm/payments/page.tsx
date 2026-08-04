import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { getFollowUpWorklist, listBills, agingSummary } from "@/lib/services/payment-service";
import { PaymentsScreen } from "./payments-screen";

export const metadata = { title: "Payment follow-up — MahekOne CRM" };

export default async function PaymentsPage() {
  const user = await requireUser();
  const scope = await getScope(user);

  const [rows, bills, aging] = await Promise.all([
    getFollowUpWorklist(),
    listBills(),
    agingSummary(),
  ]);

  // Attach each customer's open bills so a payment can be booked against a
  // specific bill without a second round trip when the modal opens.
  const openBillsByCustomer = new Map<
    string,
    Array<{ id: string; billNo: string; balance: number; dueDate: string }>
  >();
  for (const b of bills) {
    if (b.balance <= 0) continue;
    const list = openBillsByCustomer.get(b.customerId) ?? [];
    list.push({ id: b.id, billNo: b.billNo, balance: b.balance, dueDate: b.dueDate });
    openBillsByCustomer.set(b.customerId, list);
  }

  return (
    <PaymentsScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      aging={aging}
      rows={rows.map((r) => ({
        ...r,
        openBills: openBillsByCustomer.get(r.customerId) ?? [],
      }))}
    />
  );
}
