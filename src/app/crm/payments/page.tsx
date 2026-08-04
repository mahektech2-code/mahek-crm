import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import {
  getFollowUpWorklist,
  getPaymentFollowUpPlan,
  listBills,
  agingSummary,
} from "@/lib/services/payment-service";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/queries";
import { addDays, daysInMonth, isWorkingDay } from "@/lib/business-date";
import { PaymentsScreen } from "./payments-screen";

export const metadata = { title: "Payment follow-up — MahekOne CRM" };

export default async function PaymentsPage() {
  const user = await requireUser();
  const scope = await getScope(user);

  const [rows, bills, aging, config, day, plan] = await Promise.all([
    getFollowUpWorklist(),
    listBills(),
    agingSummary(),
    getConfig(),
    today(),
    getPaymentFollowUpPlan(),
  ]);

  // Working days, from configuration — a collections push measured in calendar
  // days counts Sundays nobody is going to call on.
  const lastDay = `${day.slice(0, 8)}${String(daysInMonth(day)).padStart(2, "0")}`;
  let workingDaysLeft = 0;
  for (let d = day; d <= lastDay; d = addDays(d, 1)) {
    if (
      isWorkingDay(d, {
        timezone: config["workingDay.timezone"],
        dayBoundaryHour: config["workingDay.dayBoundaryHour"],
        workingDays: config["workingDay.workingDays"],
      })
    ) {
      workingDaysLeft++;
    }
  }

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
      workingDaysLeft={workingDaysLeft}
      plan={plan}
      rows={rows.map((r) => ({
        ...r,
        openBills: openBillsByCustomer.get(r.customerId) ?? [],
      }))}
    />
  );
}
