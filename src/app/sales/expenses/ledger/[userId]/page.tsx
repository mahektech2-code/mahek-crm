import Link from "next/link";
import { notFound } from "next/navigation";
import { shortDate } from "@/lib/format";
import { today } from "@/lib/recompute";
import { endOfMonth } from "@/lib/business-date";
import { MonthNav } from "@/components/ui/month-nav";
import {
  expenseLedgerFor,
  ledgerLineOf,
  type PayoutRow,
  type PolicyNote,
} from "@/lib/services/expense-ledger-service";
import type { ExpenseLineRow } from "@/lib/services/expense-claims-service";
import {
  allocatePayouts,
  eligibilityOf,
  ledgerTotals,
  payStatusOf,
  payablePaise,
  disallowedPaise,
  statement,
  type Allocation,
} from "@/lib/engines/expense-ledger";
import {
  canDecideExpenseLines,
  canRecordExpensePayouts,
} from "@/lib/actions/sales";
import {
  Banner,
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { DecideExpense } from "../../decide-expense";
import { expenseKindLabel, inrExact } from "../../labels";
import { ExpenseTabs } from "../../tabs";
import { RecordPayment, VoidPayment } from "../ledger-actions";

export const metadata = {
  title: "Expense statement — Sales Dashboard — MahekOne",
};

/**
 * ONE SALESMAN'S EXPENSE STATEMENT.
 *
 * Every expense he logged and every allowance he earned, each with what he
 * asked for, what the policy allows and why, what his manager decided and
 * said, and whether it has been paid — and every payment handed over, in
 * date order, with what he is owed after each. The balance is all-time; a
 * month or a chip only narrows which rows are drawn, never the balance
 * beside them.
 */
const SHOWS = [
  "all",
  "expenses",
  "allowances",
  "approved",
  "disallowed",
  "waiting",
  "not_eligible",
  "unpaid",
  "payments",
] as const;
type Show = (typeof SHOWS)[number];

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ month?: string; period?: string; show?: string }>;
}) {
  const { userId } = await params;
  const sp = await searchParams;
  const now = await today();
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "")
    ? sp.month!
    : now.slice(0, 7);
  const allTime = sp.period === "all";
  const from = allTime ? null : `${month}-01`;
  const to = allTime ? null : endOfMonth(month);
  const inPeriod = (day: string) => !from || (day >= from && day <= to!);

  const [ledger, canPay, canDecide] = await Promise.all([
    expenseLedgerFor(userId),
    canRecordExpensePayouts(),
    canDecideExpenseLines(),
  ]);
  if (!ledger) notFound();

  const show: Show = (SHOWS as readonly string[]).includes(sp.show ?? "")
    ? (sp.show as Show)
    : "all";
  const rowsById = new Map(ledger.lines.map((r) => [r.id, r]));
  const lines = ledger.lines.map(ledgerLineOf);
  const alloc = allocatePayouts(lines, ledger.payouts);
  const balance = ledgerTotals(lines, ledger.payouts);
  const periodLines = lines.filter((l) => inPeriod(l.day));
  const periodPayouts = ledger.payouts.filter((p) => inPeriod(p.paidOn));
  const t = ledgerTotals(periodLines, periodPayouts);

  const entries = statement(lines, ledger.payouts);
  const opening = from
    ? (entries
        .filter(
          (e) => (e.kind === "line" ? e.line.day : e.payout.paidOn) < from,
        )
        .at(-1)?.balancePaise ?? 0)
    : 0;

  const inView = entries.filter((e) =>
    inPeriod(e.kind === "line" ? e.line.day : e.payout.paidOn),
  );
  const count = (s: Show) =>
    inView.filter((e) => matchesFor(s, e, alloc)).length;
  const drawn = inView.filter((e) => matchesFor(show, e, alloc)).reverse();

  const base = `month=${month}${allTime ? "&period=all" : ""}`;
  const here = `/sales/expenses/ledger/${userId}`;
  const label = allTime ? "all time" : "this month";
  const unpaidTotal = lines.reduce(
    (n, l) =>
      n + Math.max(0, payablePaise(l) - (alloc.paidByLine.get(l.id) ?? 0)),
    0,
  );

  return (
    <div className="p-6">
      <ScreenHeader
        title={
          <>
            <Link
              href={`/sales/expenses/ledger?${base}`}
              className="text-muted no-underline hover:text-body"
            >
              Expenses
            </Link>
            <span className="text-muted"> / </span>
            {ledger.userName}
          </>
        }
        subtitle="Every expense he logged and every allowance he earned, what the policy allows, what was decided and why, and every payment made to him."
        actions={
          <div className="flex items-center gap-3">
            <Link
              href={`/sales/people/${userId}`}
              className="text-sm font-medium"
            >
              Profile
            </Link>
            {allTime ? (
              <Link
                href={`${here}?month=${month}`}
                className="text-sm font-medium"
              >
                By month
              </Link>
            ) : (
              <>
                <Link
                  href={`${here}?month=${month}&period=all`}
                  className="text-sm font-medium"
                >
                  All time
                </Link>
                <MonthNav month={month} basePath={here} />
              </>
            )}
            {canPay ? (
              <RecordPayment
                userId={userId}
                who={ledger.userName}
                duePaise={balance.duePaise}
                today={now}
              />
            ) : null}
          </div>
        }
      />
      <ExpenseTabs current="ledger" month={month} />

      <Banner
        tone={balance.duePaise > 0 ? "warn" : "info"}
        title={
          balance.advancePaise > 0
            ? `${inrExact(balance.advancePaise)} paid in advance`
            : balance.duePaise > 0
              ? `${inrExact(balance.duePaise)} owed to ${ledger.userName} now`
              : `Nothing owed to ${ledger.userName} now`
        }
        body={
          <>
            {inrExact(balance.payablePaise)} approved and earned to date,{" "}
            {inrExact(balance.paidPaise)} paid.
            {balance.pendingCount
              ? ` ${plural(balance.pendingCount, "expense")} worth ${inrExact(balance.pendingPaise)} still waiting for a decision — not counted until approved.`
              : ""}
            {balance.advancePaise > 0
              ? " The advance is set against expenses as they are approved."
              : ""}
          </>
        }
      />

      <MetricRow
        metrics={[
          {
            label: `Claimed ${label}`,
            value: inrExact(t.claimedPaise),
            sub: plural(t.claimedCount, "expense"),
          },
          {
            label: "Approved",
            value: inrExact(t.approvedPaise),
            sub: `${plural(t.approvedCount, "expense")}${t.partCount ? ` · ${t.partCount} in part` : ""}`,
            tone: "success",
          },
          {
            label: "Refused or cut",
            value: inrExact(t.disallowedPaise),
            sub: `${plural(t.refusedCount, "refusal")} · ${inrExact(t.refusedPaise)}`,
            tone: t.disallowedPaise ? "danger" : undefined,
          },
          {
            label: "Waiting",
            value: inrExact(t.pendingPaise),
            sub: plural(t.pendingCount, "expense"),
            tone: t.pendingCount ? "warn" : undefined,
          },
          {
            label: "Allowances",
            value: inrExact(t.allowancePaise),
            sub: plural(t.allowanceCount, "line"),
          },
          {
            label: "Outside policy",
            value: String(t.notEligibleCount + t.overPolicyCount),
            sub: `${t.notEligibleCount} not eligible · ${t.overPolicyCount} over`,
            tone: t.notEligibleCount + t.overPolicyCount ? "warn" : undefined,
          },
          {
            label: `Paid ${label}`,
            value: inrExact(t.paidPaise),
            sub: plural(
              periodPayouts.filter((p) => !p.voided).length,
              "payment",
            ),
          },
        ]}
      />

      <FilterChips
        current={show}
        options={(
          [
            ["all", "Everything"],
            ["expenses", "Expenses"],
            ["allowances", "Allowances"],
            ["approved", "Approved"],
            ["disallowed", "Refused or cut"],
            ["waiting", "Waiting"],
            ["not_eligible", "Outside policy"],
            ["unpaid", "Not paid yet"],
            ["payments", "Payments"],
          ] as const
        ).map(([key, text]) => ({
          key,
          label: text,
          count: count(key),
          href: `${here}?show=${key}&${base}`,
        }))}
      />

      {drawn.length === 0 ? (
        <Empty
          title="Nothing here"
          body={
            allTime
              ? "Nothing matches this filter."
              : "Nothing matches this filter in this month. Try All time."
          }
        />
      ) : (
        <Table
          minWidth={1130}
          head={
            <>
              <HeadCell width={82}>Day</HeadCell>
              <HeadCell width={190}>Entry</HeadCell>
              <HeadCell align="right" width={90}>
                Claimed
              </HeadCell>
              <HeadCell width={210}>Policy</HeadCell>
              <HeadCell width={210}>Decision</HeadCell>
              <HeadCell align="right" width={110}>
                Approved
              </HeadCell>
              <HeadCell width={110}>Payment</HeadCell>
              <HeadCell align="right" width={100}>
                Balance
              </HeadCell>
            </>
          }
        >
          {drawn.map((e, i) =>
            e.kind === "payout" ? (
              <PayoutRowView
                key={e.payout.id}
                payout={ledger.payouts.find((p) => p.id === e.payout.id)!}
                balance={e.balancePaise}
                striped={i % 2 === 1}
                canVoid={canPay}
              />
            ) : (
              <LineRowView
                key={e.line.id}
                row={rowsById.get(e.line.id)!}
                notes={ledger.notes[e.line.id] ?? []}
                alloc={alloc}
                balance={e.balancePaise}
                striped={i % 2 === 1}
                canDecide={canDecide}
              />
            ),
          )}
          {from && (show === "all" || show === "payments") ? (
            <Row striped={drawn.length % 2 === 1}>
              <Cell>{shortDate(from)}</Cell>
              <Cell colSpan={6}>
                <span className="text-[13px] text-muted">
                  Owed at the start of the month
                </span>
              </Cell>
              <Cell align="right">
                <span className="tabular-nums text-muted">
                  {inrExact(opening)}
                </span>
              </Cell>
            </Row>
          ) : null}
        </Table>
      )}
      <p className="mt-3 text-[12px] text-muted">
        Newest first. Balance is what he was owed after each entry — approved
        expenses and allowances add to it, payments take from it; a waiting or
        refused expense moves nothing. Payments settle the oldest approved
        expenses first
        {unpaidTotal
          ? `; ${inrExact(unpaidTotal)} of approved money is not paid yet`
          : ""}
        .
      </p>
    </div>
  );
}

function matchesFor(
  s: Show,
  e: ReturnType<typeof statement>[number],
  alloc: Allocation,
): boolean {
  if (e.kind === "payout") return s === "all" || s === "payments";
  const l = e.line;
  switch (s) {
    case "all":
      return true;
    case "expenses":
      return !l.allowance;
    case "allowances":
      return l.allowance;
    case "approved":
      return l.state === "approved" || l.state === "partially_approved";
    case "disallowed":
      return disallowedPaise(l) > 0;
    case "waiting":
      return l.state === "pending";
    case "not_eligible":
      return (
        eligibilityOf(l) === "not_eligible" ||
        eligibilityOf(l) === "over_policy"
      );
    case "unpaid": {
      const st = payStatusOf(l, alloc);
      return st === "unpaid" || st === "part_paid";
    }
    default:
      return false;
  }
}

function LineRowView({
  row,
  notes,
  alloc,
  balance,
  striped,
  canDecide,
}: {
  row: ExpenseLineRow;
  notes: PolicyNote[];
  alloc: Allocation;
  balance: number;
  striped: boolean;
  canDecide: boolean;
}) {
  const line = ledgerLineOf(row);
  const elig = eligibilityOf(line);
  const payable = payablePaise(line);
  const paid = alloc.paidByLine.get(line.id) ?? 0;
  const pay = payStatusOf(line, alloc);
  const cut = disallowedPaise(line);
  const detail = [
    row.vendorName,
    row.billNumber ? `bill ${row.billNumber}` : null,
    row.remarks,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Row striped={striped}>
      <Cell>{shortDate(row.day)}</Cell>
      <Cell>
        <span className="block text-[13px] font-medium text-ink">
          {expenseKindLabel(row.kind, row.allowance)}
        </span>
        {detail ? (
          <span
            className="block truncate text-[12px] text-muted"
            title={detail}
          >
            {detail}
          </span>
        ) : null}
        {row.allowance ? (
          <span className="block text-[12px] text-muted">
            From his work log
          </span>
        ) : row.files.length ? (
          <span className="block text-[12px]">
            {row.files.map((f, k) => (
              <a
                key={f.id}
                href={`/api/attachments/${f.id}`}
                target="_blank"
                rel="noreferrer"
                className={`mr-2 ${f.gone ? "text-muted line-through" : ""}`}
                title={f.filename}
              >
                {row.files.length === 1 ? "Bill" : `Bill ${k + 1}`}
              </a>
            ))}
          </span>
        ) : (
          <span className="block text-[12px] text-warn-ink">
            No bill attached
          </span>
        )}
      </Cell>
      <Cell align="right">
        <span className="tabular-nums">{inrExact(row.claimedPaise)}</span>
      </Cell>
      <Cell>
        <EligibilityView
          elig={elig}
          eligible={row.eligiblePaise}
          claimed={row.claimedPaise}
        />
        {notes.map((n, k) => (
          <span
            key={k}
            className={`mt-0.5 block text-[12px] leading-4 whitespace-normal ${n.severity === "info" ? "text-muted" : "text-warn-ink"}`}
          >
            {n.message}
            {n.resolution ? (
              <span className="text-muted">
                {" "}
                — {n.resolution}
                {n.resolutionNote ? `: “${n.resolutionNote}”` : ""}
              </span>
            ) : null}
          </span>
        ))}
      </Cell>
      <Cell>
        <DecisionView row={row} />
        {canDecide && row.state === "pending" ? (
          <span className="mt-1 block">
            <DecideExpense
              expenseId={row.id}
              who={row.userName}
              what={`${expenseKindLabel(row.kind, false)} · ${shortDate(row.day)}`}
              claimedPaise={row.claimedPaise}
              eligiblePaise={row.eligiblePaise}
              remarks={row.remarks}
              vendorName={row.vendorName}
              billNumber={row.billNumber}
              files={row.files}
            />
          </span>
        ) : null}
      </Cell>
      <Cell align="right">
        {row.state === "pending" ? (
          <span className="text-muted">—</span>
        ) : (
          <>
            <span
              className={`tabular-nums ${payable ? "text-success" : "text-muted"}`}
            >
              {inrExact(payable)}
            </span>
            {cut > 0 ? (
              <span className="block text-[12px] leading-4 whitespace-normal text-danger">
                {inrExact(cut)} not allowed
              </span>
            ) : null}
          </>
        )}
      </Cell>
      <Cell>
        {pay === "paid" ? (
          <Pill tone="success">Paid</Pill>
        ) : pay === "part_paid" ? (
          <>
            <Pill tone="warn">Part paid</Pill>
            <span className="block text-[12px] text-muted">
              {inrExact(paid)} of {inrExact(payable)}
            </span>
          </>
        ) : pay === "unpaid" ? (
          <Pill tone="warn">Not paid</Pill>
        ) : (
          <span className="block text-[12px] leading-4 whitespace-normal text-muted">
            {row.state === "pending" ? "Once approved" : "Nothing due"}
          </span>
        )}
      </Cell>
      <Cell align="right">
        <span className="tabular-nums">{inrExact(balance)}</span>
      </Cell>
    </Row>
  );
}

function EligibilityView({
  elig,
  eligible,
  claimed,
}: {
  elig: ReturnType<typeof eligibilityOf>;
  eligible: number | null;
  claimed: number;
}) {
  switch (elig) {
    case "allowance":
      return <Pill tone="neutral">Earned automatically</Pill>;
    case "unpriced":
      return (
        <>
          <Pill tone="neutral">Not checked yet</Pill>
          <span className="block text-[12px] leading-4 whitespace-normal text-muted">
            The day has not been worked out against the policy yet.
          </span>
        </>
      );
    case "not_eligible":
      return (
        <>
          <Pill tone="danger">Not eligible</Pill>
          <span className="block text-[12px] leading-4 whitespace-normal text-muted">
            The policy allows nothing on this.
          </span>
        </>
      );
    case "over_policy":
      return (
        <>
          <Pill tone="warn">Over policy</Pill>
          <span className="block text-[12px] text-muted">
            Allows {inrExact(eligible ?? 0)} —{" "}
            {inrExact(claimed - (eligible ?? 0))} over
          </span>
        </>
      );
    default:
      return (
        <>
          <Pill tone="success">Eligible</Pill>
          <span className="block text-[12px] text-muted">
            Allows {inrExact(eligible ?? claimed)}
            {eligible !== null && eligible > claimed ? " (a fixed rate)" : ""}
          </span>
        </>
      );
  }
}

function DecisionView({ row }: { row: ExpenseLineRow }) {
  if (row.state === "allowance")
    return <span className="text-[12px] text-muted">No approval needed</span>;
  const who = [
    row.decidedByName,
    row.decidedOn ? shortDate(row.decidedOn) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const note = row.decisionNote ? (
    <span className="mt-0.5 block text-[12px] leading-4 whitespace-normal text-body">
      Remark: “{row.decisionNote}”
    </span>
  ) : null;
  if (row.state === "pending") {
    return (
      <>
        <Pill tone="warn">Waiting</Pill>
        {row.openFlags ? (
          <span className="block text-[12px] text-warn-ink">
            {plural(row.openFlags, "thing")} to check
          </span>
        ) : null}
      </>
    );
  }
  const pill =
    row.state === "approved" ? (
      <Pill tone="success">Approved</Pill>
    ) : row.state === "partially_approved" ? (
      <Pill tone="warn">Approved in part</Pill>
    ) : (
      <Pill tone="danger">Refused</Pill>
    );
  return (
    <>
      {pill}
      {who ? <span className="block text-[12px] text-muted">{who}</span> : null}
      {note}
    </>
  );
}

function PayoutRowView({
  payout,
  balance,
  striped,
  canVoid,
}: {
  payout: PayoutRow;
  balance: number;
  striped: boolean;
  canVoid: boolean;
}) {
  const how = [payout.mode, payout.reference ? `ref ${payout.reference}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Row striped={striped}>
      <Cell>{shortDate(payout.paidOn)}</Cell>
      <Cell>
        <span
          className={`block text-[13px] font-medium ${payout.voided ? "text-muted line-through" : "text-ink"}`}
        >
          Payment to him
        </span>
        {how ? (
          <span className="block truncate text-[12px] text-muted">{how}</span>
        ) : null}
        {payout.note ? (
          <span
            className="block truncate text-[12px] text-muted"
            title={payout.note}
          >
            {payout.note}
          </span>
        ) : null}
      </Cell>
      <Cell />
      <Cell />
      <Cell>
        <span className="block text-[12px] text-muted">
          Recorded by {payout.recordedByName ?? "—"} ·{" "}
          {shortDate(payout.recordedAt.slice(0, 10))}
        </span>
        {payout.voided ? (
          <span className="mt-0.5 block text-[12px] leading-4 whitespace-normal text-danger">
            Voided by {payout.voidedByName ?? "—"}: “{payout.voidReason}”
          </span>
        ) : canVoid ? (
          <VoidPayment
            payoutId={payout.id}
            what={`${inrExact(payout.amountPaise)} paid on ${shortDate(payout.paidOn)}`}
          />
        ) : null}
      </Cell>
      <Cell />
      <Cell>
        <span
          className={`tabular-nums font-medium ${payout.voided ? "text-muted line-through" : "text-ink"}`}
        >
          − {inrExact(payout.amountPaise)}
        </span>
        {payout.voided ? (
          <span className="block text-[12px] text-muted">Not counted</span>
        ) : null}
      </Cell>
      <Cell align="right">
        <span className="tabular-nums">{inrExact(balance)}</span>
      </Cell>
    </Row>
  );
}
