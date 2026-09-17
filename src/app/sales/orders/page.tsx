import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import { fieldOrders, fieldOrderSummary } from "@/lib/services/sales-service";
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
} from "@/components/console/parts";
import {
  plural,
  waitingWords,
} from "@/components/console/words";
import { CustomerName } from "@/components/console/customer-name";
import { readSort, sortHref, sortRows, type SortColumns } from "@/components/console/sort";

export const metadata = { title: "Orders — Sales Dashboard — MahekOne" };

/**
 * Orders taken in the field.
 *
 * The design's subtitle states the rule: nothing above a customer's credit
 * limit dispatches until somebody decides, and declining sends the salesman
 * back to the customer with the reason.
 *
 * **The decision is not made here, and the screen says why.** Approving is
 * accounts' and nobody else's — not a manager's by seniority, because the
 * person chasing the target must not sign off the orders that hit it. What a
 * sales manager needs from this screen is to know one of their people is
 * stuck, and what the order is up against: the customer's limit, and what they
 * already owe.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;

  const show = (
    ["all", "waiting", "overlimit"].includes(params.show ?? "") ? params.show! : "waiting"
  ) as "all" | "waiting" | "overlimit";

  /* THE FIGURES COME FROM SQL AND THE TABLE IS A PAGE.
     They were one read: the whole screen was derived from the newest 300
     orders, so "Taken in the field · all time" printed 300 for ever and an
     order stuck in approval longer than 300 orders ago was missing from the
     waiting count as well as from the queue. A queue that loses its oldest
     item is the worst possible direction for that. */
  const [result, summary] = await Promise.all([fieldOrders(show), fieldOrderSummary()]);
  const rows = result.rows;

  const waiting = summary.waiting;
  const overLimit = summary.overLimit;
  const oldest = summary.oldestWaitingHours;
  const value = Number(summary.waitingValuePaise);

  /* Sorting is DISPLAY ONLY, over the page this screen already holds. The
     four metrics and the chip counts above come from `fieldOrderSummary`,
     which counts in SQL over every order ever taken in the field — so
     re-ordering the table cannot move any of them, which is the point.
     Sorting in SQL instead would have been the obvious alternative and is
     worse here: the read is capped, so a sort pushed into the query would
     silently change WHICH orders are on the page as well as their order, and
     the sentence above the table promising "the newest N" would stop being
     true. */
  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(rows, sort, COLUMNS);
  const head = (key: string, labelText: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/orders", sort, key, `show=${show}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {labelText}
    </SortHead>
  );

  return (
    <div className="p-6">
      <ScreenHeader
        title="Orders"
        subtitle="Nothing above a customer's credit limit dispatches until somebody decides. Declining sends the salesman back to the customer with the reason, so it is never left unsaid."
      />

      {waiting ? (
        <Banner
          tone={oldest >= 24 ? "danger" : "warn"}
          title={`${plural(waiting, "order")} waiting, worth ${money(value)}`}
          body={
            <>
              The oldest has been waiting {waitingWords(oldest)}. Approving is accounts&rsquo; and
              not the sales desk&rsquo;s — the person chasing the target does not sign off the
              orders that hit it. They are decided in{" "}
              <Link href="/accounts/approvals">Accounts → Order approvals</Link>.
            </>
          }
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Waiting", value: String(waiting), tone: waiting ? "warn" : undefined },
          { label: "Value waiting", value: money(value) },
          {
            label: "Over the limit",
            value: String(overLimit),
            sub: overLimit ? "these are the hard ones" : undefined,
            tone: overLimit ? "danger" : undefined,
          },
          { label: "Taken in the field", value: String(summary.total), sub: "all time" },
        ]}
      />

      <FilterChips
        current={show}
                options={[
          { key: "waiting", href: `/sales/orders?show=waiting`, label: "Waiting", count: waiting },
          { key: "overlimit", href: `/sales/orders?show=overlimit`, label: "Over the limit", count: overLimit },
          { key: "all", href: `/sales/orders?show=all`, label: "Everything", count: summary.total },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title={show === "all" ? "No orders from the field" : "Nothing waiting"}
          body={
            show === "all"
              ? "No order has been taken on a handset yet. An order reaches the office on the next sync, so one taken with no signal will appear later rather than not at all."
              : "Every order taken in the field has been decided."
          }
        />
      ) : (
        <>
          {/* The chips count the whole book and this table is a page of one
              view of it. Both are true; only saying one of them was not. */}
          {result.capped ? (
            <p className="mb-2 text-[13px] text-muted">
              The newest {rows.length} of {result.total}
              {show === "all" ? " orders" : " in this view"}.
            </p>
          ) : null}
        <Table
          minWidth={1240}
          head={
            <>
              {head("order", "Order", 170)}
              {head("salesman", "Salesman", 160)}
              {head("customer", "Customer", 210)}
              {head("value", "Value", 140, "right")}
              {head("limit", "Their limit", 150, "right")}
              {head("cans", "Cans", 100, "right")}
              {/* Terms is not sortable: it is the customer's standing payment
                  term restated on the order, so ordering by it groups rows by
                  a fact about the shop rather than answering anything about
                  the queue. */}
              <HeadCell width={110}>Terms</HeadCell>
              {head("state", "State")}
            </>
          }
        >
          {sorted.map((o, i) => {
            const room =
              o.creditLimitPaise == null
                ? null
                : Number(o.creditLimitPaise) - Number(o.outstandingPaise);
            const over =
              o.creditBlocked || (room != null && Number(o.totalAmountPaise) > room);
            return (
              <Row key={o.id} striped={i % 2 === 1}>
                <Cell truncate={170} title={stamp(o.orderedAt)}>
                  <span className="font-medium text-ink">
                    {o.orderNo ?? "Not yet numbered"}
                  </span>
                  <span className="block text-[12px] text-muted">
                    {shortDate(o.orderedAt)}
                  </span>
                </Cell>
                <Cell truncate={160}>
                  {o.salesmanId ? (
                    <Link
                      href={`/sales/people/${o.salesmanId}`}
                      className="no-underline"
                    >
                      {o.salesmanName}
                    </Link>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell truncate={210}>
                  <CustomerName id={o.customerId} name={o.customerName} />
                </Cell>
                <Cell align="right">{money(o.totalAmountPaise)}</Cell>
                <Cell align="right">
                  {o.creditLimitPaise != null ? (
                    <>
                      {money(o.creditLimitPaise)}
                      <span className="block text-[12px] text-muted">
                        {money(o.outstandingPaise)} owing
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">None set</span>
                  )}
                </Cell>
                <Cell align="right">{o.cans || <span className="text-muted">—</span>}</Cell>
                <Cell>
                  {o.creditTermDays ? `${o.creditTermDays} days` : <span className="text-muted">—</span>}
                </Cell>
                <Cell>
                  {o.status === "pending_approval" ? (
                    <>
                      <Pill tone={over ? "danger" : "warn"}>
                        {o.creditBlocked ? "Credit blocked" : over ? "Above limit" : "Waiting"}
                      </Pill>
                      <span className="ml-1.5 text-[12px] text-muted">
                        {waitingWords(o.waitingHours)}
                      </span>
                    </>
                  ) : (
                    <Pill
                      tone={
                        o.status === "declined" || o.status === "cancelled"
                          ? "danger"
                          : "success"
                      }
                    >
                      {o.status.replace(/_/g, " ")}
                    </Pill>
                  )}
                </Cell>
              </Row>
            );
          })}
        </Table>
        </>
      )}
    </div>
  );
}

/**
 * What each sortable column is worth.
 *
 * Value and the credit limit are compared as NUMBERS rather than as the money
 * strings the cells print: `money()` renders lakhs and crores in words, so
 * sorting the rendered text would put ₹9 lakh above ₹9 crore and nothing on
 * the screen would say why.
 *
 * "Their limit" sorts on the limit itself and not on the room left under it.
 * The two are different questions and the column heading asks the first one; a
 * sort that quietly answered the second would disagree with the figure printed
 * beneath it. An account with no limit set has none to sort on, so it is null
 * and falls to the bottom either way — which is honest, since "no limit" is
 * not a large limit.
 *
 * State sorts on the raw status and not on the pill's wording, so
 * `pending_approval` groups together whether the pill reads Waiting, Above
 * limit or Credit blocked — those three are one state of the order with three
 * readings of the customer behind it.
 */
const COLUMNS: SortColumns<{
  orderNo: string | null;
  salesmanName: string | null;
  customerName: string;
  totalAmountPaise: number;
  creditLimitPaise: number | null;
  cans: number;
  status: string;
}> = {
  order: (o) => o.orderNo,
  salesman: (o) => o.salesmanName,
  customer: (o) => o.customerName,
  value: (o) => Number(o.totalAmountPaise),
  limit: (o) => (o.creditLimitPaise == null ? null : Number(o.creditLimitPaise)),
  cans: (o) => o.cans,
  state: (o) => o.status,
};
