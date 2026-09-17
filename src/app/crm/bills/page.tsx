import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { getCustomer } from "@/lib/queries";
import {
  billLedgerPage,
  billLedgerTotals,
  earliestBillDate,
  openBillAges,
  type BillSort,
  type BillSortKey,
} from "@/lib/services/payment-service";
import { bucketise } from "@/lib/services/accounts-home-service";
import { today } from "@/lib/queries";
import { getConfig } from "@/lib/config/store";
import { financialYearOf, financialYearsBetween } from "@/lib/financial-year";
import { BillsScreen } from "./bills-screen";

export const metadata = { title: "Sales bills - MahekOne CRM" };

/** The columns the head offers. Anything else in the URL is not a sort. */
const SORT_KEYS: BillSortKey[] = [
  "billNo",
  "billDate",
  "dueDate",
  "customerName",
  "amount",
  "paid",
  "balance",
  "overdueDays",
];

const STATUSES = ["unpaid", "partially_paid", "paid"];

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{
    customer?: string;
    fy?: string;
    status?: string;
    bucket?: string;
    sort?: string;
    dir?: string;
    page?: string;
    per?: string;
  }>;
}) {
  const params = await searchParams;
  const customerId = params.customer;
  const user = await requireUser();
  const scope = await getScope(user);

  // The ledger is ten thousand bills across three years. A year is the cut a
  // person actually works in — Mahek's own bill numbers carry it — so the
  // current one is the default and the rest are a select away.
  const [day, earliest, config] = await Promise.all([
    today(),
    earliestBillDate(),
    getConfig(),
  ]);
  const years = financialYearsBetween(earliest, day);
  const financialYear = params.fy && years.includes(params.fy) ? params.fy : financialYearOf(day);

  /*
   * THE FILTERS, THE SORT AND THE PAGE ARE IN THE URL, and the query is what
   * applies them.
   *
   * This screen used to be handed the whole financial year — some 3,600 rows,
   * 2.4 MB of HTML to a manager — and then filter, sort and slice it in a
   * `useMemo`. Page one of seventy-two cost the download, the parse and the
   * sort of all seventy-two. The rule it was protecting is real and survives
   * unchanged: the totals, the aging strip and the export describe the WHOLE
   * filtered year and only the table is cut into pages, because a page that
   * changed the figures above it would show a different number on every click.
   * It is simply honoured by asking separate questions now.
   *
   * Nothing is trusted off the URL: a status that is not a status and a sort
   * key that is not a column are dropped rather than reaching the query.
   */
  const status = params.status && STATUSES.includes(params.status) ? params.status : undefined;
  const sortKey = (params.sort && (SORT_KEYS as string[]).includes(params.sort)
    ? params.sort
    : "billDate") as BillSortKey;
  const sort: BillSort = { key: sortKey, dir: params.dir === "asc" ? "asc" : "desc" };
  const perPage = Math.min(Math.max(Number(params.per) || 50, 1), 200);
  const page = Math.max(Number(params.page) || 1, 1);

  /*
   * The open bills of this year, read ONCE and used twice.
   *
   * It draws the aging strip, and it is also what makes the strip's bands
   * clickable: a bucket is `agingBucket(effectiveDueDate(...))`, two pure
   * functions the query cannot see, so the bills in the chosen band are named
   * by id rather than re-derived in SQL. A few hundred rows of six small
   * values on this book, never the ledger.
   */
  const ages = await openBillAges({ financialYear, customerId });
  const aging = bucketise(ages, config["bills.agingBuckets"]);
  /* Checked against the BANDS the strip draws rather than against the bills
     that happen to be in them: a band with nothing in it is a real answer —
     an empty table — and treating it as an unrecognised filter would quietly
     show the whole year instead. */
  const bucket = params.bucket && aging.buckets.some((b) => b.label === params.bucket)
    ? params.bucket
    : undefined;

  const scopedFilters = { financialYear, customerId };
  const filters = {
    ...scopedFilters,
    status,
    billIds: bucket ? ages.filter((a) => a.bucket === bucket).map((a) => a.id) : undefined,
  };

  const [ledger, filteredTotals, yearTotals, customer] = await Promise.all([
    billLedgerPage(filters, { page, perPage, sort }),
    // The footer row describes everything the filters match, not the page.
    billLedgerTotals(filters),
    // The strip above describes the YEAR, which is what it always described:
    // the status and bucket filters narrow the table beneath it, not it.
    billLedgerTotals(scopedFilters),
    customerId ? getCustomer(customerId) : null,
  ]);

  return (
    <BillsScreen
      modes={config["payments.modes"]}
      datedModes={config["payments.datedModes"]}
      today={day}
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      rows={ledger.rows}
      total={ledger.total}
      page={ledger.total ? Math.min(page, Math.max(1, Math.ceil(ledger.total / perPage))) : 1}
      perPage={perPage}
      sort={sort}
      status={status ?? null}
      bucket={bucket ?? null}
      buckets={aging.buckets}
      overdueBills={ages.filter((a) => a.overdueDays > 0).length}
      filteredTotals={filteredTotals}
      yearTotals={yearTotals}
      customerFilter={customer ? { id: customer.id, name: customer.name } : null}
      financialYear={financialYear}
      financialYears={years}
    />
  );
}
