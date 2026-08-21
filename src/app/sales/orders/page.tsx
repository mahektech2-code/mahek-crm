import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import { fieldOrders } from "@/lib/services/sales-service";
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
  Table,
} from "../parts";
import {
  plural,
  waitingWords,
} from "../words";

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
  searchParams: Promise<{ show?: string }>;
}) {
  const params = await searchParams;
  const all = await fieldOrders();

  const show = ["all", "waiting", "overlimit"].includes(params.show ?? "")
    ? params.show!
    : "waiting";

  const waiting = all.filter((o) => o.status === "pending_approval");
  const overLimit = waiting.filter(
    (o) =>
      o.creditBlocked ||
      (o.creditLimitPaise != null &&
        Number(o.outstandingPaise) + Number(o.totalAmountPaise) > Number(o.creditLimitPaise)),
  );
  const rows = show === "all" ? all : show === "overlimit" ? overLimit : waiting;

  const oldest = waiting.reduce((n, o) => Math.max(n, o.waitingHours), 0);
  const value = waiting.reduce((n, o) => n + Number(o.totalAmountPaise), 0);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Orders"
        subtitle="Nothing above a customer's credit limit dispatches until somebody decides. Declining sends the salesman back to the customer with the reason, so it is never left unsaid."
      />

      {waiting.length ? (
        <Banner
          tone={oldest >= 24 ? "danger" : "warn"}
          title={`${plural(waiting.length, "order")} waiting, worth ${money(value)}`}
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
          { label: "Waiting", value: String(waiting.length), tone: waiting.length ? "warn" : undefined },
          { label: "Value waiting", value: money(value) },
          {
            label: "Over the limit",
            value: String(overLimit.length),
            sub: overLimit.length ? "these are the hard ones" : undefined,
            tone: overLimit.length ? "danger" : undefined,
          },
          { label: "Taken in the field", value: String(all.length), sub: "all time" },
        ]}
      />

      <FilterChips
        current={show}
                options={[
          { key: "waiting", href: `/sales/orders?show=waiting`, label: "Waiting", count: waiting.length },
          { key: "overlimit", href: `/sales/orders?show=overlimit`, label: "Over the limit", count: overLimit.length },
          { key: "all", href: `/sales/orders?show=all`, label: "Everything", count: all.length },
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
        <Table
          minWidth={1240}
          head={
            <>
              <HeadCell width={170}>Order</HeadCell>
              <HeadCell width={160}>Salesman</HeadCell>
              <HeadCell width={210}>Customer</HeadCell>
              <HeadCell align="right" width={140}>Value</HeadCell>
              <HeadCell align="right" width={150}>Their limit</HeadCell>
              <HeadCell align="right" width={100}>Cans</HeadCell>
              <HeadCell width={110}>Terms</HeadCell>
              <HeadCell>State</HeadCell>
            </>
          }
        >
          {rows.map((o, i) => {
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
                      className="no-underline hover:underline"
                    >
                      {o.salesmanName}
                    </Link>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell truncate={210}>{o.customerName}</Cell>
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
      )}
    </div>
  );
}
