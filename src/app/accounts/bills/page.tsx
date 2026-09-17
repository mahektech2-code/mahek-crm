import { getConfig } from "@/lib/config/store";
import {
  financialYearOf,
  financialYearsBetween,
} from "@/lib/financial-year";
import {
  billLedgerPage,
  billLedgerTotals,
  earliestBillDate,
  openBillAges,
} from "@/lib/services/payment-service";
import { bucketise } from "@/lib/services/accounts-home-service";
import { today } from "@/lib/recompute";
import { BillsScreen } from "./bills-screen";

export const metadata = { title: "Bills — Accounts — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string; page?: string; per?: string }>;
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

  /*
   * THREE READS SHAPED TO THREE QUESTIONS, instead of one read shaped to none.
   *
   * This asked `listBills` for the whole financial year and handed every row to
   * the browser, which then sliced 25 out of it. The pager worked; it was
   * paging a set the server had already fetched, parsed and serialised into the
   * page. Clicking page 2 was free because page 1 had paid for all of it.
   *
   * The rule it was protecting stands — the totals and the aging strip describe
   * the WHOLE year, not the page, because a total that changed as you paged
   * would be a different figure on every click. It is simply honoured by asking
   * three questions now: the page, the sums, and the ages of the open bills.
   */
  const perPage = Math.min(Math.max(Number(params.per) || 25, 1), 200);
  const page = Math.max(Number(params.page) || 1, 1);

  const [ledger, totals, ages] = await Promise.all([
    billLedgerPage({ financialYear }, { page, perPage }),
    billLedgerTotals({ financialYear }),
    // The strip describes what is OPEN in this year, not what was billed in it.
    openBillAges({ financialYear }),
  ]);

  const aging = bucketise(ages, config["bills.agingBuckets"]);

  return (
    <BillsScreen
      rows={ledger.rows.map((r) => ({
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
      total={ledger.total}
      page={page}
      perPage={perPage}
      totals={totals}
      buckets={aging.buckets}
      openBills={ages.length}
      years={years}
      financialYear={financialYear}
    />
  );
}
