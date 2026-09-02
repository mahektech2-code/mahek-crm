"use client";

import * as React from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  MetricStrip,
  PageHeader,
  Select,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { downloadCsv, toCsv } from "@/lib/csv";
import { ageLabel, money, shortDate } from "@/lib/format";
import type { OutstandingBill, OutstandingCustomer } from "@/lib/engines/outstanding";

/* ---------------------------------------------------------------------------
 * Outstanding, by customer — the telecaller's side of it.
 *
 * The Payment Follow-up worklist says who to ring today and why. This says who
 * owes what, full stop, which is the question somebody asks when a customer
 * rings THEM: the name, the balance, and the bills it is made of, without
 * leaving the row.
 *
 * The inner table is the Sales Bills ledger's own columns, in its own order.
 * Anybody reading this screen has read that one, and a second arrangement of
 * the same figures is a second thing to learn mid-call.
 * ------------------------------------------------------------------------- */

type Sort = "owed" | "oldest" | "name";

const PER_PAGE = 25;

export function OutstandingScreen({
  rows,
  totals,
  scopeLabel,
}: {
  rows: OutstandingCustomer[];
  totals: {
    customers: number;
    outstanding: number;
    bills: number;
    overdueCustomers: number;
    overdue: number;
    unstatedCustomers: number;
    unstatedAmount: number;
  };
  scopeLabel: string;
}) {
  const { push } = useToast();
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<Sort>("owed");
  const [overdueOnly, setOverdueOnly] = React.useState(false);
  const [page, setPage] = React.useState(1);
  /*
   * Several rows may be open at once. Nothing is fetched when one opens — the
   * bills came down with the page — and a telecaller comparing two accounts
   * should not have to close one to see the other.
   */
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = rows;
    if (q) list = list.filter((r) => r.customerName.toLowerCase().includes(q));
    if (overdueOnly) list = list.filter((r) => r.oldestOverdueDays > 0);
    const sorted = [...list];
    if (sort === "oldest") {
      sorted.sort(
        (a, b) => b.oldestOverdueDays - a.oldestOverdueDays || b.outstanding - a.outstanding,
      );
    } else if (sort === "name") {
      sorted.sort((a, b) => a.customerName.localeCompare(b.customerName));
    }
    return sorted;
  }, [rows, query, overdueOnly, sort]);

  // The figures describe what is filtered IN, so the strip and the table can
  // never describe two different sets of customers.
  const shownTotal = filtered.reduce((a, r) => a + r.outstanding, 0);
  const shownUnstated = filtered.reduce((a, r) => a + r.unstatedAmount, 0);
  const narrowed = query.trim() !== "" || overdueOnly;

  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const current = Math.min(page, pages);
  const shown = filtered.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  return (
    <div className="p-5">
      <PageHeader
        title="Outstanding"
        subtitle={`What each customer still owes, with the bills behind it. ${scopeLabel} · open bills across every financial year, because the oldest debt on an account is usually last year's.`}
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              downloadCsv(
                "mahek-outstanding",
                toCsv(
                  [
                    "Customer",
                    "Bill no",
                    "Date",
                    "Due",
                    "Amount",
                    "Paid",
                    "Balance",
                    "Overdue days",
                    "Status",
                  ],
                  filtered.flatMap((r) =>
                    r.bills.map((b) => [
                      r.customerName,
                      b.billNo,
                      b.billDate,
                      b.dueDate,
                      String(Math.round(b.amount / 100)),
                      String(Math.round(b.paid / 100)),
                      String(Math.round(b.balance / 100)),
                      b.overdueDays ? String(b.overdueDays) : "",
                      billWord(b),
                    ]),
                  ),
                ),
              );
              push(`Exported ${filtered.length} customers, bill by bill`);
            }}
          >
            Export
          </Button>
        }
      />

      <MetricStrip
        metrics={[
          {
            label: "Outstanding",
            value: money(shownTotal),
            sub: narrowed
              ? `${filtered.length} customers shown`
              : `${totals.customers} customers · ${totals.bills} bills`,
            tone: shownTotal > 0 ? "danger" : "ink",
          },
          {
            label: "Past due",
            value: money(totals.overdue),
            sub: `${totals.overdueCustomers} past a due date`,
          },
          {
            label: "Not stated",
            value: money(narrowed ? shownUnstated : totals.unstatedAmount),
            // Never presented as debt. Nobody has said this money is owed, and
            // a telecaller must not ring a customer about it.
            sub: `${totals.unstatedCustomers} customers · nothing recorded either way`,
          },
        ]}
      />

      <Card className="mb-0 flex flex-wrap items-center gap-2.5 rounded-b-none px-4 py-3">
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          placeholder="Find a customer"
          aria-label="Find a customer"
          className="w-[240px]"
        />
        <Select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as Sort);
            setPage(1);
          }}
          className="h-8.5"
          aria-label="Sort"
        >
          <option value="owed">Most owed</option>
          <option value="oldest">Oldest debt</option>
          <option value="name">Name</option>
        </Select>
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-body">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => {
              setOverdueOnly(e.target.checked);
              setPage(1);
            }}
            className="cursor-pointer"
          />
          Past due only
        </label>
        {shown.length ? (
          <button
            onClick={() =>
              setOpen((s) =>
                s.size ? new Set() : new Set(shown.map((r) => r.customerId)),
              )
            }
            className="h-8 cursor-pointer px-2.5 text-sm text-brand"
          >
            {open.size ? "Collapse all" : "Expand this page"}
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {filtered.length} of {rows.length} customers
        </span>
      </Card>

      <Card className="max-h-[calc(100vh-330px)] overflow-auto rounded-t-none">
        {shown.length ? (
          <table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th align="right">Open bills</Th>
                <Th>Oldest</Th>
                <Th>Flags</Th>
                <Th align="right">Not stated</Th>
                <Th align="right">Outstanding</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const isOpen = open.has(r.customerId);
                return (
                  <React.Fragment key={r.customerId}>
                    <Tr className="hover:bg-canvas">
                      <Td className="font-medium text-ink">
                        <button
                          onClick={() =>
                            setOpen((s) => {
                              const next = new Set(s);
                              if (!next.delete(r.customerId)) next.add(r.customerId);
                              return next;
                            })
                          }
                          aria-expanded={isOpen}
                          className="inline-flex cursor-pointer items-center gap-1.5 text-left font-medium text-ink no-underline transition-colors hover:text-brand"
                          title={isOpen ? "Hide the bills" : "Show every open bill"}
                        >
                          <span
                            aria-hidden
                            className={cx(
                              "text-[10px] text-muted transition-transform",
                              isOpen && "rotate-90",
                            )}
                          >
                            ▶
                          </span>
                          {r.customerName}
                        </button>
                      </Td>
                      <Td align="right">{r.openBills || "-"}</Td>
                      <Td
                        className={
                          r.oldestOverdueDays > 45
                            ? "text-danger"
                            : r.oldestOverdueDays > 0
                              ? "text-warn-ink"
                              : "text-muted"
                        }
                      >
                        {r.oldestOverdueDays > 0
                          ? `${ageLabel(r.oldestOverdueDays)}${r.worstBucket ? ` · ${r.worstBucket}` : ""}`
                          : r.openBills
                            ? "Within terms"
                            : "-"}
                      </Td>
                      <Td>
                        <span className="flex gap-1.5">
                          {r.disputedBills ? (
                            <Badge tone="warn">{r.disputedBills} disputed</Badge>
                          ) : null}
                          {r.unstatedBills ? (
                            <Badge tone="muted">{r.unstatedBills} not stated</Badge>
                          ) : null}
                        </span>
                      </Td>
                      <Td align="right" className="text-muted">
                        {r.unstatedAmount ? money(r.unstatedAmount) : "-"}
                      </Td>
                      <Td
                        align="right"
                        className={cx(
                          "font-semibold",
                          r.outstanding <= 0
                            ? "text-muted"
                            : r.oldestOverdueDays > 45
                              ? "text-danger"
                              : "text-ink",
                        )}
                      >
                        {r.outstanding > 0 ? money(r.outstanding) : "-"}
                      </Td>
                    </Tr>

                    {isOpen ? (
                      <tr>
                        <td colSpan={6} className="border-b border-divider bg-canvas p-0">
                          <BillBreakdown row={r} />
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}

              <tr className="border-t border-line bg-canvas">
                <Td colSpan={4} className="font-semibold text-ink">
                  {narrowed ? "These customers" : "Everybody"} · {filtered.length}
                </Td>
                <Td align="right" className="font-semibold text-muted">
                  {shownUnstated ? money(shownUnstated) : "-"}
                </Td>
                <Td align="right" className="font-semibold text-ink">
                  {money(shownTotal)}
                </Td>
              </tr>
            </tbody>
          </table>
        ) : (
          <EmptyState
            title={rows.length ? "Nobody matches that" : "Nothing is outstanding"}
            body={
              rows.length
                ? "Clear the search or the past-due filter. Only customers with an open bill appear here at all."
                : "Every bill in your book is either settled or has nothing recorded against it either way. Bills nobody has spoken for are counted apart rather than shown as debt."
            }
          />
        )}
      </Card>

      {pages > 1 ? (
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="secondary"
            disabled={current === 1}
            onClick={() => setPage(current - 1)}
          >
            Previous
          </Button>
          <span className="text-[13px] text-muted">
            Page {current} of {pages}
          </span>
          <Button
            variant="secondary"
            disabled={current === pages}
            onClick={() => setPage(current + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The bills behind one customer's balance, and the two places a telecaller
 * goes next: the customer record, and the reminder message.
 *
 * An unstated bill is drawn muted with no balance figure — rendering it beside
 * real balances presents an unknown as a debt, and it is a debt this customer
 * must not be rung about.
 */
function BillBreakdown({ row }: { row: OutstandingCustomer }) {
  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
          {row.bills.length} open {row.bills.length === 1 ? "bill" : "bills"} ·{" "}
          {row.customerName}
        </div>
        <span className="flex gap-3">
          <Link
            href={`/crm/customers/${row.customerId}`}
            className="text-[13px] text-brand no-underline"
          >
            Customer record →
          </Link>
          <Link
            href={`/crm/whatsapp?customer=${row.customerId}`}
            className="text-[13px] text-brand no-underline"
          >
            Send a reminder →
          </Link>
        </span>
      </div>

      <Card className="overflow-hidden">
        <table>
          <thead>
            <tr>
              <Th>Bill no</Th>
              <Th>Date</Th>
              <Th>Due</Th>
              <Th align="right">Amount</Th>
              <Th align="right">Paid</Th>
              <Th align="right">Balance</Th>
              <Th align="right">Overdue</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {row.bills.map((b) => (
              <Tr key={b.id}>
                <Td className={b.unstated ? "text-muted" : "font-medium text-ink"}>
                  {b.billNo}
                </Td>
                <Td>{shortDate(b.billDate)}</Td>
                <Td className={!b.unstated && b.overdueDays > 0 ? "text-danger" : ""}>
                  {shortDate(b.dueDate)}
                </Td>
                <Td align="right">{money(b.amount)}</Td>
                <Td align="right" className={b.paid ? "text-success" : ""}>
                  {money(b.paid)}
                </Td>
                <Td
                  align="right"
                  className={
                    b.unstated ? "text-muted" : "font-medium text-danger"
                  }
                >
                  {b.unstated ? "-" : money(b.balance)}
                </Td>
                <Td align="right" className={b.overdueDays > 60 ? "text-danger" : ""}>
                  {!b.unstated && b.overdueDays > 0 ? ageLabel(b.overdueDays) : "-"}
                </Td>
                <Td>
                  <Badge
                    tone={
                      b.unstated
                        ? "muted"
                        : b.disputed
                          ? "warn"
                          : b.overdueDays > 45
                            ? "danger"
                            : b.paid > 0
                              ? "warn"
                              : "neutral"
                    }
                  >
                    {billWord(b)}
                  </Badge>
                </Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </Card>

      {row.unstatedBills ? (
        <p className="mt-2 max-w-[720px] text-[13px] text-muted">
          {row.unstatedBills} of these have no payment recorded either way —{" "}
          {money(row.unstatedAmount)} that is neither owed nor settled until
          accounts say which. It is not part of this customer&apos;s
          outstanding, and they are not chased for it.
        </p>
      ) : null}
    </div>
  );
}

function billWord(b: OutstandingBill): string {
  if (b.unstated) return "Not stated";
  if (b.disputed) return "Disputed";
  if (b.overdueDays > 0) {
    return b.paid > 0 ? `Part paid · ${b.overdueDays}d late` : `${b.overdueDays}d overdue`;
  }
  return b.paid > 0 ? "Partly paid" : "Open";
}
