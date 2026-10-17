import Link from "next/link";
import { shortDate, shortDateWithYear } from "@/lib/format";
import { today } from "@/lib/recompute";
import { readPeriod } from "@/lib/expense-period";
import { expenseClaimants, expensePayees } from "@/lib/services/expense-ledger-service";
import {
  expenseLines,
  type ExpenseLineRow,
} from "@/lib/services/expense-claims-service";
import { canDecideExpenseLines, canRecordExpensePayouts } from "@/lib/actions/sales";
import { AddExpense } from "./add-expense";
import { DecideExpense } from "./decide-expense";
import { ExpenseTabs } from "./tabs";
import { FilterRow, PeriodPicker } from "./filters";
import { hrefWith, keepString, queryOf } from "./query";
import {
  BILL_OPTIONS,
  POLICY_OPTIONS,
  kindOptions,
  matchesLine,
  type LineFilters,
} from "./line-filters";
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
import {
  readSort,
  sortHref,
  sortRows,
  type SortColumns,
} from "@/components/console/sort";
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
const KEYS = [
  "period",
  "on",
  "from",
  "to",
  "month",
  "show",
  "who",
  "kind",
  "bill",
  "policy",
  "q",
  "sort",
  "dir",
];

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = queryOf(await searchParams, KEYS);
  const now = await today();
  const period = readPeriod(query, now);

  const [inPeriodRows, claimants, canDecide, canAdd, payees] = await Promise.all([
    expenseLines({
      from: period.from ?? undefined,
      to: period.to ?? undefined,
    }),
    expenseClaimants(),
    canDecideExpenseLines(),
    canRecordExpensePayouts(),
    expensePayees(),
  ]);

  const filters: LineFilters = {
    who: query.who,
    kind: query.kind,
    bill: query.bill,
    policy: query.policy,
    q: query.q,
  };
  /* Every figure and every chip count reads the FILTERED rows, so picking a
     salesman makes the whole screen his — the chips then cut by status. */
  const all = inPeriodRows.filter((r) => matchesLine(r, filters));

  const show = [
    "waiting",
    "approved",
    "refused",
    "decided",
    "allowances",
    "all",
  ].includes(query.show ?? "")
    ? query.show!
    : "waiting";

  const logged = all.filter((r) => !r.allowance);
  const waiting = logged.filter((r) => r.state === "pending");
  const approved = logged.filter(
    (r) => r.state === "approved" || r.state === "partially_approved",
  );
  const refused = logged.filter((r) => r.state === "rejected");
  const allowances = all.filter((r) => r.allowance);
  const rows =
    show === "all"
      ? all
      : show === "approved"
        ? approved
        : show === "refused"
          ? refused
          : show === "decided"
            ? [...approved, ...refused]
            : show === "allowances"
              ? allowances
              : waiting;

  const sum = (list: ExpenseLineRow[], pick: (r: ExpenseLineRow) => number) =>
    list.reduce((n, r) => n + pick(r), 0);
  const claimedPaise = sum(logged, (r) => r.claimedPaise);
  const waitingPaise = sum(waiting, (r) => r.claimedPaise);
  const approvedPaise = sum(approved, paidOn);
  const refusedPaise = sum(refused, (r) => r.claimedPaise);
  const allowancePaise = sum(allowances, (r) => r.claimedPaise);

  /* Sorting is DISPLAY ONLY, over the rows the chip has already cut, so the
     figures above never move when somebody clicks a column. The period, the
     chip and every filter ride on each header link. */
  const sort = readSort(query, COLUMNS);
  const sorted = sortRows(rows, sort, COLUMNS);
  const keep = keepString(query, ["sort", "dir"]);
  const head = (
    key: string,
    text: string,
    width?: number,
    align?: "left" | "right",
  ) => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/expenses", sort, key, keep)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {text}
    </SortHead>
  );
  const chip = (key: string) =>
    hrefWith("/sales/expenses", query, { show: key });
  const ledgerQuery = hrefWith("", {
    ...query,
    show: undefined,
    kind: undefined,
    bill: undefined,
    policy: undefined,
    q: undefined,
    sort: undefined,
    dir: undefined,
    who: undefined,
  });
  const when = period.kind === "all" ? "" : ` ${period.noun}`;

  return (
    <div className="p-6">
      <ScreenHeader
        title="Expenses"
        subtitle="Every expense a salesman logs arrives here straight away for you to approve. Allowances are worked out from his punch times and trips."
        actions={
          <div className="flex items-start gap-4">
            <Link
              href="/sales/expense-policy"
              className="mt-1.5 text-sm font-medium"
            >
              The policy
            </Link>
            <PeriodPicker
              key={period.label}
              period={period}
              today={now}
              basePath="/sales/expenses"
              query={query}
            />
            {canAdd ? (
              <AddExpense people={payees} defaultUserId={query.who} today={now} canApprove={canDecide} />
            ) : null}
          </div>
        }
      />
      <ExpenseTabs current="claims" query={query} />

      <MetricRow
        metrics={[
          {
            label: "To approve",
            value: String(waiting.length),
            sub: waiting.length ? inrExact(waitingPaise) : undefined,
            tone: waiting.length ? "warn" : undefined,
          },
          {
            label: `Claimed${when}`,
            value: inrExact(claimedPaise),
            sub: plural(logged.length, "expense"),
          },
          {
            label: "Approved",
            value: inrExact(approvedPaise),
            sub: "at the amount allowed",
            tone: approvedPaise ? "success" : undefined,
          },
          {
            label: "Refused",
            value: inrExact(refusedPaise),
            sub: plural(refused.length, "expense"),
            tone: refused.length ? "danger" : undefined,
          },
          {
            label: "Allowances",
            value: inrExact(allowancePaise),
            sub: "automatic — meals and kilometres",
          },
        ]}
      />

      <FilterRow
        basePath="/sales/expenses"
        query={query}
        search="Search"
        filters={[
          {
            param: "who",
            all: "All salesmen",
            label: "Salesman",
            value: query.who ?? "",
            options: claimants.map((c) => ({ value: c.id, label: c.name })),
          },
          {
            param: "kind",
            all: "All types",
            label: "Type",
            value: query.kind ?? "",
            options: kindOptions(inPeriodRows),
          },
          {
            param: "policy",
            all: "Any policy result",
            label: "Policy",
            value: query.policy ?? "",
            options: POLICY_OPTIONS,
          },
          {
            param: "bill",
            all: "Bill or not",
            label: "Bill",
            value: query.bill ?? "",
            options: BILL_OPTIONS,
          },
        ]}
      >
        {query.who ? (
          <Link
            href={`/sales/expenses/ledger/${query.who}${ledgerQuery}`}
            className="text-[13px] font-medium"
          >
            Open his ledger →
          </Link>
        ) : null}
      </FilterRow>

      <FilterChips
        current={show === "decided" ? "approved" : show}
        options={[
          {
            key: "waiting",
            href: chip("waiting"),
            label: "To approve",
            count: waiting.length,
          },
          {
            key: "approved",
            href: chip("approved"),
            label: "Approved",
            count: approved.length,
          },
          {
            key: "refused",
            href: chip("refused"),
            label: "Refused",
            count: refused.length,
          },
          {
            key: "allowances",
            href: chip("allowances"),
            label: "Allowances",
            count: allowances.length,
          },
          { key: "all", href: chip("all"), label: "All", count: all.length },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title={
            show === "waiting"
              ? "Nothing to approve"
              : show === "allowances"
                ? "No allowances"
                : show === "refused"
                  ? "Nothing refused"
                  : show === "approved" || show === "decided"
                    ? "Nothing approved"
                    : "No expenses"
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
                <EntityLink
                  href={`/sales/expenses/ledger/${r.userId}${ledgerQuery}`}
                >
                  {r.userName}
                </EntityLink>
              </Cell>
              <Cell>{shortDateWithYear(r.day, now)}</Cell>
              <Cell>
                <span className="block text-[13px] font-medium text-ink">
                  {expenseKindLabel(r.kind, r.allowance)}
                </span>
                {r.remarks || r.vendorName ? (
                  <span
                    className="block truncate text-[12px] text-muted"
                    title={[r.vendorName, r.remarks]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    {[r.vendorName, r.remarks].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
                {!r.allowance ? (
                  <span
                    className={`block text-[12px] ${r.files.length ? "text-muted" : "text-warn-ink"}`}
                  >
                    {r.files.length
                      ? plural(r.files.length, "bill") + " attached"
                      : "No bill attached"}
                  </span>
                ) : null}
                {r.enteredByName ? (
                  <span className="block text-[12px] text-muted">Entered by {r.enteredByName}</span>
                ) : null}
              </Cell>
              <Cell align="right">
                {inrExact(r.claimedPaise)}
                {!r.allowance && r.excessPaise > 0 ? (
                  <span className="block text-[12px] text-warn-ink">
                    {inrExact(r.excessPaise)} over policy
                  </span>
                ) : null}
              </Cell>
              <Cell>
                <Status row={r} />
                {r.state === "pending" && r.openFlags > 0 ? (
                  <Link
                    href="/sales/exceptions"
                    className="mt-1 block text-[12px] text-warn-ink"
                  >
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
    <span
      className="block truncate text-[12px] text-muted"
      title={row.decisionNote}
    >
      “{row.decisionNote}”
    </span>
  ) : null;
  if (row.state === "approved") {
    return (
      <>
        <Pill tone="success">Approved</Pill>
        <span className="block text-[12px] text-muted">
          {inrExact(paidOn(row)) + by}
        </span>
        {note}
      </>
    );
  }
  if (row.state === "partially_approved") {
    return (
      <>
        <Pill tone="warn">Part approved</Pill>
        <span className="block text-[12px] text-muted">
          {inrExact(paidOn(row)) + by}
        </span>
        {note}
      </>
    );
  }
  if (row.state === "rejected") {
    return (
      <>
        <Pill tone="danger">Refused</Pill>
        {by ? (
          <span className="block text-[12px] text-muted">{by.slice(3)}</span>
        ) : null}
        {note}
      </>
    );
  }
  return <Pill tone="warn">To approve</Pill>;
}

/**
 * What each sortable column is worth. The day is compared as its own
 * `YYYY-MM-DD` text: the spelling sorts correctly on its own and every row is
 * text across any period.
 */
const COLUMNS: SortColumns<ExpenseLineRow> = {
  name: (r) => r.userName,
  day: (r) => r.day,
  amount: (r) => r.claimedPaise,
};
