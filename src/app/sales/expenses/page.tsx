import Link from "next/link";
import { shortDate } from "@/lib/format";
import { today } from "@/lib/recompute";
import { endOfMonth } from "@/lib/business-date";
import { MonthNav } from "@/components/ui/month-nav";
import { expenseLines, type ExpenseLineRow } from "@/lib/services/expense-claims-service";
import { canDecideExpenseLines } from "@/lib/actions/sales";
import { DecideExpense } from "./decide-expense";
import { ExpenseTabs } from "./tabs";
import { expenseKindLabel, inrExact } from "./labels";
import {
  Cell,
  Empty,
  EntityLink,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  SortHead,
  Table,
} from "@/components/console/parts";
import { readSort, sortHref, sortRows, type SortColumns } from "@/components/console/sort";
import { plural } from "@/components/console/words";

export const metadata = { title: "Expenses — Sales Dashboard — MahekOne" };

/**
 * What the field spent, ONE ROW PER EXPENSE.
 *
 * Every expense a salesman logs on his phone is here the moment it syncs,
 * waiting for a decision of its own — there is no day to close and nothing
 * holds it. Allowances (the meal allowance from his punch times, the kilometre
 * allowance on his own bike or car) are worked out from the day's records and
 * listed on their own tab: they are his by the work log and need no approval.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; month?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : now.slice(0, 7);
  const from = `${month}-01`;
  const to = endOfMonth(month);

  const [all, canDecide] = await Promise.all([expenseLines({ from, to }), canDecideExpenseLines()]);

  const show = ["waiting", "decided", "allowances", "all"].includes(params.show ?? "")
    ? params.show!
    : "waiting";

  const logged = all.filter((r) => !r.allowance);
  const waiting = logged.filter((r) => r.state === "pending");
  const decided = logged.filter((r) => r.state !== "pending");
  const allowances = all.filter((r) => r.allowance);
  const rows =
    show === "all" ? all : show === "decided" ? decided : show === "allowances" ? allowances : waiting;

  const waitingPaise = waiting.reduce((n, r) => n + r.claimedPaise, 0);
  const approvedPaise = decided.reduce((n, r) => n + paidOn(r), 0);
  const allowancePaise = allowances.reduce((n, r) => n + r.claimedPaise, 0);

  /* Sorting is DISPLAY ONLY, over the rows the chip has already cut, so the
     figures above never move when somebody clicks a column. The chip and the
     month ride on every header link — a sort that dropped the month would
     look like March's expenses had vanished. */
  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(rows, sort, COLUMNS);
  const head = (key: string, text: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/expenses", sort, key, `show=${show}&month=${month}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {text}
    </SortHead>
  );

  return (
    <div className="p-6">
      <ScreenHeader
        title="Expenses"
        subtitle="Every expense a salesman logs arrives here straight away for you to approve. Allowances are worked out from his punch times and trips."
        actions={
          <div className="flex items-center gap-3">
            <Link href="/sales/expense-policy" className="text-sm font-medium">
              The policy
            </Link>
            <MonthNav month={month} basePath="/sales/expenses" />
          </div>
        }
      />
      <ExpenseTabs current="claims" month={month} />

      <MetricRow
        metrics={[
          {
            label: "To approve",
            value: String(waiting.length),
            sub: waiting.length ? inrExact(waitingPaise) : undefined,
            tone: waiting.length ? "warn" : undefined,
          },
          { label: "Approved this month", value: inrExact(approvedPaise), sub: "expenses, at the amount allowed" },
          { label: "Allowances this month", value: inrExact(allowancePaise), sub: "automatic — meals and kilometres" },
          {
            label: "Refused",
            value: String(decided.filter((r) => r.state === "rejected").length),
          },
        ]}
      />

      <FilterChips
        current={show}
        options={[
          { key: "waiting", href: `/sales/expenses?show=waiting&month=${month}`, label: "To approve", count: waiting.length },
          { key: "decided", href: `/sales/expenses?show=decided&month=${month}`, label: "Decided", count: decided.length },
          { key: "allowances", href: `/sales/expenses?show=allowances&month=${month}`, label: "Allowances", count: allowances.length },
          { key: "all", href: `/sales/expenses?show=all&month=${month}`, label: "All", count: all.length },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title={
            show === "waiting"
              ? "Nothing to approve"
              : show === "allowances"
                ? "No allowances this month"
                : show === "decided"
                  ? "Nothing decided this month"
                  : "No expenses this month"
          }
          body={
            show === "allowances"
              ? "Allowances appear as salesmen punch in and out and log trips on their own bike or car."
              : "An expense appears here the moment a salesman logs it on his phone and it reaches the office."
          }
        />
      ) : (
        <Table
          minWidth={1080}
          head={
            <>
              {head("name", "Salesman", 180)}
              {head("day", "Day", 110)}
              <HeadCell width={300}>What</HeadCell>
              {head("amount", "Amount", 130, "right")}
              <HeadCell width={200}>Status</HeadCell>
              <HeadCell align="right" width={120} />
            </>
          }
        >
          {sorted.map((r, i) => (
            <Row key={r.id} striped={i % 2 === 1}>
              <Cell truncate={180}>
                <EntityLink href={`/sales/expenses/ledger/${r.userId}?month=${month}`}>{r.userName}</EntityLink>
              </Cell>
              <Cell>{shortDate(r.day)}</Cell>
              <Cell>
                <span className="block text-[13px] font-medium text-ink">
                  {expenseKindLabel(r.kind, r.allowance)}
                </span>
                {r.remarks || r.vendorName ? (
                  <span
                    className="block truncate text-[12px] text-muted"
                    title={[r.vendorName, r.remarks].filter(Boolean).join(" · ")}
                  >
                    {[r.vendorName, r.remarks].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
                {!r.allowance ? (
                  <span className={`block text-[12px] ${r.files.length ? "text-muted" : "text-warn-ink"}`}>
                    {r.files.length ? plural(r.files.length, "bill") + " attached" : "No bill attached"}
                  </span>
                ) : null}
              </Cell>
              <Cell align="right">
                {inrExact(r.claimedPaise)}
                {!r.allowance && r.excessPaise > 0 ? (
                  <span className="block text-[12px] text-warn-ink">{inrExact(r.excessPaise)} over policy</span>
                ) : null}
              </Cell>
              <Cell>
                <Status row={r} />
                {r.state === "pending" && r.openFlags > 0 ? (
                  <Link href="/sales/exceptions" className="mt-1 block text-[12px] text-warn-ink">
                    {plural(r.openFlags, "thing")} to check
                  </Link>
                ) : null}
              </Cell>
              <Cell align="right">
                {canDecide && r.state === "pending" ? (
                  <DecideExpense
                    expenseId={r.id}
                    who={r.userName}
                    what={`${expenseKindLabel(r.kind, false)} · ${shortDate(r.day)}`}
                    claimedPaise={r.claimedPaise}
                    eligiblePaise={r.eligiblePaise}
                    remarks={r.remarks}
                    vendorName={r.vendorName}
                    billNumber={r.billNumber}
                    files={r.files}
                  />
                ) : null}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}

/** What a decided line pays: the amount allowed, the whole of it, or nothing. */
function paidOn(r: ExpenseLineRow): number {
  if (r.state === "partially_approved") return r.approvedAmountPaise ?? 0;
  if (r.state === "approved") return r.approvedAmountPaise ?? r.claimedPaise;
  return 0;
}

function Status({ row }: { row: ExpenseLineRow }) {
  if (row.state === "allowance") {
    return (
      <>
        <Pill tone="neutral">Automatic</Pill>
        <span className="block text-[12px] text-muted">From his work log</span>
      </>
    );
  }
  const by = row.decidedByName ? ` · ${row.decidedByName}` : "";
  const note = row.decisionNote ? (
    <span className="block truncate text-[12px] text-muted" title={row.decisionNote}>
      “{row.decisionNote}”
    </span>
  ) : null;
  if (row.state === "approved") {
    return (
      <>
        <Pill tone="success">Approved</Pill>
        <span className="block text-[12px] text-muted">{inrExact(paidOn(row)) + by}</span>
        {note}
      </>
    );
  }
  if (row.state === "partially_approved") {
    return (
      <>
        <Pill tone="warn">Part approved</Pill>
        <span className="block text-[12px] text-muted">{inrExact(paidOn(row)) + by}</span>
        {note}
      </>
    );
  }
  if (row.state === "rejected") {
    return (
      <>
        <Pill tone="danger">Refused</Pill>
        {by ? <span className="block text-[12px] text-muted">{by.slice(3)}</span> : null}
        {note}
      </>
    );
  }
  return <Pill tone="warn">To approve</Pill>;
}

/**
 * What each sortable column is worth. The day is compared as its own
 * `YYYY-MM-DD` text: the spelling sorts correctly on its own and every row is
 * inside one month.
 */
const COLUMNS: SortColumns<ExpenseLineRow> = {
  name: (r) => r.userName,
  day: (r) => r.day,
  amount: (r) => r.claimedPaise,
};
