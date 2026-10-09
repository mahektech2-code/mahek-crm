import Link from "next/link";
import { shortDate } from "@/lib/format";
import { today } from "@/lib/recompute";
import { readPeriod } from "@/lib/expense-period";
import {
  expenseClaimants,
  expenseLedgerTeam,
  expensePayees,
  type LedgerTeamRow,
} from "@/lib/services/expense-ledger-service";
import { canDecideExpenseLines, canRecordExpensePayouts } from "@/lib/actions/sales";
import { AddExpense } from "../add-expense";
import {
  Cell,
  Empty,
  EntityLink,
  FilterChips,
  HeadCell,
  MetricRow,
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
import { ExpenseTabs } from "../tabs";
import { FilterRow, PeriodPicker } from "../filters";
import { hrefWith, keepString, queryOf } from "../query";
import { inrExact } from "../labels";
import { RecordPayment } from "./ledger-actions";

export const metadata = {
  title: "Expense ledger — Sales Dashboard — MahekOne",
};

/**
 * THE EXPENSE LEDGER, one row per salesman.
 *
 * The month's figures — what he claimed, what was allowed, what was refused or
 * cut, what is still waiting, what the work log earned him, what was paid —
 * beside the one figure that is never a month's: what he is OWED NOW. A
 * payout in October settles a September fare, so "due" is always all-time,
 * and the column says so. A name opens his full statement.
 */
const KEYS = [
  "period",
  "on",
  "from",
  "to",
  "month",
  "show",
  "who",
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

  const [everybody, claimants, canPay, canDecide, payees] = await Promise.all([
    expenseLedgerTeam(
      period.from && period.to ? { from: period.from, to: period.to } : null,
    ),
    expenseClaimants(),
    canRecordExpensePayouts(),
    canDecideExpenseLines(),
    expensePayees(),
  ]);

  /* The salesman filter narrows the WHOLE screen, figures included. */
  const all = query.who
    ? everybody.filter((r) => r.userId === query.who)
    : everybody;

  const show = ["all", "due", "waiting", "refused", "paid"].includes(
    query.show ?? "",
  )
    ? query.show!
    : "all";
  const owed = all.filter((r) => r.balance.duePaise > 0);
  const waiting = all.filter((r) => r.balance.pendingCount > 0);
  const refusedSome = all.filter((r) => r.period.disallowedPaise > 0);
  const paidSome = all.filter((r) => r.period.paidPaise > 0);
  const rows =
    show === "due"
      ? owed
      : show === "waiting"
        ? waiting
        : show === "refused"
          ? refusedSome
          : show === "paid"
            ? paidSome
            : all;

  const sum = (pick: (r: LedgerTeamRow) => number) =>
    all.reduce((n, r) => n + pick(r), 0);
  /* What a name carries into his statement: the period, nothing else. */
  const personQuery = hrefWith("", {
    period: query.period,
    on: query.on,
    from: query.from,
    to: query.to,
    month: query.month,
  });

  /* Owed-most first until somebody picks a column: the screen exists to pay people. */
  const picked = readSort(query, COLUMNS);
  const sort = picked.key ? picked : { key: "due", dir: "desc" as const };
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
      href={sortHref("/sales/expenses/ledger", sort, key, keep)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {text}
    </SortHead>
  );
  const chip = (key: string) =>
    hrefWith("/sales/expenses/ledger", query, { show: key });

  const label = period.noun;

  return (
    <div className="p-6">
      <ScreenHeader
        title="Expenses"
        subtitle="What each salesman claimed, what was approved, refused or cut, what his work log earned him, what he has been paid, and what is still owed to him."
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
              basePath="/sales/expenses/ledger"
              query={query}
            />
            {canPay ? (
              <AddExpense people={payees} defaultUserId={query.who} today={now} canApprove={canDecide} />
            ) : null}
          </div>
        }
      />
      <ExpenseTabs current="ledger" query={query} />

      <MetricRow
        metrics={[
          {
            label: `Claimed ${label}`,
            value: inrExact(sum((r) => r.period.claimedPaise)),
            sub: plural(
              sum((r) => r.period.claimedCount),
              "expense",
            ),
          },
          {
            label: "Approved",
            value: inrExact(sum((r) => r.period.approvedPaise)),
            sub: "at the amount allowed",
            tone: "success",
          },
          {
            label: "Refused or cut",
            value: inrExact(sum((r) => r.period.disallowedPaise)),
            sub: `${plural(
              sum((r) => r.period.refusedCount),
              "refusal",
            )} · ${sum((r) => r.period.partCount)} cut`,
            tone: sum((r) => r.period.disallowedPaise) ? "danger" : undefined,
          },
          {
            label: "Waiting",
            value: inrExact(sum((r) => r.period.pendingPaise)),
            sub: plural(
              sum((r) => r.period.pendingCount),
              "expense",
            ),
            tone: sum((r) => r.period.pendingCount) ? "warn" : undefined,
          },
          {
            label: "Allowances",
            value: inrExact(sum((r) => r.period.allowancePaise)),
            sub: "meals and kilometres",
          },
          {
            label: `Paid ${label}`,
            value: inrExact(sum((r) => r.period.paidPaise)),
          },
          {
            label: "Owed now",
            value: inrExact(sum((r) => r.balance.duePaise)),
            sub: `to ${plural(owed.length, "salesman", "salesmen")}`,
            tone: owed.length ? "warn" : undefined,
          },
        ]}
      />

      <FilterRow
        basePath="/sales/expenses/ledger"
        query={query}
        filters={[
          {
            param: "who",
            all: "All salesmen",
            label: "Salesman",
            value: query.who ?? "",
            options: claimants.map((c) => ({ value: c.id, label: c.name })),
          },
        ]}
      />

      <FilterChips
        current={show}
        options={[
          {
            key: "all",
            href: chip("all"),
            label: "Everybody",
            count: all.length,
          },
          {
            key: "due",
            href: chip("due"),
            label: "Owed money",
            count: owed.length,
          },
          {
            key: "waiting",
            href: chip("waiting"),
            label: "Expenses waiting",
            count: waiting.length,
          },
          {
            key: "refused",
            href: chip("refused"),
            label: "Refused or cut",
            count: refusedSome.length,
          },
          {
            key: "paid",
            href: chip("paid"),
            label: `Paid ${label}`,
            count: paidSome.length,
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title={show === "due" ? "Nobody is owed anything" : "No expenses yet"}
          body={
            show === "due"
              ? "Every approved expense and allowance has been paid."
              : "A salesman appears here once he logs an expense, earns an allowance or is paid."
          }
        />
      ) : (
        <Table
          minWidth={1110}
          head={
            <>
              {head("name", "Salesman", 140)}
              {head("claimed", "Claimed", 105, "right")}
              {head("approved", "Approved", 105, "right")}
              {head("disallowed", "Refused", 105, "right")}
              {head("pending", "Waiting", 105, "right")}
              {head("allowance", "Allowance", 105, "right")}
              {head("paid", "Paid", 105, "right")}
              {head("due", "Owed now", 110, "right")}
              <HeadCell width={80}>Last paid</HeadCell>
              <HeadCell align="right" width={150} />
            </>
          }
        >
          {sorted.map((r, i) => (
            <Row key={r.userId} striped={i % 2 === 1}>
              <Cell truncate={140}>
                <EntityLink
                  href={`/sales/expenses/ledger/${r.userId}${personQuery}`}
                >
                  {r.userName}
                </EntityLink>
              </Cell>
              <Cell align="right">
                {inrExact(r.period.claimedPaise)}
                <span className="block text-[12px] text-muted">
                  {plural(r.period.claimedCount, "expense")}
                </span>
              </Cell>
              <Cell align="right">
                <span className="text-success">
                  {inrExact(r.period.approvedPaise)}
                </span>
                {r.period.partCount ? (
                  <span className="block text-[12px] text-muted">
                    {r.period.partCount} in part
                  </span>
                ) : null}
              </Cell>
              <Cell align="right">
                <span
                  className={
                    r.period.disallowedPaise ? "text-danger" : "text-muted"
                  }
                >
                  {inrExact(r.period.disallowedPaise)}
                </span>
                {r.period.refusedCount || r.period.partCount ? (
                  <span className="block text-[12px] leading-4 whitespace-normal text-muted">
                    {[
                      r.period.refusedCount
                        ? `${r.period.refusedCount} refused`
                        : null,
                      r.period.partCount ? `${r.period.partCount} cut` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : null}
              </Cell>
              <Cell align="right">
                <span
                  className={
                    r.period.pendingCount ? "text-warn-ink" : "text-muted"
                  }
                >
                  {inrExact(r.period.pendingPaise)}
                </span>
                {r.period.pendingCount ? (
                  <span className="block text-[12px] text-muted">
                    {r.period.pendingCount} to decide
                  </span>
                ) : null}
              </Cell>
              <Cell align="right">{inrExact(r.period.allowancePaise)}</Cell>
              <Cell align="right">{inrExact(r.period.paidPaise)}</Cell>
              <Cell align="right">
                <span
                  className={`font-semibold ${r.balance.duePaise ? "text-ink" : "text-muted"}`}
                >
                  {inrExact(r.balance.duePaise)}
                </span>
                {r.balance.advancePaise ? (
                  <span className="block text-[12px] text-warn-ink">
                    {inrExact(r.balance.advancePaise)} advance
                  </span>
                ) : null}
              </Cell>
              <Cell>
                {r.lastPaidOn ? (
                  shortDate(r.lastPaidOn)
                ) : (
                  <span className="text-muted">Never</span>
                )}
              </Cell>
              <Cell align="right">
                {canPay ? (
                  <RecordPayment
                    userId={r.userId}
                    who={r.userName}
                    duePaise={r.balance.duePaise}
                    today={now}
                    size="sm"
                    tone="default"
                    label="Pay"
                  />
                ) : null}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
      <p className="mt-3 text-[12px] text-muted">
        Claimed, approved, refused, waiting, allowances and paid are for{" "}
        {period.label}. Owed now is everything approved and earned to date, less
        everything paid to date — a payment this month can settle last
        month&apos;s expenses.
      </p>
    </div>
  );
}

const COLUMNS: SortColumns<LedgerTeamRow> = {
  name: (r) => r.userName,
  claimed: (r) => r.period.claimedPaise,
  approved: (r) => r.period.approvedPaise,
  disallowed: (r) => r.period.disallowedPaise,
  pending: (r) => r.period.pendingPaise,
  allowance: (r) => r.period.allowancePaise,
  paid: (r) => r.period.paidPaise,
  due: (r) => r.balance.duePaise,
};
