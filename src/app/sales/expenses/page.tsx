import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import { getConfig } from "@/lib/config/store";
import { expenseClaims } from "@/lib/services/sales-service";
import { Decide } from "../decide";
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
} from "../words";

export const metadata = { title: "Expenses & claims — Sales Dashboard — MahekOne" };

/**
 * What the field spent, and what it is owed back.
 *
 * The month-to-date column is what makes a cap mean anything: ₹1,840 of fuel
 * is unremarkable on its own, and is the fourth such claim this month against
 * a ₹6,000 cap. Without it a manager is approving each claim blind to the
 * pattern, which is the only thing a cap was ever about.
 *
 * **Exceeding a cap does not block the claim**, and it did not block it on the
 * handset either. The salesman spent the money; refusing to record it does not
 * unspend it, it just means nobody finds out. What the cap does is put the
 * claim in front of somebody.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const params = await searchParams;
  const [all, config] = await Promise.all([expenseClaims(), getConfig()]);

  /* The category is a string off the wire and the caps are keyed by the enum.
     Read through a lookup rather than casting the row: a category the caps do
     not name has no cap, which is a real state and not an error. */
  const rawCaps: Record<string, number> = config["mbos.expenses.categoryCapsPaise"];
  const capFor = (category: string): number | undefined => rawCaps[category];
  const billThreshold = config["mbos.expenses.billPhotoThresholdPaise"];

  const show = ["all", "waiting", "decided"].includes(params.show ?? "")
    ? params.show!
    : "waiting";

  const waiting = all.filter((e) => !e.approvalState || e.approvalState === "pending");
  const decided = all.filter((e) => e.approvalState && e.approvalState !== "pending");
  const rows = show === "all" ? all : show === "decided" ? decided : waiting;

  const owed = waiting.reduce((n, e) => n + Number(e.amountPaise), 0);
  const overCap = waiting.filter((e) => {
    const cap = capFor(e.category);
    return cap != null && Number(e.monthToDatePaise) > cap;
  });
  const noBill = waiting.filter(
    (e) => !e.billPhotoId && Number(e.amountPaise) >= billThreshold,
  );

  return (
    <div className="p-6">
      <ScreenHeader
        title="Expenses and claims"
        subtitle="What the field spent and what it is owed back. Exceeding a cap does not block a claim — the salesman spent the money, and refusing to record it does not unspend it. The cap puts it in front of you."
      />

      {noBill.length ? (
        <Banner
          tone="warn"
          title={`${plural(noBill.length, "claim")} above ${money(billThreshold)} with no bill attached`}
          body={noBill
            .map((e) => `${e.salesmanName} — ${e.category}, ${money(e.amountPaise)}`)
            .join(" · ")}
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Waiting", value: String(waiting.length), tone: waiting.length ? "warn" : undefined },
          { label: "Owed back", value: money(owed) },
          {
            label: "Over a cap",
            value: String(overCap.length),
            sub: overCap.length ? "month to date" : undefined,
            tone: overCap.length ? "warn" : undefined,
          },
          { label: "Decided", value: String(decided.length) },
        ]}
      />

      <FilterChips
        current={show}
                options={[
          { key: "waiting", href: `/sales/expenses?show=waiting`, label: "Waiting", count: waiting.length },
          { key: "decided", href: `/sales/expenses?show=decided`, label: "Decided", count: decided.length },
          { key: "all", href: `/sales/expenses?show=all`, label: "Everything", count: all.length },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title={show === "waiting" ? "Nothing to decide" : "No claims"}
          body="Expenses are claimed on the handset, with the bill photographed above the configured threshold. A claim reaches the office on the next sync."
        />
      ) : (
        <Table
          minWidth={1200}
          head={
            <>
              <HeadCell width={190}>Salesman</HeadCell>
              <HeadCell width={140}>Category</HeadCell>
              <HeadCell align="right" width={130}>Amount</HeadCell>
              <HeadCell width={200}>This month</HeadCell>
              <HeadCell width={120}>Spent on</HeadCell>
              <HeadCell>Remarks</HeadCell>
              <HeadCell width={160}>State</HeadCell>
              <HeadCell align="right" width={250} />
            </>
          }
        >
          {rows.map((e, i) => {
            const cap = capFor(e.category);
            const over = cap != null && Number(e.monthToDatePaise) > cap;
            return (
              <Row key={e.id} striped={i % 2 === 1}>
                <Cell truncate={190}>
                  <Link
                    href={`/sales/people/${e.salesmanId}`}
                    className="font-medium text-ink no-underline hover:underline"
                  >
                    {e.salesmanName}
                  </Link>
                </Cell>
                <Cell className="capitalize">{e.category}</Cell>
                <Cell align="right">
                  {money(e.amountPaise)}
                  {e.approvedAmountPaise != null &&
                  e.approvedAmountPaise !== e.amountPaise ? (
                    <span className="block text-[12px] text-warn-ink">
                      {money(e.approvedAmountPaise)} allowed
                    </span>
                  ) : null}
                </Cell>
                <Cell>
                  <span className={over ? "text-warn-ink" : undefined}>
                    {money(e.monthToDatePaise)}
                  </span>
                  {cap != null ? (
                    <span className="text-muted"> of {money(cap)}</span>
                  ) : (
                    <span className="text-muted"> · no cap set</span>
                  )}
                </Cell>
                <Cell>{shortDate(e.expenseDate)}</Cell>
                <Cell truncate={300}>
                  {e.remarks ?? <span className="text-muted">Nothing written</span>}
                  {e.decisionNote ? (
                    <span className="block truncate text-[12px] text-muted">
                      “{e.decisionNote}”
                    </span>
                  ) : null}
                </Cell>
                <Cell>
                  {e.approvalState === "approved" ? (
                    <Pill tone="success">Approved</Pill>
                  ) : e.approvalState === "rejected" ? (
                    <Pill tone="danger">Refused</Pill>
                  ) : e.approvalState === "partially_approved" ? (
                    <Pill tone="warn">Part</Pill>
                  ) : (
                    <Pill tone="warn">Waiting</Pill>
                  )}
                  {!e.billPhotoId && Number(e.amountPaise) >= billThreshold ? (
                    <span className="ml-1.5" title={`A claim above ${money(billThreshold)} needs the bill photographed.`}>
                      <Pill tone="danger">No bill</Pill>
                    </span>
                  ) : null}
                </Cell>
                <Cell align="right">
                  {!e.approvalState || e.approvalState === "pending" ? (
                    <Decide
                      approvalId={e.approvalId}
                      who={e.salesmanName}
                      what={`${e.category} — ${money(e.amountPaise)} on ${shortDate(e.expenseDate)}`}
                      amountPaise={e.amountPaise}
                    />
                  ) : null}
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}
    </div>
  );
}
