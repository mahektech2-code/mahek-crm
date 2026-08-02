import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { listBills, listPaymentFollowUps } from "@/lib/queries";
import { PaymentsScreen } from "./payments-screen";

export const metadata = { title: "Payment follow-up — MahekOne CRM" };

export default async function PaymentsPage() {
  const user = await requireUser();
  const scope = await getScope(user);

  const [rows, bills] = await Promise.all([
    listPaymentFollowUps(user, scope),
    listBills(user, scope),
  ]);

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
      rows={rows.map((r) => ({
        customerId: r.customer.id,
        name: r.customer.name,
        slowPayer: r.customer.slowPayer,
        ownerName: r.ownerName,
        outstanding: r.outstanding,
        billsOverdue: r.billsOverdue,
        oldestDays: r.oldestDays,
        lastFollowUp: r.lastFollowUp,
        stage: r.stage,
        nextAction: r.nextAction,
        promiseAmount: r.promiseAmount,
        promiseBy: r.promiseBy,
        openBills: openBillsByCustomer.get(r.customer.id) ?? [],
      }))}
    />
  );
}
