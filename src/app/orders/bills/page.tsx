import { getConfig } from "@/lib/config/store";
import {
  financialYearOf,
  financialYearsBetween,
} from "@/lib/financial-year";
import { earliestBillDate, listBills } from "@/lib/services/payment-service";
import { bucketise } from "@/lib/services/accounts-home-service";
import { today } from "@/lib/recompute";
import { BillsScreen } from "./bills-screen";

export const metadata = { title: "Bills — Accounts — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>;
}) {
  const params = await searchParams;
  const [day, earliest, config] = await Promise.all([
    today(),
    earliestBillDate(),
    getConfig(),
  ]);

  const current = financialYearOf(day);
  // Only years that actually have bills in them are offered — a filter that
  // returns an empty screen reads as a broken ledger.
  const years = financialYearsBetween(earliest ?? day, day);
  const financialYear = params.fy && years.includes(params.fy) ? params.fy : current;

  const rows = await listBills({ financialYear });

  // The strip describes what is OPEN in this year, not what was billed in it.
  const aging = bucketise(
    rows
      .filter((r) => r.balance > 0)
      .map((r) => ({ overdueDays: r.overdueDays, balance: r.balance })),
    config["bills.agingBuckets"],
  );

  return (
    <BillsScreen
      rows={rows.map((r) => ({
        id: r.id,
        billNo: r.billNo,
        customerId: r.customerId,
        customerName: r.customerName,
        billDate: r.billDate,
        dueDate: r.dueDate,
        amount: r.amount,
        paid: r.paid,
        balance: r.balance,
        overdueDays: r.overdueDays,
        status: r.status,
        disputed: r.disputed,
      }))}
      buckets={aging.buckets}
      years={years}
      financialYear={financialYear}
    />
  );
}
