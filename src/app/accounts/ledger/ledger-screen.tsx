"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { CustomerSearch } from "../customer-search";
import { CUSTOM_DATES } from "@/components/ui/year-filter";
import {
  LedgerBalances,
  LedgerPeriodBar,
  StatementTable,
  TD,
  TD_WRAP,
  Th,
  deadStatus,
  type LedgerEntry,
  type PeriodPatch,
  type StatementLedger,
} from "@/components/ledger/customer-statement";
import type { AccountServing } from "@/lib/services/distributor-service";
import { downloadCsv, toCsv } from "@/lib/csv";
import { longDate, money } from "@/lib/format";
import { Banner, Empty, Pager, Pill, ScreenHeader, Table, plural } from "../parts";

/* ---------------------------------------------------------------------------
 * The customer account — a statement.
 *
 * The period, the opening and closing balance and the statement table are the
 * shared `customer-statement` component, which the CRM customer record's
 * Ledger tab draws too, so the two apps cannot describe one account two ways.
 * What is Accounts' own: the export, how the account is served, and the By
 * bill view.
 * ------------------------------------------------------------------------- */

type Ledger = StatementLedger;

type View = "statement" | "bills";

export function LedgerScreen({
  canReverse,
  ledger,
  serving,
  period,
  years,
  today,
  from,
  to,
  view,
}: {
  /**
   * Whether this person may take back money that has counted. The same
   * capability as confirming it — accounts hold the bank statement, and
   * taking money off an account is the same kind of decision as putting it on.
   */
  canReverse: boolean;
  ledger: Ledger | null;
  /** How the account is served — see the note on the page that reads it. */
  serving: AccountServing | null;
  /** A year ("26-27" / "2026"), "all", or "custom" — see year-period.ts. */
  period: string;
  /** The years this account has entries in, both ways of counting. */
  years: { fy: string[]; cy: string[] };
  /** The business date, read on the server. */
  today: string;
  /** The period as dates, inclusive; empty for all time. */
  from: string;
  to: string;
  /** Statement (date order, running balance) or By bill (each bill and the money against it). */
  view: View;
}) {
  const router = useRouter();
  const { push } = useToast();
  const [page, setPage] = React.useState(1);
  const [perPage, setPerPage] = React.useState(25);

  if (!ledger) {
    return (
      <div className="px-6 pt-6 pb-12">
        <div className="max-w-[1400px]">
          <ScreenHeader
            title="Customer account"
            subtitle="Every bill and every payment, and which bills each payment settled."
          />
          <CustomerSearch
            title="Whose account?"
            hint="Customer name, phone, or a bill number as it is printed."
            placeholder="Shree Paints, MMI/26-27/1119…"
            onPick={(hit) => router.push(`/accounts/ledger?customer=${hit.customerId}`)}
          />
        </div>
      </div>
    );
  }

  const navigate = (patch: PeriodPatch & { view?: View }) => {
    const params = new URLSearchParams({ customer: ledger.customerId });
    const next = { period, from, to, view, ...patch };
    if (next.period === CUSTOM_DATES) {
      if (next.from) params.set("from", next.from);
      if (next.to) params.set("to", next.to);
    } else {
      params.set("year", next.period);
    }
    if (next.view !== "statement") params.set("view", next.view);
    setPage(1);
    router.push(`/accounts/ledger?${params}`);
  };


  /*
   * NEWEST FIRST on screen, oldest first underneath. The running balance is
   * cumulative and can only be computed oldest first; what is reversed is the
   * reading order, and each row keeps the balance it was given — so the top
   * row is what the customer owes today. Copied before reversing: `reverse()`
   * mutates, and `ledger.entries` is also what the totals read.
   */
  const ordered = [...ledger.entries].reverse();
  const billsNewestFirst = ordered.filter((e) => e.kind === "bill");
  const looseMoney = ordered.filter(
    (e) => e.kind === "receipt" && (e.onAccount ?? 0) > 0 && !deadStatus(e.status),
  );

  // Paging for the By bill view; the statement table pages itself.
  const rows = billsNewestFirst;
  const shown = rows.slice((page - 1) * perPage, page * perPage);
  const lastPage = Math.max(1, Math.ceil(rows.length / perPage));

  const exportCsv = () => {
    downloadCsv(
      `mahek-account-${ledger.customerName.toLowerCase().replace(/\W+/g, "-")}`,
      toCsv(
        [
          "Date",
          "Type",
          "Reference",
          "Mode / status",
          "Paid against / paid by",
          "Billed (₹)",
          "Received (₹)",
          "Balance (₹)",
        ],
        ordered.map((e) => [
          e.at,
          e.kind === "bill" ? "Bill" : "Payment",
          e.ref,
          e.detail,
          [
            ...(e.links ?? []).map(
              (l) => `${l.label} ₹${Math.round(l.amount / 100)}${deadStatus(l.status) ? " (" + l.status + ")" : ""}`,
            ),
            ...(e.onAccount ? [`On account ₹${Math.round(e.onAccount / 100)}`] : []),
          ].join("; "),
          e.debit ? String(Math.round(e.debit / 100)) : "",
          e.credit ? String(Math.round(e.credit / 100)) : "",
          String(Math.round(e.balance / 100)),
        ]),
      ),
      [from, to],
    );
    push(`Exported ${plural(ledger.entries.length, "row")}`);
  };

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="max-w-[1400px]">
        <ScreenHeader
          title={ledger.customerName}
          subtitle="Every bill and every payment on this account, and which bills each payment settled. Point at a line to light up what it is linked to."
          actions={
            <>
              <button onClick={() => router.push("/accounts/ledger")} className={BUTTON}>
                Another account
              </button>
              <button onClick={exportCsv} className={BUTTON}>
                Export
              </button>
            </>
          }
        />

        <LedgerPeriodBar
          period={period}
          years={years}
          today={today}
          from={from}
          to={to}
          onChange={navigate}
        />
        <LedgerBalances ledger={ledger} period={period} from={from} to={to} today={today} />

        {/*
          WHY THIS STATEMENT LOOKS THE WAY IT DOES. A third-party customer has
          no bills and never will, and an empty statement with nothing saying
          why reads as data missing. Read-only: converting is a manager's.
        */}
        {serving?.thirdParty ? (
          <div className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-3.5 text-sm text-body">
            <span className="font-medium text-ink">Third-party customer.</span>{" "}
            We deliver here and do not bill it — the goods are invoiced to{" "}
            {serving.distributors.length
              ? serving.distributors.map((d) => d.name).join(", ")
              : "a distributor nobody has recorded yet"}
            . Bills and receipts on this account are the exceptions, not the rule.
          </div>
        ) : serving && serving.shops > 0 ? (
          <div className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-3.5 text-sm text-body">
            <span className="font-medium text-ink">Distributor.</span>{" "}
            {plural(serving.shops, "third-party customer")} are delivered to on
            this account&apos;s bills.
          </div>
        ) : null}

        {ledger.awaiting.count ? (
          <div className="mb-4">
            <Banner tone="warn">
              {money(ledger.awaiting.amount)} across{" "}
              {plural(ledger.awaiting.count, "receipt")} has been reported and not yet
              confirmed. It is not in the balance, and it will not be until somebody
              finds it.
            </Banner>
          </div>
        ) : null}

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-[6px] border border-line bg-surface p-0.5">
            {(
              [
                ["statement", "Statement", `${ledger.entries.length}`],
                ["bills", "By bill", `${billsNewestFirst.length}`],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => navigate({ view: key })}
                className={cx(
                  "h-8 cursor-pointer rounded-[4px] px-3.5 text-sm font-medium",
                  view === key ? "bg-canvas text-ink shadow-[inset_0_0_0_1px_var(--color-line)]" : "text-muted hover:text-body",
                )}
              >
                {label} <span className="ml-1 text-xs text-muted tabular-nums">{count}</span>
              </button>
            ))}
          </div>
        </div>

        {ledger.entries.length === 0 ? (
          <Empty
            title="Nothing on this account"
            body={
              from || to
                ? "No bills or payments fall inside these dates."
                : "This customer has never been billed."
            }
          />
        ) : view === "bills" ? (
          <BillWise
            bills={shown}
            looseMoney={page === lastPage ? looseMoney : []}
            total={rows.length}
            page={page}
            perPage={perPage}
            onPage={setPage}
            onPerPage={(n) => {
              setPerPage(n);
              setPage(1);
            }}
          />
        ) : (
          <StatementTable
            // A new period is a new statement: start it on its first page.
            key={`${period}|${from}|${to}`}
            ledger={ledger}
            from={from}
            canReverse={canReverse}
            onReversed={() => router.refresh()}
          />
        )}
      </div>

    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

/**
 * BY BILL: every bill, and directly under it the money that went against it.
 * The statement answers "what is the balance"; this answers "was bill 1626
 * paid, and by what" — read down one block instead of matching two rows.
 */
function BillWise({
  bills,
  looseMoney,
  total,
  page,
  perPage,
  onPage,
  onPerPage,
}: {
  bills: LedgerEntry[];
  looseMoney: LedgerEntry[];
  total: number;
  page: number;
  perPage: number;
  onPage: (n: number) => void;
  onPerPage: (n: number) => void;
}) {
  if (total === 0) {
    return <Empty title="No bills in these dates" body="Payments on this account are on the Statement tab." />;
  }
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <Table
        minWidth={800}
        head={
          <>
            <Th width={104}>Date</Th>
            <Th>Bill / payment against it</Th>
            <Th align="right" width={104}>Bill amount</Th>
            <Th align="right" width={96}>Paid</Th>
            <Th align="right" width={96}>Due</Th>
            <Th width={96}>Status</Th>
          </>
        }
      >
        {bills.map((b) => {
          const paid = b.paid ?? 0;
          const due = Math.max(0, b.debit - paid);
          const links = b.links ?? [];
          return (
            <React.Fragment key={b.billId ?? b.ref}>
              <tr className="border-t border-line bg-canvas">
                <td className={cx(TD, "font-medium text-body")}>{longDate(b.at)}</td>
                <td className={cx(TD_WRAP, "break-words")}>
                  <span className="flex items-center gap-2">
                    <span className="font-semibold text-ink">{b.ref}</span>
                    {(b.claimed ?? 0) > 0 ? (
                      <Pill tone="warn">{money(b.claimed!)} claimed</Pill>
                    ) : null}
                  </span>
                </td>
                <td className={cx(TD, "text-right font-medium tabular-nums text-ink")}>{money(b.debit)}</td>
                <td className={cx(TD, "text-right tabular-nums", paid ? "text-body" : "text-muted")}>
                  {paid ? money(paid) : "—"}
                </td>
                <td className={cx(TD, "text-right font-medium tabular-nums", due ? "text-danger" : "text-muted")}>
                  {b.unstated && paid === 0 ? "not stated" : due ? money(due) : "—"}
                </td>
                <td className={cx(TD, "text-body")}>
                  {b.unstated && paid === 0
                    ? "Not stated"
                    : b.debit > 0 && paid >= b.debit
                      ? "Paid"
                      : paid > 0
                        ? "Part paid"
                        : "Unpaid"}
                </td>
              </tr>
              {links.length ? (
                links.map((l, i) => {
                  const dead = deadStatus(l.status);
                  const pending = l.status === "reported" || l.status === "held";
                  // What was left on the bill after this payment, walking the
                  // payments in date order — confirmed money only, so a part
                  // payment reads as the step it was.
                  const leftAfter = Math.max(
                    0,
                    b.debit -
                      links
                        .slice(0, i + 1)
                        .filter((x) => x.status === "confirmed")
                        .reduce((sum, x) => sum + x.amount, 0),
                  );
                  return (
                    <tr key={`${l.id}-${i}`} className="border-t border-divider bg-surface">
                      <td className={cx(TD, "pl-8 text-muted", dead && "line-through")}>{longDate(l.at)}</td>
                      <td className={cx(TD_WRAP, "break-words")}>
                        <span className="flex flex-wrap items-center gap-x-2 pl-4">
                          <span className="text-muted">↳</span>
                          <span className={cx("text-body", dead && "text-muted line-through")}>
                            {l.mode ?? "Payment"}
                            {l.label !== l.mode ? <span className="text-muted"> · ref {l.label}</span> : null}
                          </span>
                          {(l.receiptBills ?? 1) > 1 && l.receiptAmount ? (
                            <span className="text-xs text-muted">
                              (part of {money(l.receiptAmount)}, split across {l.receiptBills} bills)
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className={TD} />
                      <td
                        className={cx(
                          TD,
                          "text-right tabular-nums",
                          dead ? "text-muted line-through" : pending ? "text-muted" : "text-body",
                        )}
                      >
                        {money(l.amount)}
                      </td>
                      <td className={cx(TD, "text-right text-xs tabular-nums text-muted")}>
                        {l.status === "confirmed" ? (leftAfter ? `${money(leftAfter)} left` : "cleared") : ""}
                      </td>
                      <td className={TD}>
                        {pending ? (
                          <Pill tone="warn">not yet confirmed</Pill>
                        ) : l.status === "rejected" ? (
                          <Pill tone="danger">never arrived</Pill>
                        ) : l.status === "reversed" ? (
                          <Pill tone="danger">reversed</Pill>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr className="border-t border-divider bg-surface">
                  <td className={TD} />
                  <td colSpan={5} className={cx(TD, "pl-12 text-xs text-muted")}>
                    No payment recorded against this bill
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}

        {looseMoney.length ? (
          <>
            <tr className="border-t border-line bg-canvas">
              <td colSpan={6} className={cx(TD, "font-medium text-ink")}>
                Received and not against any bill
                <span className="ml-2 text-xs font-normal text-muted">
                  on account — it will settle a bill once accounts allocate it
                </span>
              </td>
            </tr>
            {looseMoney.map((r) => (
              <tr key={r.receiptId} className="border-t border-divider bg-surface">
                <td className={cx(TD, "pl-8 text-muted")}>{longDate(r.at)}</td>
                <td className={cx(TD_WRAP, "break-words")}>
                  <span className="flex flex-wrap items-center gap-x-2 pl-4">
                    <span className="text-muted">↳</span>
                    <span className="text-body">{r.detail.split(" · ")[0]}</span>
                    {r.ref !== "—" && r.ref !== r.detail.split(" · ")[0] ? (
                      <span className="text-muted">· ref {r.ref}</span>
                    ) : null}
                  </span>
                </td>
                <td className={TD} />
                <td className={cx(TD, "text-right tabular-nums text-body")}>{money(r.onAccount ?? 0)}</td>
                <td className={TD} />
                <td className={TD}>
                  {r.status === "confirmed" ? (
                    <span className="text-body">On account</span>
                  ) : (
                    <Pill tone="warn">not yet confirmed</Pill>
                  )}
                </td>
              </tr>
            ))}
          </>
        ) : null}
      </Table>
      <Pager
        total={total}
        page={page}
        perPage={perPage}
        note="Paid counts confirmed money only"
        onPage={onPage}
        onPerPage={onPerPage}
      />
    </div>
  );
}

const BUTTON =
  "h-9 cursor-pointer rounded-[4px] border border-line-strong bg-surface px-3.5 text-sm font-medium text-body hover:bg-canvas";
