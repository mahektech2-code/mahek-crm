"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { BillDetailPanel } from "@/components/bills/bill-detail-panel";
import { downloadCsv, toCsv } from "@/lib/csv";
import { longDate, money } from "@/lib/format";
import {
  AgingStrip,
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
  type Bucket,
} from "../parts";

/* ---------------------------------------------------------------------------
 * The bill ledger.
 *
 * It lived in the CRM, which is where it was first needed and not where it
 * belongs: chasing a bill is a telecaller's, but the ledger itself is this
 * desk's.
 *
 * Cut by financial year, because ten thousand bills across three years is not
 * a list anybody scrolls and Mahek's own numbers already carry the year —
 * MMI/26-27/1119. Paging is over what is filtered IN: the totals row, the
 * aging strip and the export all describe the whole year while only the table
 * is cut into pages. A page that changed the totals under it would show a
 * different figure on every click.
 * ------------------------------------------------------------------------- */

export type BillRow = {
  id: string;
  billNo: string;
  customerId: string;
  customerName: string;
  billDate: string;
  dueDate: string;
  amount: number;
  paid: number;
  balance: number;
  overdueDays: number;
  status: string;
  disputed: boolean;
};

export function BillsScreen({
  rows,
  buckets,
  years,
  financialYear,
}: {
  rows: BillRow[];
  buckets: Bucket[];
  years: string[];
  financialYear: string;
}) {
  const router = useRouter();
  const { push } = useToast();
  const [page, setPage] = React.useState(1);
  const [perPage, setPerPage] = React.useState(25);

  const billed = rows.reduce((a, r) => a + r.amount, 0);
  const received = rows.reduce((a, r) => a + r.paid, 0);
  const open = rows.filter((r) => r.balance > 0);
  const openTotal = open.reduce((a, r) => a + r.balance, 0);
  /*
   * One bill open at a time. Six rows expanded is a ledger you cannot read,
   * and the panel fetches its own items — opening every row would fetch every
   * order behind a page of bills to show one.
   */
  const [openBillId, setOpenBillId] = React.useState<string | null>(null);
  const shown = rows.slice((page - 1) * perPage, page * perPage);

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="max-w-[1400px]">
        <ScreenHeader
          title="Bills"
          subtitle="Every bill raised, cut by financial year. The totals, the aging strip and the export describe the whole year — only the table is paged."
          actions={
            <button
              onClick={() => {
                downloadCsv(
                  `mahek-bills-${financialYear}`,
                  toCsv(
                    [
                      "Bill",
                      "Customer",
                      "Billed",
                      "Due",
                      "Amount (₹)",
                      "Received (₹)",
                      "Open (₹)",
                      "Days overdue",
                      "Status",
                    ],
                    rows.map((r) => [
                      r.billNo,
                      r.customerName,
                      r.billDate,
                      r.dueDate,
                      String(Math.round(r.amount / 100)),
                      String(Math.round(r.paid / 100)),
                      String(Math.round(r.balance / 100)),
                      r.overdueDays ? String(r.overdueDays) : "",
                      statusWord(r),
                    ]),
                  ),
                );
                push(`Exported ${plural(rows.length, "row")} — the whole year`);
              }}
              className="h-9 cursor-pointer rounded-[4px] border border-line-strong bg-surface px-3.5 text-sm font-medium text-body hover:bg-canvas"
            >
              Export
            </button>
          }
        />

        <div className="mb-4 flex items-center gap-2">
          <span className="text-[13px] text-muted">Financial year</span>
          {years.map((y) => (
            <button
              key={y}
              onClick={() => {
                setPage(1);
                router.push(`/accounts/bills?fy=${y}`);
              }}
              className={cx(
                "h-7.5 cursor-pointer rounded-[4px] border px-3 text-[13px]",
                y === financialYear
                  ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                  : "border-line bg-surface text-body hover:bg-canvas",
              )}
            >
              {y}
            </button>
          ))}
        </div>

        <MetricRow
          metrics={[
            { label: "Billed", value: money(billed), sub: `in ${financialYear}` },
            { label: "Received", value: money(received), sub: "confirmed only" },
            {
              label: "Still open",
              value: money(openTotal),
              sub: plural(open.length, "bill"),
              tone: openTotal > 0 ? "danger" : undefined,
            },
          ]}
        />

        <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
          <div className="mb-2.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            What is open, by age
          </div>
          <AgingStrip buckets={buckets} />
        </section>

        {rows.length === 0 ? (
          <Empty
            title="No bills in this year"
            body="Nothing was billed between 1 April and 31 March. Try another financial year, or run the sheet import if this year should have bills in it."
          />
        ) : (
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            <Table
              minWidth={1000}
              head={
                <>
                  <HeadCell>Bill</HeadCell>
                  <HeadCell>Customer</HeadCell>
                  <HeadCell>Billed</HeadCell>
                  <HeadCell>Due</HeadCell>
                  <HeadCell align="right">Amount</HeadCell>
                  <HeadCell align="right">Received</HeadCell>
                  <HeadCell align="right">Open</HeadCell>
                  <HeadCell>Status</HeadCell>
                </>
              }
            >
              {shown.map((r, i) => (
                <React.Fragment key={r.id}>
                <Row striped={i % 2 === 1}>
                  {/*
                    The bill number OPENS the bill rather than navigating away.
                    "How much and when" is on the row; "what was actually
                    bought" is the next question anybody asks, and it used to
                    have no answer on this side at all — the whole row went to
                    the customer's statement instead, which answers a different
                    question and, for a customer whose back office seat you
                    hold and whose sales seat you do not, used to throw.
                  */}
                  <Cell className="font-medium text-ink">
                    <button
                      onClick={() => setOpenBillId(openBillId === r.id ? null : r.id)}
                      aria-expanded={openBillId === r.id}
                      className="inline-flex cursor-pointer items-center gap-1.5 text-left font-medium text-ink transition-colors hover:text-brand"
                      title={openBillId === r.id ? "Hide the order" : "Show what was ordered"}
                    >
                      <span
                        aria-hidden
                        className={cx(
                          "text-[10px] text-muted transition-transform",
                          openBillId === r.id ? "rotate-90" : "",
                        )}
                      >
                        ▶
                      </span>
                      {r.billNo}
                    </button>
                  </Cell>
                  {/* The customer's name leads to their account, which is
                      where the REST of their bills are, with the payments
                      against them and a running balance. */}
                  <Cell truncate={230}>
                    <Link
                      href={`/accounts/ledger?customer=${r.customerId}`}
                      className="text-ink no-underline hover:text-brand hover:underline"
                    >
                      {r.customerName}
                    </Link>
                  </Cell>
                  {/* Read as a date, not as a database value — "2026-08-06"
                      is not how anybody says the sixth of August. */}
                  <Cell>{longDate(r.billDate)}</Cell>
                  <Cell>{longDate(r.dueDate)}</Cell>
                  <Cell align="right">{money(r.amount)}</Cell>
                  <Cell align="right">{r.paid ? money(r.paid) : "—"}</Cell>
                  <Cell
                    align="right"
                    className={cx(
                      "font-medium",
                      r.balance <= 0
                        ? "text-muted"
                        : r.overdueDays > 45
                          ? "text-danger"
                          : "text-ink",
                    )}
                  >
                    {r.balance > 0 ? money(r.balance) : "—"}
                  </Cell>
                  <Cell>
                    <Pill
                      tone={
                        r.disputed
                          ? "warn"
                          : r.balance <= 0
                            ? "success"
                            : r.overdueDays > 45
                              ? "danger"
                              : r.paid > 0
                                ? "warn"
                                : "neutral"
                      }
                    >
                      {statusWord(r)}
                    </Pill>
                  </Cell>
                </Row>
                {openBillId === r.id ? (
                  <tr>
                    <td colSpan={8} className="p-0">
                      {/* Keyed on the bill, so opening another row mounts a
                          fresh panel rather than resetting one in an effect. */}
                      <BillDetailPanel
                        key={r.id}
                        billId={r.id}
                        customerHref={(id) => `/accounts/ledger?customer=${id}`}
                      />
                    </td>
                  </tr>
                ) : null}
                </React.Fragment>
              ))}

              {/* The whole year, not this page — said in the row itself so
                  nobody reads it as a page subtotal. */}
              <tr className="border-t border-line bg-canvas">
                <td colSpan={4} className="px-4 py-2.5 text-sm font-semibold text-ink">
                  Whole year
                </td>
                <td className="px-4 py-2.5 text-right text-sm font-semibold tabular-nums text-ink">
                  {money(billed)}
                </td>
                <td className="px-4 py-2.5 text-right text-sm font-semibold tabular-nums text-ink">
                  {money(received)}
                </td>
                <td className="px-4 py-2.5 text-right text-sm font-semibold tabular-nums text-ink">
                  {money(openTotal)}
                </td>
                <td />
              </tr>
            </Table>

            <Pager
              total={rows.length}
              page={page}
              perPage={perPage}
              note="Totals, the aging strip and the export describe the whole year, not this page"
              onPage={setPage}
              onPerPage={(n) => {
                setPerPage(n);
                setPage(1);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The age belongs in the status rather than beside it — "Overdue" in one
 * column and "41 days" in another is one fact split across the width of the
 * table, and it was the split that pushed the status off the screen.
 */
function statusWord(r: BillRow): string {
  if (r.disputed) return "Disputed";
  if (r.balance <= 0) return "Paid";
  if (r.overdueDays > 0) {
    return r.paid > 0
      ? `Part paid · ${r.overdueDays}d late`
      : `${r.overdueDays}d overdue`;
  }
  return r.paid > 0 ? "Partly paid" : "Open";
}
