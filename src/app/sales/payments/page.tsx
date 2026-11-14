import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import { getConfig } from "@/lib/config/store";
import { fieldReceipts } from "@/lib/services/sales-service";
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
  SortHead,
  Table,
} from "../parts";
import {
  plural,
} from "../words";
import { CustomerName } from "../customer-name";
import { readSort, sortHref, sortRows, type SortColumns } from "../sort";

export const metadata = { title: "Payments — Sales Dashboard — MahekOne" };

/**
 * What the field says it has collected, and who is still holding cash.
 *
 * Two different questions on one screen, and the design is right to put them
 * together: the second is the one with somebody's name on it.
 *
 * **Cash is a personal liability until it is banked.** A transfer is already in
 * the bank and a cheque is banked by the office, so only cash is counted
 * against the deposit window — `mbos.payments.cashDepositSlaHours`, which the
 * handset shows the salesman too. A deposit is his half of the answer; accounts
 * confirming it against the statement is the other, and only that half counts
 * as money the business has seen.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const [receipts, config] = await Promise.all([fieldReceipts(), getConfig()]);

  const slaDays = Math.max(1, Math.round(config["mbos.payments.cashDepositSlaHours"] / 24));

  /* `cash` is EVERY unbanked note in scope and the table below is a capped
     page of the log. They were one list once, and deriving the cash figure by
     filtering the page meant the oldest money — which is the whole subject of
     this screen — fell off the bottom of it first. */
  const { rows: receiptRows, cash, reported, confirmed } = receipts;
  const late = cash.filter((r) => r.heldDays > slaDays);

  const held = cash.reduce((n, r) => n + Number(r.amountPaise), 0);
  const lateHeld = late.reduce((n, r) => n + Number(r.amountPaise), 0);

  /*
   * CASH IN HAND IS THE DEFAULT VIEW, because it is the half of this screen
   * with somebody's name on it. The log answers "what did the team collect",
   * which is a question anybody can ask at leisure; the cash answers "who is
   * carrying company money tonight", which is a conversation with a person and
   * the only thing here that gets worse the longer it is left.
   */
  const show = (
    ["cash", "reported", "confirmed", "all"].includes(params.show ?? "") ? params.show! : "cash"
  ) as "cash" | "reported" | "confirmed" | "all";

  /*
   * The cash view is the uncapped list itself rather than the log filtered
   * down to it. Filtering the page would reintroduce exactly the bug the two
   * separate reads exist to prevent: the log is newest-first, so the oldest
   * unbanked note — the one the deposit window is about — is the first row the
   * cap drops.
   */
  const visible =
    show === "cash"
      ? cash
      : show === "all"
        ? receiptRows
        : receiptRows.filter((r) => r.status === show);

  /*
   * THE CHIP COUNTS ARE SQL'S AND THE TABLE IS A PAGE OF ONE VIEW.
   *
   * Every figure on a chip comes from the counted read over the whole book —
   * `cash.length` is the complete unbanked list, the other three are `count(*)
   * filter (…)`. Counting the rows this page happens to hold instead would be
   * cheaper and would be wrong in the one direction nobody notices: a chip
   * reading "Reported 41" on a book with 380 reported receipts looks like an
   * answer rather than like a page, and the number it gives is the number of
   * reported receipts among the newest 300. The cap is disclosed under the
   * chips instead, which says both true things rather than one of them.
   */
  const counts = { cash: cash.length, reported, confirmed, all: receipts.total };

  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(visible, sort, COLUMNS);
  const head = (key: string, label: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/payments", sort, key, `show=${show}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {label}
    </SortHead>
  );

  /* Who is holding what, because cash is answered for by a person. */
  const byPerson = new Map<string, { name: string; id: string | null; amount: number; oldest: number }>();
  for (const r of cash) {
    const key = r.salesmanId ?? "—";
    const at = byPerson.get(key) ?? {
      name: r.salesmanName ?? "Nobody named",
      id: r.salesmanId,
      amount: 0,
      oldest: 0,
    };
    at.amount += Number(r.amountPaise);
    at.oldest = Math.max(at.oldest, r.heldDays);
    byPerson.set(key, at);
  }

  return (
    <div className="p-6">
      <ScreenHeader
        title="Payments"
        subtitle={`What the team has collected, and who is still holding company cash. ${plural(slaDays, "working day")} is the deposit window, and it is the same number the handset shows them.`}
      />

      {late.length ? (
        <Banner
          tone="danger"
          title={`${money(lateHeld)} is past the deposit window`}
          body={
            <>
              {[...byPerson.values()]
                .filter((p) => p.oldest > slaDays)
                .map((p) => `${p.name} — ${money(p.amount)}, oldest ${plural(p.oldest, "day")}`)
                .join(" · ")}
              . Cash is a personal liability until it is banked, so this is a conversation with a
              person rather than a number on a report.
            </>
          }
        />
      ) : null}

      {/* The figures are counted over the whole book and do NOT move when a
          chip is picked. A metric that changed with the filter under it would
          be the screen disagreeing with itself — and the disagreement would
          look like an answer, because nothing on the row says which set it was
          taken over. */}
      <MetricRow
        metrics={[
          {
            label: "Cash in hand",
            value: money(held),
            sub: cash.length ? `${plural(cash.length, "receipt")}` : "nothing held",
            tone: held ? "warn" : undefined,
          },
          {
            label: "Past the window",
            value: String(late.length),
            tone: late.length ? "danger" : undefined,
          },
          {
            label: "Reported",
            value: String(reported),
            sub: "not yet found in the bank",
          },
          { label: "Confirmed", value: String(confirmed), tone: "success" },
        ]}
      />

      {byPerson.size ? (
        <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
          <div className="mb-2.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Cash in hand, by person
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            {[...byPerson.values()].map((p) => (
              <span key={p.name} className="block">
                <span className="block text-[13px] text-body">{p.name}</span>
                <span
                  className={
                    "block text-lg font-semibold tabular-nums " +
                    (p.oldest > slaDays ? "text-danger" : "text-ink")
                  }
                >
                  {money(p.amount)}
                </span>
                <span className="block text-[12px] text-muted">
                  oldest {plural(p.oldest, "day")}
                </span>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {receipts.total === 0 ? (
        <Empty
          title="Nothing collected"
          body="No receipt has been recorded on a handset. Money a salesman reports is not money the business has seen — it counts against a bill when accounts confirm it against the bank."
        />
      ) : (
        <>
          <FilterChips
            current={show}
            options={[
              { key: "cash", href: "/sales/payments?show=cash", label: "Cash in hand", count: counts.cash },
              { key: "reported", href: "/sales/payments?show=reported", label: "Reported", count: counts.reported },
              { key: "confirmed", href: "/sales/payments?show=confirmed", label: "Confirmed", count: counts.confirmed },
              { key: "all", href: "/sales/payments?show=all", label: "Everything", count: counts.all },
            ]}
          />

          {/* WHAT THIS TABLE IS A SLICE OF, said rather than left to be worked
              out. The figures above it are counted in SQL over the whole book,
              so a capped page underneath them is honest — a capped page with
              totals derived FROM it was not.

              The cash view is exempt because it is not a page: that read is
              deliberately uncapped, so what is drawn there IS the complete
              answer and a sentence implying otherwise would send somebody
              looking for money that is already on the screen. */}
          {show !== "cash" && receipts.capped ? (
            <p className="mb-2 text-[13px] text-muted">
              The newest {receiptRows.length} of {receipts.total} receipts
              {show === "all" ? "" : `, of which ${sorted.length} are ${show}`}. The chip counts
              above are taken over every receipt, so they can be larger than what this page holds.
              Every unbanked cash note is counted whatever page it falls on.
            </p>
          ) : null}

          {sorted.length === 0 ? (
            <Empty
              title={show === "cash" ? "No cash is being held" : `Nothing ${show}`}
              body={
                show === "cash"
                  ? "Every note the team has collected has been paid in. Cash is a personal liability until it is banked, so an empty list here is the state to be in."
                  : "No receipt on this page is in that state. The count on the chip is taken over the whole book, so there may be older ones behind the cap."
              }
            />
          ) : (
        <Table
          minWidth={1180}
          head={
            <>
              {head("salesman", "Salesman", 160)}
              {head("customer", "Customer", 210)}
              {head("amount", "Amount", 140, "right")}
              {head("mode", "How", 130)}
              {/* A reference is a bank's string, not an ordering anybody wants
                  a table in — sorting by it would group UTRs by which bank
                  issued them, which answers nothing. */}
              <HeadCell width={180}>Reference</HeadCell>
              {head("on", "On", 130)}
              {head("state", "State")}
            </>
          }
        >
          {sorted.map((r, i) => {
            const isCash = r.mode.toLowerCase() === "cash";
            const overdue = isCash && !r.depositedAt && r.heldDays > slaDays;
            return (
              <Row key={r.id} striped={i % 2 === 1}>
                <Cell truncate={160}>
                  {r.salesmanId ? (
                    <Link
                      href={`/sales/people/${r.salesmanId}`}
                      className="no-underline"
                    >
                      {r.salesmanName}
                    </Link>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell truncate={210}>
                  <CustomerName id={r.customerId} name={r.customerName} />
                </Cell>
                <Cell align="right">{money(r.amountPaise)}</Cell>
                <Cell>{r.mode}</Cell>
                <Cell truncate={180} title={r.note ?? undefined}>
                  {r.reference ?? (
                    <span className="text-muted" title="Asked for, never demanded — a salesman repeating what a customer said rarely has the UTR.">
                      none given
                    </span>
                  )}
                </Cell>
                <Cell>{shortDate(r.receivedAt)}</Cell>
                <Cell>
                  <Pill
                    tone={
                      r.status === "confirmed"
                        ? "success"
                        : r.status === "rejected" || r.status === "reversed"
                          ? "danger"
                          : "warn"
                    }
                  >
                    {r.status}
                  </Pill>
                  {r.depositedAt ? (
                    <span className="ml-1.5" title={`Banked ${stamp(r.depositedAt)}`}>
                      <Pill tone="brand">Deposited</Pill>
                    </span>
                  ) : isCash ? (
                    <span
                      className={
                        "ml-1.5 text-[12px] " + (overdue ? "text-danger" : "text-muted")
                      }
                    >
                      held {plural(r.heldDays, "day")}
                    </span>
                  ) : null}
                </Cell>
              </Row>
            );
          })}
        </Table>
          )}
        </>
      )}

      <p className="mt-3 max-w-[820px] text-[13px] text-pretty text-muted">
        A receipt is what the salesman says he collected. It counts against a bill only when
        accounts confirm it against the bank — until then nothing here has moved an outstanding
        balance. Deposited means he has told us he paid the cash in, which is his half of the
        answer and not the confirmation.
      </p>
    </div>
  );
}

/**
 * What each sortable column is worth.
 *
 * `null` sorts last in both directions, which is what a receipt with nobody
 * named against it deserves: it is a row somebody has to go and account for,
 * not the answer to "who collected the most".
 *
 * `receivedAt` is a date string off the query rather than an instant, so it is
 * compared as a number of milliseconds rather than as text — a string compare
 * is right for ISO and silently wrong the moment the column's format changes.
 */
const COLUMNS: SortColumns<{
  salesmanName: string | null;
  customerName: string;
  amountPaise: number;
  mode: string;
  receivedAt: string;
  status: string;
}> = {
  salesman: (r) => r.salesmanName,
  customer: (r) => r.customerName,
  amount: (r) => Number(r.amountPaise),
  mode: (r) => r.mode,
  on: (r) => new Date(r.receivedAt).getTime(),
  state: (r) => r.status,
};
