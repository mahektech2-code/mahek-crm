import Link from "next/link";
import { shortDate } from "@/lib/format";
import { leaveRequests } from "@/lib/services/sales-service";
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
  LEAVE_LABEL,
  label,
  plural,
} from "../words";

export const metadata = { title: "Leave — Sales Dashboard — MahekOne" };

/**
 * Leave asked for, and what stands in the way of saying yes.
 *
 * The clash column is the design's idea and the reason this is a screen rather
 * than a queue: two salesmen off in the same week leaves those shops unworked,
 * and the manager approving the second request usually cannot see the first.
 * It is computed at read time, because it is a question about the state of the
 * calendar at the moment somebody looks at it.
 *
 * Deciding happens in the approvals queue, which is where every kind of
 * request is answered with the same rules — a refusal needs a reason, and a
 * decision is made once. This screen is the calendar around that decision.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const params = await searchParams;
  const all = await leaveRequests();

  const show = ["all", "waiting", "approved"].includes(params.show ?? "")
    ? params.show!
    : "waiting";

  const live = all.filter((l) => !l.cancelledAt);
  const waiting = live.filter((l) => !l.approvalState || l.approvalState === "pending");
  const approved = live.filter((l) => l.approvalState === "approved");
  const rows = show === "all" ? all : show === "approved" ? approved : waiting;

  const clashes = waiting.filter((l) => l.clashesWith);
  const days = waiting.reduce((n, l) => n + Number(l.days), 0);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Leave"
        subtitle="Who has asked for time off, and who else is already off on those days. Two salesmen away in one week leaves those shops unworked — that is the thing a calendar can tell you and a queue cannot."
      />

      {clashes.length ? (
        <Banner
          tone="warn"
          title={`${plural(clashes.length, "request")} overlaps somebody else's leave`}
          body={clashes
            .map((c) => `${c.salesmanName} (${shortDate(c.fromDate)}) with ${c.clashesWith}`)
            .join(" · ")}
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Waiting", value: String(waiting.length), tone: waiting.length ? "warn" : undefined },
          { label: "Days asked for", value: String(days) },
          {
            label: "Overlapping",
            value: String(clashes.length),
            tone: clashes.length ? "warn" : undefined,
          },
          { label: "Approved", value: String(approved.length), tone: "success" },
        ]}
      />

      <FilterChips
        current={show}
                options={[
          { key: "waiting", href: `/sales/leave?show=waiting`, label: "Waiting", count: waiting.length },
          { key: "approved", href: `/sales/leave?show=approved`, label: "Approved", count: approved.length },
          { key: "all", href: `/sales/leave?show=all`, label: "Everything", count: all.length },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title={show === "waiting" ? "Nothing to decide" : "No leave recorded"}
          body="Leave is asked for on the handset. A request reaches the office on the next sync, and the balance the salesman was shown when he asked is stored on the request so a later recompute cannot rewrite what he was told."
        />
      ) : (
        <Table
          minWidth={1180}
          head={
            <>
              <HeadCell width={190}>Salesman</HeadCell>
              <HeadCell width={140}>Kind</HeadCell>
              <HeadCell width={210}>When</HeadCell>
              <HeadCell align="right" width={90}>Days</HeadCell>
              <HeadCell>Why</HeadCell>
              <HeadCell width={200}>Also off</HeadCell>
              <HeadCell width={150}>State</HeadCell>
              <HeadCell align="right" width={230} />
            </>
          }
        >
          {rows.map((l, i) => (
            <Row key={l.id} striped={i % 2 === 1}>
              <Cell truncate={190}>
                <Link
                  href={`/sales/people/${l.salesmanId}`}
                  className="font-medium text-ink no-underline hover:underline"
                >
                  {l.salesmanName}
                </Link>
              </Cell>
              <Cell>{label(LEAVE_LABEL, l.leaveType)}</Cell>
              <Cell>
                {shortDate(l.fromDate)}
                {l.toDate !== l.fromDate ? ` – ${shortDate(l.toDate)}` : ""}
                {l.halfDay ? (
                  <span className="block text-[12px] text-muted">half day</span>
                ) : null}
              </Cell>
              <Cell align="right">{l.days}</Cell>
              <Cell truncate={320}>
                {l.reason ?? <span className="text-muted">No reason given</span>}
                {l.decisionNote ? (
                  <span className="block truncate text-[12px] text-muted">
                    {l.approverName ? `${l.approverName}: ` : ""}“{l.decisionNote}”
                  </span>
                ) : null}
              </Cell>
              <Cell truncate={200}>
                {l.clashesWith ? (
                  <span className="text-warn-ink">{l.clashesWith}</span>
                ) : (
                  <span className="text-muted">Nobody</span>
                )}
              </Cell>
              <Cell>
                {l.cancelledAt ? (
                  <Pill>Withdrawn</Pill>
                ) : l.approvalState === "approved" ? (
                  <Pill tone="success">Approved</Pill>
                ) : l.approvalState === "rejected" ? (
                  <Pill tone="danger">Refused</Pill>
                ) : (
                  <Pill tone="warn">Waiting</Pill>
                )}
              </Cell>
              <Cell align="right">
                {!l.cancelledAt && (!l.approvalState || l.approvalState === "pending") ? (
                  <Decide
                    approvalId={l.approvalId}
                    who={l.salesmanName}
                    what={`${label(LEAVE_LABEL, l.leaveType)}, ${shortDate(l.fromDate)}${
                      l.toDate !== l.fromDate ? ` – ${shortDate(l.toDate)}` : ""
                    }`}
                  />
                ) : null}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}
