"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { longDate, money } from "@/lib/format";
import type { OutstandingCustomer } from "@/lib/engines/outstanding";
import {
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
 * Outstanding, by customer.
 *
 * One row per client with what they owe, and the bills behind it one click
 * away on the same row. The two questions are always asked together — "how
 * much does Alpha Paints owe" and "against which bills" — and answering the
 * second on a different screen is what makes somebody give up half way
 * through a chase.
 *
 * The inner table is the bill ledger's own columns in the ledger's own order,
 * deliberately: anybody reading this has read that, and a second arrangement
 * of the same seven figures is a second thing to learn.
 * ------------------------------------------------------------------------- */

type Sort = "owed" | "oldest" | "name";

const SORTS: Array<{ key: Sort; label: string }> = [
  { key: "owed", label: "Most owed" },
  { key: "oldest", label: "Oldest debt" },
  { key: "name", label: "Name" },
];

export function OutstandingScreen({
  rows,
  total,
  page,
  perPage,
  totals,
  query,
  sort,
  overdueOnly,
}: {
  /** ONE PAGE of customers, each with its own open bills. */
  rows: OutstandingCustomer[];
  /** Every customer the filters match, from a count in Postgres. */
  total: number;
  page: number;
  perPage: number;
  /** The figures above the table, over all of `total` rather than the page. */
  totals: {
    customers: number;
    outstanding: number;
    bills: number;
    overdueCustomers: number;
    overdue: number;
    unstatedCustomers: number;
    unstatedAmount: number;
  };
  query: string;
  sort: Sort;
  overdueOnly: boolean;
}) {
  const router = useRouter();
  const { push } = useToast();
  /*
   * Several rows may be open at once, unlike the bill ledger's one-at-a-time
   * panel. Nothing is fetched when a row opens — the bills of the customers on
   * THIS PAGE came down with it — and comparing two customers' bills side by
   * side is most of what this screen is for.
   */
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());

  /*
   * EVERY CONTROL WRITES THE URL. The search, the sort, the past-due filter and
   * the page used to be React state over an array of every open bill in the
   * book, nested under every customer — 3.3 MB of page to show twenty-five
   * names. It is also what makes a filtered list something somebody can send to
   * a colleague, which it never was.
   */
  function go(next: Record<string, string | number | null>) {
    const params = new URLSearchParams();
    const base: Record<string, string | number | null> = {
      q: query || null,
      sort: sort === "owed" ? null : sort,
      overdue: overdueOnly ? "1" : null,
      page,
      per: perPage,
      ...next,
    };
    for (const [k, v] of Object.entries(base)) {
      if (v !== null && v !== "" && v !== undefined) params.set(k, String(v));
    }
    router.push(`/accounts/outstanding?${params.toString()}`);
  }

  const narrow = (next: Record<string, string | number | null>) =>
    go({ ...next, page: 1 });

  const narrowed = query !== "" || overdueOnly;

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="max-w-[1400px]">
        <ScreenHeader
          title="Outstanding"
          subtitle="What every customer still owes, with the bills behind it one click away. Open bills across every financial year — the oldest debt on an account is usually last year's."
          actions={
            /*
             * EVERYBODY THE FILTERS MATCH, BUILT ON THE SERVER, bill by bill.
             * Assembled from what is on screen it would write out twenty-five
             * customers under a filename saying outstanding — a file somebody
             * opens, reads as the book, and chases from.
             */
            <a
              href={`/accounts/outstanding/export?${new URLSearchParams({
                ...(query ? { q: query } : {}),
                ...(overdueOnly ? { overdue: "1" } : {}),
              }).toString()}`}
              onClick={() => push("Building the file — everybody shown, not this page")}
              className="inline-flex h-9 cursor-pointer items-center rounded-[4px] border border-line-strong bg-surface px-3.5 text-sm font-medium text-body no-underline hover:bg-canvas"
            >
              Export
            </a>
          }
        />

        <MetricRow
          metrics={[
            {
              label: "Outstanding",
              value: money(totals.outstanding),
              sub: narrowed
                ? `${plural(totals.customers, "customer")} shown`
                : `${plural(totals.customers, "customer")} · ${plural(totals.bills, "bill")}`,
              tone: totals.outstanding > 0 ? "danger" : undefined,
            },
            {
              label: "Past due",
              value: money(totals.overdue),
              sub: `${plural(totals.overdueCustomers, "customer")} past a due date`,
              tone: totals.overdue > 0 ? "warn" : undefined,
            },
            {
              label: "Not stated",
              value: money(totals.unstatedAmount),
              // Said in words every time it is shown: this is not debt, and a
              // figure this size sitting unlabelled beside one that IS debt
              // would be read as more of the same.
              sub: `${plural(totals.unstatedCustomers, "customer")} · no payment recorded either way`,
            },
          ]}
        />

        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-[6px] border border-line bg-surface px-4 py-3">
          {/* Uncontrolled and keyed on the committed value: a round trip per
              letter would stutter under somebody's fingers, and resetting the
              box in an effect when the server answers is what the React
              Compiler rules refuse. Enter is what commits it. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const typed = String(new FormData(e.currentTarget).get("q") ?? "").trim();
              narrow({ q: typed || null });
            }}
          >
            <input
              key={query}
              name="q"
              defaultValue={query}
              placeholder="Find a customer"
              aria-label="Find a customer"
              className="h-8.5 w-[260px] rounded-[4px] border border-line bg-surface px-3 text-sm text-body outline-none placeholder:text-muted focus:border-brand"
            />
          </form>
          <span className="ml-2 text-[13px] text-muted">Sort</span>
          {SORTS.map((s) => (
            <button
              key={s.key}
              onClick={() => narrow({ sort: s.key })}
              className={cx(
                "h-7.5 cursor-pointer rounded-[4px] border px-3 text-[13px]",
                s.key === sort
                  ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                  : "border-line bg-surface text-body hover:bg-canvas",
              )}
            >
              {s.label}
            </button>
          ))}
          <button
            onClick={() => narrow({ overdue: overdueOnly ? null : "1" })}
            className={cx(
              "h-7.5 cursor-pointer rounded-[4px] border px-3 text-[13px]",
              overdueOnly
                ? "border-danger bg-danger-soft font-medium text-danger"
                : "border-line bg-surface text-body hover:bg-canvas",
            )}
          >
            Past due only
          </button>
          <span className="flex-1" />
          {rows.length ? (
            <button
              onClick={() =>
                setOpen((s) =>
                  s.size ? new Set() : new Set(rows.map((r) => r.customerId)),
                )
              }
              className="h-7.5 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body hover:bg-canvas"
            >
              {open.size ? "Collapse all" : "Expand this page"}
            </button>
          ) : null}
        </div>

        {rows.length === 0 ? (
          <Empty
            title={narrowed ? "Nobody matches that" : "Nothing is outstanding"}
            body={
              narrowed
                ? "Clear the search or the past-due filter. Only customers with an open bill appear here at all."
                : "Every bill in your book is either settled or has nothing recorded against it either way. Bills nobody has spoken for are counted separately rather than shown as debt."
            }
          />
        ) : (
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            <Table
              minWidth={1000}
              head={
                <>
                  <HeadCell>Customer</HeadCell>
                  <HeadCell align="right">Open bills</HeadCell>
                  <HeadCell>Oldest</HeadCell>
                  <HeadCell>Flags</HeadCell>
                  <HeadCell align="right">Not stated</HeadCell>
                  <HeadCell align="right">Outstanding</HeadCell>
                </>
              }
            >
              {rows.map((r, i) => {
                const isOpen = open.has(r.customerId);
                return (
                  <React.Fragment key={r.customerId}>
                    <Row striped={i % 2 === 1}>
                      <Cell className="font-medium text-ink" truncate={340}>
                        <button
                          onClick={() =>
                            setOpen((s) => {
                              const next = new Set(s);
                              if (!next.delete(r.customerId)) next.add(r.customerId);
                              return next;
                            })
                          }
                          aria-expanded={isOpen}
                          className="inline-flex max-w-full cursor-pointer items-center gap-1.5 text-left font-medium text-ink transition-colors hover:text-brand"
                          title={isOpen ? "Hide the bills" : "Show every open bill"}
                        >
                          <span
                            aria-hidden
                            className={cx(
                              "flex-none text-[10px] text-muted transition-transform",
                              isOpen ? "rotate-90" : "",
                            )}
                          >
                            ▶
                          </span>
                          <span className="truncate">{r.customerName}</span>
                        </button>
                      </Cell>
                      <Cell align="right">{r.openBills || "—"}</Cell>
                      <Cell
                        className={
                          r.oldestOverdueDays > 45
                            ? "text-danger"
                            : r.oldestOverdueDays > 0
                              ? "text-warn-ink"
                              : "text-muted"
                        }
                      >
                        {r.oldestOverdueDays > 0
                          ? `${r.oldestOverdueDays}d overdue${r.worstBucket ? ` · ${r.worstBucket}` : ""}`
                          : r.openBills
                            ? "Within terms"
                            : "—"}
                      </Cell>
                      <Cell>
                        <span className="flex gap-1.5">
                          {r.disputedBills ? (
                            <Pill tone="warn">{plural(r.disputedBills, "dispute")}</Pill>
                          ) : null}
                          {r.unstatedBills ? (
                            <Pill tone="neutral">{plural(r.unstatedBills, "not stated")}</Pill>
                          ) : null}
                        </span>
                      </Cell>
                      <Cell align="right" className="text-muted">
                        {r.unstatedAmount ? money(r.unstatedAmount) : "—"}
                      </Cell>
                      <Cell
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
                        {r.outstanding > 0 ? money(r.outstanding) : "—"}
                      </Cell>
                    </Row>

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
                {/* Everybody the filters match, not this page. */}
                <td colSpan={4} className="px-4 py-2.5 text-sm font-semibold text-ink">
                  {narrowed ? "These customers" : "Everybody"}
                </td>
                <td className="px-4 py-2.5 text-right text-sm font-semibold tabular-nums text-muted">
                  {totals.unstatedAmount ? money(totals.unstatedAmount) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right text-sm font-semibold tabular-nums text-ink">
                  {money(totals.outstanding)}
                </td>
              </tr>
            </Table>

            <Pager
              total={total}
              page={page}
              perPage={perPage}
              note="The totals above describe every customer shown, not this page"
              onPage={(p) => go({ page: p })}
              onPerPage={(n) => go({ page: 1, per: n })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The bills behind one customer's balance.
 *
 * The ledger's columns, in the ledger's order. An unstated bill is drawn
 * muted, with its balance said as "not stated" rather than as a figure —
 * rendering it beside real balances presents an unknown as a debt, which is
 * the whole mistake `payment_position` exists to stop.
 */
function BillBreakdown({ row }: { row: OutstandingCustomer }) {
  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          {plural(row.bills.length, "open bill")} · {row.customerName}
        </div>
        <Link
          href={`/accounts/ledger?customer=${row.customerId}`}
          className="text-[13px] text-brand no-underline"
        >
          Open the full account →
        </Link>
      </div>

      <div className="overflow-hidden rounded-[4px] border border-line bg-surface">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <HeadCell>Bill</HeadCell>
              <HeadCell>Billed</HeadCell>
              <HeadCell>Due</HeadCell>
              <HeadCell align="right">Amount</HeadCell>
              <HeadCell align="right">Received</HeadCell>
              <HeadCell align="right">Open</HeadCell>
              <HeadCell>Status</HeadCell>
            </tr>
          </thead>
          <tbody>
            {row.bills.map((b, i) => (
              <Row key={b.id} striped={i % 2 === 1}>
                <Cell className={b.unstated ? "text-muted" : "font-medium text-ink"}>
                  {b.billNo}
                </Cell>
                <Cell>{longDate(b.billDate)}</Cell>
                <Cell>{longDate(b.dueDate)}</Cell>
                <Cell align="right">{money(b.amount)}</Cell>
                <Cell align="right">{b.paid ? money(b.paid) : "—"}</Cell>
                <Cell
                  align="right"
                  className={cx(
                    "font-medium",
                    b.unstated
                      ? "text-muted"
                      : b.overdueDays > 45
                        ? "text-danger"
                        : "text-ink",
                  )}
                >
                  {b.unstated ? "—" : money(b.balance)}
                </Cell>
                <Cell>
                  <Pill
                    tone={
                      b.unstated
                        ? "neutral"
                        : b.disputed
                          ? "warn"
                          : b.overdueDays > 45
                            ? "danger"
                            : b.paid > 0
                              ? "warn"
                              : "brand"
                    }
                  >
                    {billWord(b)}
                  </Pill>
                </Cell>
              </Row>
            ))}
          </tbody>
        </table>
      </div>

      {row.unstatedBills ? (
        <p className="mt-2 max-w-[720px] text-[13px] text-pretty text-muted">
          {plural(row.unstatedBills, "bill")} here{" "}
          {row.unstatedBills === 1 ? "has" : "have"} no payment recorded either
          way — {money(row.unstatedAmount)} that is neither owed nor settled
          until somebody says which. It is not counted in this customer&apos;s
          outstanding, and nothing chases them for it.
        </p>
      ) : null}
    </div>
  );
}

function billWord(b: {
  unstated: boolean;
  disputed: boolean;
  overdueDays: number;
  paid: number;
}): string {
  if (b.unstated) return "Not stated";
  if (b.disputed) return "Disputed";
  if (b.overdueDays > 0) {
    return b.paid > 0 ? `Part paid · ${b.overdueDays}d late` : `${b.overdueDays}d overdue`;
  }
  return b.paid > 0 ? "Partly paid" : "Open";
}
