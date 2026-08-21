import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import { fieldInvoices } from "@/lib/services/sales-service";
import {
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../parts";
import {
  plural,
} from "../words";

export const metadata = { title: "Invoices — Sales Dashboard — MahekOne" };

/** The design's aging bands, oldest last. */
const BANDS = [
  { label: "Not due", from: -9999, to: 0 },
  { label: "1–30 days", from: 1, to: 30 },
  { label: "31–60", from: 31, to: 60 },
  { label: "61–90", from: 61, to: 90 },
  { label: "Over 90", from: 91, to: 9999 },
];

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
  searchParams: Promise<{ show?: string }>;
}) {
  const params = await searchParams;
  const all = await fieldInvoices();

  const show = ["all", "open", "overdue", "unstated"].includes(params.show ?? "")
    ? params.show!
    : "open";

  const stated = all.filter((b) => b.paymentPosition === "stated");
  const unstated = all.filter((b) => b.paymentPosition !== "stated");
  const open = stated.filter((b) => Number(b.openPaise) > 0);
  const overdue = open.filter((b) => b.overdueDays > 0);

  const rows =
    show === "all" ? all : show === "overdue" ? overdue : show === "unstated" ? unstated : open;

  const owed = open.reduce((n, b) => n + Number(b.openPaise), 0);
  const overdueOwed = overdue.reduce((n, b) => n + Number(b.openPaise), 0);

  const bands = BANDS.map((b) => ({
    ...b,
    amount: open
      .filter((x) => x.overdueDays >= b.from && x.overdueDays <= b.to)
      .reduce((n, x) => n + Number(x.openPaise), 0),
  }));
  const widest = Math.max(1, ...bands.map((b) => b.amount));

  return (
    <div className="p-6">
      <ScreenHeader
        title="Invoices"
        subtitle="Every bill raised against the beats you cover, and what is left on each after confirmed money only. Money a salesman has merely reported is not subtracted here — it is shown where it happened, on Payments."
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

      <FilterChips
        current={show}
                options={[
          { key: "open", href: `/sales/invoices?show=open`, label: "Open", count: open.length },
          { key: "overdue", href: `/sales/invoices?show=overdue`, label: "Overdue", count: overdue.length },
          { key: "unstated", href: `/sales/invoices?show=unstated`, label: "Unspoken for", count: unstated.length },
          { key: "all", href: `/sales/invoices?show=all`, label: "Everything", count: all.length },
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
          {rows.map((b, i) => (
            <Row key={b.id} striped={i % 2 === 1}>
              <Cell truncate={180}>
                <span className="font-medium text-ink">{b.billNo}</span>
                <span className="block text-[12px] text-muted">{shortDate(b.billDate)}</span>
              </Cell>
              <Cell truncate={220}>{b.customerName}</Cell>
              <Cell truncate={160}>
                {b.salesmanId ? (
                  <Link
                    href={`/sales/people/${b.salesmanId}`}
                    className="no-underline hover:underline"
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
      )}
    </div>
  );
}
