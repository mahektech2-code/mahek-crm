import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import { fieldInvoices, fieldInvoiceSummary } from "@/lib/services/sales-service";
import {
  Cell,
  Empty,
  FilterChips,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  SortHead,
  Table,
} from "../parts";
import {
  plural,
} from "../words";
import { CustomerName } from "../customer-name";
import { readSort, sortHref, sortRows, type SortColumns } from "../sort";

export const metadata = { title: "Invoices — Sales Dashboard — MahekOne" };

/* The bands themselves moved into `sales-service.ts`, beside the SQL that
   sums them — they are the boundaries of a `filter (where …)` clause now, and
   a second copy of the numbers here would be a strip whose labels stopped
   describing its own bars. */

/**
 * Every bill raised against the field's book.
 *
 * The design's phrase for the open column is exact and worth keeping: **what is
 * left on each after confirmed money only.** `paid_amount` counts confirmed
 * receipts and nothing else, so a bill a salesman has reported money against
 * still stands here at its full amount — which is precisely the row somebody
 * needs an explanation on rather than a row to hide.
 *
 * A bill can also be `unstated`: the sheet raised it and nobody has said
 * whether it was paid. It counts as neither paid nor owed, is held out of the
 * aging strip, and says so — presenting an unknown as a debt is the mistake
 * that put nine crore of imaginary collections on this screen's ancestors.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;

  const show = (
    ["all", "open", "overdue", "unstated"].includes(params.show ?? "") ? params.show! : "open"
  ) as "all" | "open" | "overdue" | "unstated";

  /* EVERY FIGURE ON THIS SCREEN IS COUNTED IN SQL, and the table underneath is
     a page. They were one read: the whole screen was derived from `limit 300`
     ordered by the largest open balance, so the open total, the overdue total
     and the aging strip described the 300 biggest debts and were labelled as
     if they described the book — 300 of 10,815 on the real one. */
  const [result, summary] = await Promise.all([fieldInvoices(show), fieldInvoiceSummary()]);
  const rows = result.rows;

  const bands = summary.bands;
  const widest = Math.max(1, ...bands.map((b) => b.amountPaise));

  /* Sorting is DISPLAY ONLY. Every figure above this table — the four metrics,
     the aging strip and the chip counts — is counted in SQL over the whole
     book by `fieldInvoiceSummary`, so no amount of re-ordering can move one of
     them. That separation is what makes a client-visible sort safe here:
     pushing it into the query instead would re-order a capped read, quietly
     changing WHICH 300 bills are on the page, and the line above the table
     promising "the largest N" would become false without saying so. */
  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(rows, sort, COLUMNS);
  const head = (key: string, labelText: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/invoices", sort, key, `show=${show}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {labelText}
    </SortHead>
  );

  return (
    <div className="p-6">
      <ScreenHeader
        title="Invoices"
        subtitle="Every bill raised against the beats you cover, and what is left on each after confirmed money only. Money a salesman has merely reported is not subtracted here — it is shown where it happened, on Payments."
      />

      <MetricRow
        metrics={[
          { label: "Open", value: money(summary.openPaise), sub: plural(summary.openCount, "bill") },
          {
            label: "Overdue",
            value: money(summary.overduePaise),
            sub: plural(summary.overdueCount, "bill"),
            tone: summary.overdueCount ? "danger" : undefined,
          },
          {
            label: "Nobody has spoken for",
            value: String(summary.unstatedCount),
            sub: "neither paid nor owed",
            tone: summary.unstatedCount ? "warn" : undefined,
          },
          { label: "Bills in all", value: String(summary.total) },
        ]}
      />

      {summary.openCount ? (
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
                    style={{ width: `${Math.round((b.amountPaise / widest) * 100)}%` }}
                  />
                </span>
                <span className="w-[150px] flex-none text-right text-[13px] text-ink tabular-nums">
                  {b.amountPaise ? money(b.amountPaise) : "—"}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <FilterChips
        current={show}
                options={[
          { key: "open", href: `/sales/invoices?show=open`, label: "Open", count: summary.openCount },
          { key: "overdue", href: `/sales/invoices?show=overdue`, label: "Overdue", count: summary.overdueCount },
          { key: "unstated", href: `/sales/invoices?show=unstated`, label: "Unspoken for", count: summary.unstatedCount },
          { key: "all", href: `/sales/invoices?show=all`, label: "Everything", count: summary.total },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title={show === "overdue" ? "Nothing is overdue" : "No bills"}
          body={
            show === "unstated"
              ? "Every bill has somebody's word behind it — either money was recorded against it, or the receivables report named it as still owing."
              : "No bill has been raised against a shop in the field team's book."
          }
        />
      ) : (
        <>
          {/* The figures above are the whole book; this is a page of one view
              of it, biggest debt first. Saying so is the difference between a
              slice and a wrong total. */}
          {result.capped ? (
            <p className="mb-2 text-[13px] text-muted">
              The {rows.length} largest of {result.total} in this view.
            </p>
          ) : null}
        <Table
          minWidth={1280}
          head={
            <>
              {head("bill", "Bill", 180)}
              {head("customer", "Customer", 220)}
              {head("salesman", "Salesman", 160)}
              {head("due", "Due", 120)}
              {head("amount", "Amount", 140, "right")}
              {head("paid", "Paid", 140, "right")}
              {head("open", "Open", 140, "right")}
              {head("state", "State")}
            </>
          }
        >
          {sorted.map((b, i) => (
            <Row key={b.id} striped={i % 2 === 1}>
              <Cell truncate={180}>
                <span className="font-medium text-ink">{b.billNo}</span>
                <span className="block text-[12px] text-muted">{shortDate(b.billDate)}</span>
              </Cell>
              <Cell truncate={220}>
                <CustomerName id={b.customerId} name={b.customerName} />
              </Cell>
              <Cell truncate={160}>
                {b.salesmanId ? (
                  <Link
                    href={`/sales/people/${b.salesmanId}`}
                    className="no-underline"
                  >
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
                {Number(b.paidPaise) ? money(b.paidPaise) : <span className="text-muted">—</span>}
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
          ))}
        </Table>
        </>
      )}
    </div>
  );
}

/**
 * What each sortable column is worth.
 *
 * The money columns compare NUMBERS rather than the strings the cells print:
 * `money()` renders lakhs and crores in words, so sorting the rendered text
 * would put ₹9 lakh above ₹9 crore with nothing on the screen to explain it.
 *
 * **Open is null on a bill nobody has spoken for**, which is the one judgement
 * call here. Such a bill has an `openPaise` in the row and the cell
 * deliberately refuses to print it — it counts as neither paid nor owed —
 * so sorting on the hidden figure would rank the table by a number the screen
 * is on record as declining to show, and "not known" would appear half way up
 * a descending list of real debts. Null instead sends every unspoken-for bill
 * to the bottom, where the chip and the metric above already say how many
 * there are.
 *
 * State sorts on `overdueDays` rather than on the pill's wording, because that
 * is the ordering somebody means when they click it: worst first, by how late
 * rather than alphabetically by a label. Settled and merely open bills both
 * sit at zero or below and tie, which the stable sort leaves in the query's
 * own order.
 */
const COLUMNS: SortColumns<{
  billNo: string;
  customerName: string;
  salesmanName: string | null;
  dueDate: string | null;
  amountPaise: number;
  paidPaise: number;
  openPaise: number;
  overdueDays: number;
  paymentPosition: string;
}> = {
  bill: (b) => b.billNo,
  customer: (b) => b.customerName,
  salesman: (b) => b.salesmanName,
  due: (b) => (b.dueDate ? new Date(b.dueDate).getTime() : null),
  amount: (b) => Number(b.amountPaise),
  paid: (b) => Number(b.paidPaise),
  open: (b) => (b.paymentPosition === "stated" ? Number(b.openPaise) : null),
  state: (b) => b.overdueDays,
};
