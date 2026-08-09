"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { CustomerSearch } from "../customer-search";
import { downloadCsv, toCsv } from "@/lib/csv";
import { longDate, money, signedMoney } from "@/lib/format";
import {
  Banner,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pager,
  Pill,
  Row,
  ScreenHeader,
  Table,
  plural,
} from "../parts";

/* ---------------------------------------------------------------------------
 * The customer account — a statement.
 *
 * What was billed, what came in, and what is left after each line. The running
 * balance counts CONFIRMED money only, so it agrees with what the customer
 * owes at the bottom; anything still waiting on accounts is reported beside it
 * rather than folded in.
 *
 * Rejected receipts stay on it. A transfer that never landed is a fact about
 * the account, and dropping it leaves the next person wondering why the
 * balance never moved.
 * ------------------------------------------------------------------------- */

type LedgerEntry = {
  at: string;
  kind: "bill" | "receipt";
  ref: string;
  detail: string;
  debit: number;
  credit: number;
  status: string | null;
  balance: number;
};

type Ledger = {
  customerId: string;
  customerName: string;
  openingBalance: number;
  entries: LedgerEntry[];
  totals: { billed: number; received: number; outstanding: number; onAccount: number };
  awaiting: { count: number; amount: number };
};

export function LedgerScreen({
  ledger,
  from,
  to,
}: {
  ledger: Ledger | null;
  from: string;
  to: string;
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
            subtitle="Everything billed and everything received, in order, with what was left after each line."
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

  const navigate = (patch: Record<string, string>) => {
    const params = new URLSearchParams({ customer: ledger.customerId });
    const next = { from, to, ...patch };
    if (next.from) params.set("from", next.from);
    if (next.to) params.set("to", next.to);
    setPage(1);
    router.push(`/accounts/ledger?${params}`);
  };

  const shown = ledger.entries.slice((page - 1) * perPage, page * perPage);

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="max-w-[1400px]">
        <ScreenHeader
          title={ledger.customerName}
          subtitle="Everything billed and everything received, in order. The running balance counts confirmed money only, so it agrees with what the customer owes."
          actions={
            <>
              <button
                onClick={() => router.push("/accounts/ledger")}
                className="h-9 cursor-pointer rounded-[4px] border border-line-strong bg-surface px-3.5 text-sm font-medium text-body hover:bg-canvas"
              >
                Another account
              </button>
              <button
                onClick={() => {
                  downloadCsv(
                    `mahek-account-${ledger.customerName.toLowerCase().replace(/\W+/g, "-")}`,
                    toCsv(
                      [
                        "Date",
                        "Type",
                        "Reference",
                        "Detail",
                        "Debit (₹)",
                        "Credit (₹)",
                        "Balance (₹)",
                      ],
                      ledger.entries.map((e) => [
                        e.at,
                        e.kind === "bill" ? "Bill" : "Payment",
                        e.ref,
                        e.detail,
                        e.debit ? String(Math.round(e.debit / 100)) : "",
                        e.credit ? String(Math.round(e.credit / 100)) : "",
                        String(Math.round(e.balance / 100)),
                      ]),
                    ),
                    [from, to],
                  );
                  push(`Exported ${plural(ledger.entries.length, "row")}`);
                }}
                className="h-9 cursor-pointer rounded-[4px] border border-line-strong bg-surface px-3.5 text-sm font-medium text-body hover:bg-canvas"
              >
                Export
              </button>
            </>
          }
        />

        <MetricRow
          metrics={[
            {
              label: "Outstanding",
              value: money(ledger.totals.outstanding),
              sub: "confirmed money only",
              tone: ledger.totals.outstanding > 0 ? "danger" : undefined,
            },
            { label: "Billed", value: money(ledger.totals.billed), sub: "in this range" },
            {
              label: "Received",
              value: money(ledger.totals.received),
              sub: "confirmed",
            },
            {
              label: "On account",
              value: money(ledger.totals.onAccount),
              sub: ledger.totals.onAccount ? "not yet against a bill" : "nothing held",
            },
            {
              label: "Awaiting confirmation",
              value: money(ledger.awaiting.amount),
              sub: ledger.awaiting.count
                ? plural(ledger.awaiting.count, "receipt")
                : "nothing waiting",
              tone: ledger.awaiting.count ? "danger" : undefined,
            },
          ]}
        />

        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-[6px] border border-line bg-surface px-5 py-3.5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
              From
            </span>
            <input
              type="date"
              value={from}
              onChange={(e) => navigate({ from: e.target.value })}
              className={FIELD}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
              To
            </span>
            <input
              type="date"
              value={to}
              onChange={(e) => navigate({ to: e.target.value })}
              className={FIELD}
            />
          </label>
          {from || to ? (
            <button
              onClick={() => router.push(`/accounts/ledger?customer=${ledger.customerId}`)}
              className="h-9.5 cursor-pointer border-none bg-transparent px-2 text-sm font-medium text-brand hover:underline"
            >
              Clear
            </button>
          ) : null}
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
        ) : (
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            <Table
              minWidth={900}
              head={
                <>
                  <HeadCell>Date</HeadCell>
                  <HeadCell>Reference</HeadCell>
                  <HeadCell>Detail</HeadCell>
                  <HeadCell align="right">Billed</HeadCell>
                  <HeadCell align="right">Received</HeadCell>
                  <HeadCell align="right">Balance</HeadCell>
                </>
              }
            >
              {from && page === 1 ? (
                <tr className="border-b border-divider bg-surface">
                  <td colSpan={5} className="px-4 py-2.5 text-sm text-muted">
                    Opening balance
                  </td>
                  <td className="px-4 py-2.5 text-right text-sm tabular-nums text-muted">
                    {money(ledger.openingBalance)}
                  </td>
                </tr>
              ) : null}

              {shown.map((e, i) => {
                const dead = e.status === "rejected";
                return (
                  <Row key={`${e.at}-${e.ref}-${i}`} striped={i % 2 === 1}>
                    <Cell className={dead ? "text-muted line-through" : undefined}>
                      {longDate(e.at)}
                    </Cell>
                    <Cell
                      className={cx(
                        "font-medium",
                        dead ? "text-muted line-through" : "text-ink",
                      )}
                    >
                      {e.ref}
                    </Cell>
                    <td className="px-4 py-2.5 align-middle text-sm">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className={dead ? "text-muted line-through" : "text-muted"}>
                          {e.detail}
                        </span>
                        {e.status === "reported" ? (
                          <Pill tone="warn">with accounts</Pill>
                        ) : null}
                        {dead ? <Pill tone="danger">never arrived</Pill> : null}
                      </span>
                    </td>
                    <Cell align="right" className={dead ? "line-through" : undefined}>
                      {e.debit ? money(e.debit) : "—"}
                    </Cell>
                    <Cell
                      align="right"
                      className={
                        e.credit && !dead ? "text-success" : "text-muted line-through"
                      }
                    >
                      {e.credit ? money(e.credit) : "—"}
                    </Cell>
                    <Cell align="right" className="font-medium text-ink">
                      {signedMoney(e.balance)}
                    </Cell>
                  </Row>
                );
              })}
            </Table>

            <Pager
              total={ledger.entries.length}
              page={page}
              perPage={perPage}
              note="The balance counts confirmed money only, so it agrees with what the customer owes"
              onPage={setPage}
              onPerPage={(n) => {
                setPerPage(n);
                setPage(1);
              }}
            />
          </div>
        )}

        {ledger.awaiting.count ? (
          <div className="mt-4">
            <Banner tone="warn">
              {money(ledger.awaiting.amount)} across{" "}
              {plural(ledger.awaiting.count, "receipt")} has been reported and not yet
              confirmed. It is not in the balance above, and it will not be until
              somebody finds it.
            </Banner>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const FIELD =
  "h-9.5 rounded-[4px] border border-line bg-surface px-2.5 text-sm focus:border-brand focus:outline-none";
