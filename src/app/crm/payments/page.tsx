import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import {
  getFollowUpWorklist,
  getPaymentFollowUpPlan,
  collectionsMetrics,
  listBills,
  agingSummary,
} from "@/lib/services/payment-service";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/queries";
import { addDays, daysInMonth, isWorkingDay } from "@/lib/business-date";
import {
  offeredPayOutcomes,
  stageOneBatch,
} from "@/lib/services/payment-followup-service";
import { PaymentsScreen } from "./payments-screen";

export const metadata = { title: "Payment follow-up - MahekOne CRM" };

export default async function PaymentsPage() {
  const user = await requireUser();
  const scope = await getScope(user);

  // Open bills only. This screen reads the ledger for one reason — to hand
  // each row the bills a payment could be booked against — and then discarded
  // every settled one below, in JavaScript, after fetching the whole book.
  // On a book that is mostly paid that is most of ten thousand rows crossing
  // the wire to be dropped. Not cut by financial year: an open bill from two
  // years ago is the oldest debt on the account and the first thing anybody
  // chases.
  const [rows, bills, config, day, plan, metrics, batch] = await Promise.all([
    getFollowUpWorklist(),
    listBills({ openOnly: true }),
    getConfig(),
    today(),
    getPaymentFollowUpPlan(),
    collectionsMetrics(),
    stageOneBatch(),
  ]);

  // Summed from the rows already read rather than read a second time. The
  // figure is unchanged: `agingSummary` skips settled bills anyway, and a bill
  // cannot go below zero — `allocate` caps every line at the bill's own
  // balance — so there are no negative balances that leaving them out could
  // have netted off.
  const aging = agingSummary(bills);

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
      modes={config["payments.modes"]}
      datedModes={config["payments.datedModes"]}
      today={day}
      scopeLabel={scopeLabel(scope, user)}
      // On a team list a row is somebody else's account, and whoever is
      // reading it has to know whose. On their own book every row is theirs,
      // so naming a person on each one is a column of the same word repeated.
      showAssignee={scope === "team"}
      isManager={isManager(user)}
      aging={aging}
      workingDaysLeft={workingDaysLeft}
      plan={plan}
      outcomes={offeredPayOutcomes()}
      metrics={metrics}
      batchCount={batch.templateId ? batch.customerIds.length : 0}
      rows={rows.map((r) => ({
        ...r,
        openBills: openBillsByCustomer.get(r.customerId) ?? [],
      }))}
    />
  );
}
