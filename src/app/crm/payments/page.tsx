import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import {
  followUpWorklistPage,
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
import { WORKLIST_TABS, type WorklistTab } from "@/lib/services/payment-service";
import { PaymentsScreen } from "./payments-screen";
import { latestMessageFor } from "@/lib/services/whatsapp-tracker-service";

export const metadata = { title: "Payment follow-up - MahekOne CRM" };

export default async function PaymentsPage({
  searchParams,
}: {
  /*
   * EVERY FILTER IS A URL PARAMETER, like the customers list and the leads
   * book. A filtered view of a collections list is exactly the thing one
   * telecaller sends another — "these four, nobody has chased them" — and
   * holding it in component state makes that unsendable and the back button a
   * lie. It is also what lets the filtering, the counting and the paging
   * happen in the database rather than in a browser that has been handed the
   * whole worklist.
   */
  searchParams: Promise<{
    tab?: string;
    q?: string;
    slow?: string;
    sort?: string;
    page?: string;
    per?: string;
  }>;
}) {
  const user = await requireUser();
  const scope = await getScope(user);
  const params = await searchParams;

  /* Opens on the calling list: it is the one list with work on it today. */
  const tab: WorklistTab = WORKLIST_TABS.includes(params.tab as WorklistTab)
    ? (params.tab as WorklistTab)
    : "calls";
  /* Capped on the way in. A search box is a text field on a URL anybody can
     write, and six words is already more than a search. */
  const q = params.q?.slice(0, 200) ?? "";
  const slowOnly = params.slow === "1";
  const monthEnd = params.sort === "value";

  // Open bills only. This screen reads the ledger for one reason — to hand
  // each row the bills a payment could be booked against — and then discarded
  // every settled one below, in JavaScript, after fetching the whole book.
  // On a book that is mostly paid that is most of ten thousand rows crossing
  // the wire to be dropped. Not cut by financial year: an open bill from two
  // years ago is the oldest debt on the account and the first thing anybody
  // chases.
  /*
   * THE PLAN COMES FIRST, because two of the seven tabs are its answer.
   *
   * Who is due a call or a message today is an ENGINE's verdict rather than a
   * column, so those tabs are filtered by the ids it produces. Everything else
   * the database can answer for itself. It is `cache`d, so asking for it here
   * costs nothing the screen was not already paying.
   */
  const plan = await getPaymentFollowUpPlan();

  const [worklist, bills, config, day, metrics, batch] = await Promise.all([
    followUpWorklistPage({
      tab,
      q,
      slowOnly,
      monthEnd,
      page: Number(params.page) || 1,
      perPage: Number(params.per) || undefined,
      callIds: plan.calls.map((c) => c.customerId),
      messageIds: plan.messages.map((m) => m.customerId),
    }),
    listBills({ openOnly: true }),
    getConfig(),
    today(),
    collectionsMetrics(),
    stageOneBatch(),
  ]);

  // Summed from the rows already read rather than read a second time. The
  // figure is unchanged: `agingSummary` skips settled bills anyway, and a bill
  // cannot go below zero — `allocate` caps every line at the bill's own
  // balance — so there are no negative balances that leaving them out could
  // have netted off.
  const aging = agingSummary(bills);

  // The newest WhatsApp message to each customer on this page, with how far it
  // got — sent, delivered, read, replied. One read for the whole page.
  const lastWa = await latestMessageFor(worklist.rows.map((r) => r.customerId));

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
      filters={{ tab, query: q, slowOnly, monthEnd }}
      pageInfo={{
        page: worklist.page,
        pageCount: worklist.pageCount,
        perPage: worklist.perPage,
        total: worklist.total,
        listTotal: worklist.listTotal,
      }}
      counts={worklist.counts}
      held={worklist.held}
      filteredOverdue={worklist.filteredOverdue}
      rows={worklist.rows.map((r) => ({
        ...r,
        openBills: openBillsByCustomer.get(r.customerId) ?? [],
        lastWa: lastWa[r.customerId] ?? null,
      }))}
    />
  );
}
