"use client";

import * as React from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { BillDetailPanel } from "@/components/bills/bill-detail-panel";
import { Pager } from "@/components/ui/pager";
import { downloadCsv, toCsv } from "@/lib/csv";
import { money, shortDate } from "@/lib/format";
import type { FieldInvoice } from "@/lib/services/sales-service";
import { Cell, Empty, HeadCell, MetricRow, Pill, Row, ScreenHeader, Table } from "../parts";
import { plural } from "../words";

/* ---------------------------------------------------------------------------
 * Every bill raised against the field's book.
 *
 * It was a server component drawing all 300 rows at once, with the filter
 * chips as links that reloaded the page. On a book that grows — and this one
 * is three years of bills — that is a screen nobody can get to the bottom of,
 * and the one question a manager asks of a bill was not on it at all: what was
 * actually ordered.
 *
 * So it is the Accounts bill ledger's shape, deliberately: the same `Pager`,
 * the same row that opens into `BillDetailPanel`, the same rule about which
 * figures describe what. A manager who has learned one of these screens has
 * learned the other, and the two were already showing the same bills from two
 * different angles.
 *
 * **THE FIGURES ABOVE DESCRIBE EVERY BILL, not this page and not this search.**
 * That is the rule the Accounts ledger states about its year, and it matters
 * more here because there are two narrowings rather than one — a chip and a
 * search box. A total that moved as somebody typed would be a different number
 * every keystroke, and the aging strip is the shape of the debt rather than of
 * whatever is on screen. The pager says so in words.
 * ------------------------------------------------------------------------- */

/** The design's aging bands, oldest last. */
const BANDS = [
  { label: "Not due", from: -9999, to: 0 },
  { label: "1–30 days", from: 1, to: 30 },
  { label: "31–60", from: 31, to: 60 },
  { label: "61–90", from: 61, to: 90 },
  { label: "Over 90", from: 91, to: 9999 },
];

type Show = "open" | "overdue" | "unstated" | "all";

export function InvoicesScreen({
  all,
  initialShow,
}: {
  all: FieldInvoice[];
  initialShow: Show;
}) {
  const { push } = useToast();
  const [show, setShow] = React.useState<Show>(initialShow);
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [perPage, setPerPage] = React.useState(25);
  /*
   * One bill open at a time. Six rows expanded is a ledger you cannot read,
   * and the panel fetches its own items — opening every row would fetch every
   * order behind a page of bills in order to show one.
   */
  const [openBillId, setOpenBillId] = React.useState<string | null>(null);

  const stated = all.filter((b) => b.paymentPosition === "stated");
  const unstated = all.filter((b) => b.paymentPosition !== "stated");
  const open = stated.filter((b) => Number(b.openPaise) > 0);
  const overdue = open.filter((b) => b.overdueDays > 0);

  const byChip =
    show === "all" ? all : show === "overdue" ? overdue : show === "unstated" ? unstated : open;

  /* Bill number, customer, salesman — the three things somebody arrives here
     holding. Not the amount: "1,43,063" typed into a search box is a figure
     somebody read off this screen, and matching it would return the row they
     are already looking at. */
  const term = query.trim().toLowerCase();
  const rows = term
    ? byChip.filter((b) =>
        [b.billNo, b.customerName, b.salesmanName ?? ""].some((f) =>
          f.toLowerCase().includes(term),
        ),
      )
    : byChip;

  const owed = open.reduce((n, b) => n + Number(b.openPaise), 0);
  const overdueOwed = overdue.reduce((n, b) => n + Number(b.openPaise), 0);

  const bands = BANDS.map((b) => ({
    ...b,
    amount: open
      .filter((x) => x.overdueDays >= b.from && x.overdueDays <= b.to)
      .reduce((n, x) => n + Number(x.openPaise), 0),
  }));
  const widest = Math.max(1, ...bands.map((b) => b.amount));

  const shown = rows.slice((page - 1) * perPage, page * perPage);

  /* Any narrowing sends the reader back to the first page. Page 7 of a list
     that now has two rows is an empty table, and an empty table is read as
     "nothing matched" rather than as "you are past the end". */
  const narrow = (next: () => void) => {
    next();
    setPage(1);
    setOpenBillId(null);
  };

  const chips: { key: Show; label: string; count: number }[] = [
    { key: "open", label: "Open", count: open.length },
    { key: "overdue", label: "Overdue", count: overdue.length },
    { key: "unstated", label: "Unspoken for", count: unstated.length },
    { key: "all", label: "Everything", count: all.length },
  ];

  return (
    <div className="p-6">
      <ScreenHeader
        title="Invoices"
        subtitle="Every bill raised against the beats you cover, and what is left on each after confirmed money only. Money a salesman has merely reported is not subtracted here — it is shown where it happened, on Payments."
        actions={
          <button
            onClick={() => {
              downloadCsv(
                "mahek-field-invoices",
                toCsv(
                  ["Bill", "Billed", "Customer", "Salesman", "Due", "Amount (₹)", "Paid (₹)", "Open (₹)", "State"],
                  rows.map((b) => [
                    b.billNo,
                    b.billDate,
                    b.customerName,
                    b.salesmanName ?? "",
                    b.dueDate ?? "",
                    String(Math.round(Number(b.amountPaise) / 100)),
                    String(Math.round(Number(b.paidPaise) / 100)),
                    b.paymentPosition === "stated"
                      ? String(Math.round(Number(b.openPaise) / 100))
                      : "not known",
                    stateWord(b),
                  ]),
                ),
              );
              /* What was EXPORTED, which is what is filtered rather than what
                 is on the page — saying "25 rows" after exporting 300 is how
                 somebody opens the file expecting a page and finds a year. */
              push(`Exported ${plural(rows.length, "row")}`);
            }}
            disabled={rows.length === 0}
            className="h-8.5 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-sm text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export
          </button>
        }
      />

      <MetricRow
        metrics={[
          { label: "Open", value: money(owed), sub: plural(open.length, "bill") },
          {
            label: "Overdue",
            value: money(overdueOwed),
            sub: plural(overdue.length, "bill"),
            tone: overdue.length ? "danger" : undefined,
          },
          {
            label: "Nobody has spoken for",
            value: String(unstated.length),
            sub: "neither paid nor owed",
            tone: unstated.length ? "warn" : undefined,
          },
          { label: "Bills in all", value: String(all.length) },
        ]}
      />

      {open.length ? (
        <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
          <div className="mb-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            How old the money is
          </div>
          <div className="space-y-2">
            {bands.map((b) => (
              <div key={b.label} className="flex items-center gap-3">
                <span className="w-[110px] flex-none text-[13px] text-body">{b.label}</span>
                <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-[4px] bg-canvas">
                  <span
                    className={
                      "block h-full rounded-[4px] " +
                      (b.from > 60 ? "bg-danger" : b.from > 0 ? "bg-warn" : "bg-success")
                    }
                    style={{ width: `${Math.round((b.amount / widest) * 100)}%` }}
                  />
                </span>
                <span className="w-[150px] flex-none text-right text-[13px] text-ink tabular-nums">
                  {b.amount ? money(b.amount) : "—"}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => narrow(() => setShow(c.key))}
            className={cx(
              "h-8.5 cursor-pointer rounded-[4px] border px-3 text-sm",
              show === c.key
                ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                : "border-line bg-surface text-body hover:bg-canvas",
            )}
          >
            {c.label} <span className="text-muted">{c.count}</span>
          </button>
        ))}
        <span className="min-w-2 flex-1" />
        <input
          value={query}
          onChange={(e) => narrow(() => setQuery(e.target.value))}
          placeholder="Search a bill, customer or salesman"
          aria-label="Search invoices"
          className="h-8.5 w-[280px] rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
        />
      </div>

      {rows.length === 0 ? (
        <Empty
          title={term ? "Nothing matches that" : show === "overdue" ? "Nothing is overdue" : "No bills"}
          body={
            term
              ? `No bill, customer or salesman in this list matches “${query.trim()}”. ${byChip.length.toLocaleString("en-IN")} rows are here without it.`
              : show === "unstated"
                ? "Every bill has somebody's word behind it — either money was recorded against it, or the receivables report named it as still owing."
                : "No bill has been raised against a shop in the field team's book."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
          <Table
            minWidth={1280}
            head={
              <>
                <HeadCell width={180}>Bill</HeadCell>
                <HeadCell width={220}>Customer</HeadCell>
                <HeadCell width={160}>Salesman</HeadCell>
                <HeadCell width={120}>Due</HeadCell>
                <HeadCell align="right" width={140}>Amount</HeadCell>
                <HeadCell align="right" width={140}>Paid</HeadCell>
                <HeadCell align="right" width={140}>Open</HeadCell>
                <HeadCell>State</HeadCell>
              </>
            }
          >
            {shown.map((b, i) => (
              <React.Fragment key={b.id}>
                <Row striped={i % 2 === 1}>
                  {/* THE BILL NUMBER OPENS THE ORDER. It is the one question
                      this screen could not answer — how much and when were
                      here, and what was actually bought was a different app
                      away. Same control, same chevron and same panel as the
                      Accounts ledger, because they are the same act. */}
                  <Cell truncate={180}>
                    <button
                      onClick={() => setOpenBillId(openBillId === b.id ? null : b.id)}
                      aria-expanded={openBillId === b.id}
                      title={openBillId === b.id ? "Hide the order" : "Show what was ordered"}
                      className="inline-flex cursor-pointer items-center gap-1.5 text-left font-medium text-ink transition-colors hover:text-brand"
                    >
                      <span
                        aria-hidden
                        className={cx(
                          "text-[10px] text-muted transition-transform",
                          openBillId === b.id ? "rotate-90" : "",
                        )}
                      >
                        ▶
                      </span>
                      {b.billNo}
                    </button>
                    <span className="block text-[12px] text-muted">{shortDate(b.billDate)}</span>
                  </Cell>
                  <Cell truncate={220}>{b.customerName}</Cell>
                  <Cell truncate={160}>
                    {b.salesmanId ? (
                      <Link href={`/sales/people/${b.salesmanId}`} className="no-underline">
                        {b.salesmanName}
                      </Link>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Cell>
                  <Cell>
                    {b.dueDate ? shortDate(b.dueDate) : <span className="text-muted">—</span>}
                  </Cell>
                  <Cell align="right">{money(b.amountPaise)}</Cell>
                  <Cell align="right">
                    {Number(b.paidPaise) ? (
                      money(b.paidPaise)
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Cell>
                  <Cell align="right">
                    {b.paymentPosition === "stated" ? (
                      money(b.openPaise)
                    ) : (
                      <span
                        className="text-muted"
                        title="Nobody has said whether this was paid. It counts as neither paid nor owed until somebody does."
                      >
                        not known
                      </span>
                    )}
                  </Cell>
                  <Cell>
                    {b.paymentPosition !== "stated" ? (
                      <Pill tone="warn">Unspoken for</Pill>
                    ) : Number(b.openPaise) <= 0 ? (
                      <Pill tone="success">Settled</Pill>
                    ) : b.overdueDays > 0 ? (
                      <>
                        <Pill tone="danger">Overdue</Pill>
                        <span className="ml-1.5 text-[12px] text-danger">
                          {plural(b.overdueDays, "day")}
                        </span>
                      </>
                    ) : (
                      <Pill>Open</Pill>
                    )}
                  </Cell>
                </Row>
                {openBillId === b.id ? (
                  <tr>
                    <td colSpan={8} className="p-0">
                      {/* Keyed on the bill, so opening another row mounts a
                          fresh panel rather than resetting one in an effect. */}
                      {/* NO customer link here, deliberately. The Sales
                          Dashboard has no customer page — the nearest thing is
                          a pin on the territory map — and a link invented to
                          satisfy the component would land somebody on a screen
                          that does not answer for this shop. */}
                      <BillDetailPanel key={b.id} billId={b.id} />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </Table>

          <Pager
            total={rows.length}
            page={page}
            perPage={perPage}
            note="The figures above describe every bill, not this page or this search"
            onPage={setPage}
            onPerPage={(n) => {
              setPerPage(n);
              setPage(1);
            }}
          />
        </div>
      )}
    </div>
  );
}

/** The state, as one word, for the export. The screen draws it as a pill. */
function stateWord(b: FieldInvoice): string {
  if (b.paymentPosition !== "stated") return "Unspoken for";
  if (Number(b.openPaise) <= 0) return "Settled";
  if (b.overdueDays > 0) return `Overdue ${b.overdueDays}d`;
  return "Open";
}
