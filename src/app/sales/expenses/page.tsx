import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import { today } from "@/lib/recompute";
import { endOfMonth } from "@/lib/business-date";
import { MonthNav } from "@/components/ui/month-nav";
import { claimDays } from "@/lib/services/expense-claims-service";
import { canDecideExpenses } from "@/lib/actions/expenses";
import { DecideDay } from "./decide-day";
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
import { plural } from "../words";

export const metadata = { title: "Expenses & claims — Sales Dashboard — MahekOne" };

const km = (metres: number) => `${(metres / 1000).toFixed(0)} km`;

/**
 * What the field spent, and what it is owed back.
 *
 * **Claimed, Eligible and Approved are three columns, always** — requirement
 * 41 — because they are three different numbers and a screen showing one of
 * them makes the other two unanswerable. Claimed is what the salesman asked
 * for; Eligible is what the policy in force on that date allows; Approved is
 * what a person decided. Where they differ, the difference is the whole story.
 *
 * **The unit is a DAY, not a line.** A day is what is submitted, what is
 * locked, and what `mbos_approvals` names. Deciding line by line is exactly
 * what requirement 45 exists to prevent — a manager asked to approve forty ₹40
 * fares reads none of them, and then the one that mattered goes through with
 * the rest.
 *
 * **Exceeding policy does not block a claim** and never did on the handset
 * either. The salesman spent the money; refusing to record it does not unspend
 * it, it only means nobody finds out. What being over does is put the day in
 * front of somebody.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; month?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : now.slice(0, 7);
  const from = `${month}-01`;
  const to = endOfMonth(month);

  const [all, canDecide] = await Promise.all([
    claimDays({ from, to }),
    canDecideExpenses(),
  ]);

  const show = ["all", "waiting", "decided"].includes(params.show ?? "")
    ? params.show!
    : "waiting";

  const waiting = all.filter((d) => !d.approvalState || d.approvalState === "pending");
  const decided = all.filter((d) => d.approvalState && d.approvalState !== "pending");
  const rows = show === "all" ? all : show === "decided" ? decided : waiting;

  const owed = waiting.reduce((n, d) => n + Number(d.eligiblePaise), 0);
  const overPolicy = all.filter((d) => Number(d.excessPaise) > 0);
  const autoApproved = decided.filter((d) => d.routeReason === "auto");
  const escalated = all.filter((d) => d.stepCount > 1);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Expenses and claims"
        subtitle="Claimed is what he asked for, Eligible is what the policy in force that day allows, Approved is what you decided. Being over policy never stopped a claim being recorded — the money was already spent, and refusing to write it down would only mean nobody found out."
        actions={<MonthNav month={month} basePath="/sales/expenses" />}
      />

      {escalated.length ? (
        <Banner
          tone="warn"
          title={`${plural(escalated.length, "day")} escalated to the owner as well as to you`}
          body="An escalation is in addition to your decision, never instead of it — you are the person who knows whether that salesman was where he says he was."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Waiting", value: String(waiting.length), tone: waiting.length ? "warn" : undefined },
          { label: "Eligible, waiting", value: money(owed) },
          {
            label: "Over policy",
            value: String(overPolicy.length),
            sub: overPolicy.length ? money(overPolicy.reduce((n, d) => n + Number(d.excessPaise), 0)) + " above" : undefined,
            tone: overPolicy.length ? "warn" : undefined,
          },
          {
            label: "Approved automatically",
            value: String(autoApproved.length),
            sub: "clean, and under the limit",
          },
        ]}
      />

      <FilterChips
        current={show}
        options={[
          { key: "waiting", href: `/sales/expenses?show=waiting&month=${month}`, label: "Waiting", count: waiting.length },
          { key: "decided", href: `/sales/expenses?show=decided&month=${month}`, label: "Decided", count: decided.length },
          { key: "all", href: `/sales/expenses?show=all&month=${month}`, label: "Everything", count: all.length },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title={show === "waiting" ? "Nothing to decide" : "No days submitted"}
          body="A salesman closes his day on the handset: the meals are worked out from when he left and got back, the travel from the legs he recorded, and the whole day is priced against the policy in force that date before it reaches you."
        />
      ) : (
        <Table
          minWidth={1500}
          head={
            <>
              <HeadCell width={170}>Salesman</HeadCell>
              <HeadCell width={110}>Day</HeadCell>
              <HeadCell width={190}>What it was made of</HeadCell>
              <HeadCell align="right" width={120}>Claimed</HeadCell>
              <HeadCell align="right" width={120}>Eligible</HeadCell>
              <HeadCell align="right" width={130}>Approved</HeadCell>
              <HeadCell width={180}>This month</HeadCell>
              <HeadCell width={190}>State</HeadCell>
              <HeadCell align="right" width={200} />
            </>
          }
        >
          {rows.map((d, i) => {
            const excess = Number(d.excessPaise);
            const pending = !d.approvalState || d.approvalState === "pending";
            return (
              <Row key={d.dayId} striped={i % 2 === 1}>
                <Cell truncate={170}>
                  <Link href={`/sales/people/${d.userId}`} className="font-medium text-ink no-underline">
                    {d.userName}
                  </Link>
                </Cell>
                <Cell>
                  {shortDate(d.day)}
                  {d.reopenedAt ? (
                    <span className="block text-[12px] text-warn-ink">reopened</span>
                  ) : null}
                </Cell>
                <Cell>
                  <span className="text-[12px] text-muted">
                    {[
                      d.legCount ? `${d.legCount} leg${d.legCount === 1 ? "" : "s"}, ${km(Number(d.metres))}` : null,
                      Number(d.foodPaise) ? `food ${money(Number(d.foodPaise))}` : null,
                      Number(d.lodgingPaise) ? `hotel ${money(Number(d.lodgingPaise))}` : null,
                      Number(d.otherPaise) ? `other ${money(Number(d.otherPaise))}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "nothing recorded"}
                  </span>
                </Cell>
                <Cell align="right">{money(Number(d.claimedPaise))}</Cell>
                <Cell align="right">
                  {money(Number(d.eligiblePaise))}
                  {excess > 0 ? (
                    <span className="block text-[12px] text-warn-ink">
                      {money(excess)} over
                    </span>
                  ) : null}
                </Cell>
                <Cell align="right">
                  {d.approvedAmountPaise === null ? (
                    <span className="text-muted">—</span>
                  ) : (
                    money(Number(d.approvedAmountPaise))
                  )}
                </Cell>
                <Cell>
                  {money(Number(d.monthToDatePaise))}
                  <span className="block text-[12px] text-muted">claimed to date</span>
                </Cell>
                <Cell>
                  {d.approvalState === "approved" ? (
                    <Pill tone="success">Approved</Pill>
                  ) : d.approvalState === "rejected" ? (
                    <Pill tone="danger">Refused</Pill>
                  ) : d.approvalState === "partially_approved" ? (
                    <Pill tone="warn">Part allowed</Pill>
                  ) : (
                    <Pill tone="warn">Waiting</Pill>
                  )}
                  {d.openExceptions > 0 ? (
                    <Link href="/sales/exceptions" className="ml-1.5 no-underline">
                      <Pill tone={d.worstSeverity === "block_route" ? "danger" : "warn"}>
                        {d.openExceptions} flagged
                      </Pill>
                    </Link>
                  ) : null}
                  {d.routeReason === "auto" ? (
                    <span className="block text-[12px] text-muted">
                      approved on submission — within policy and under the limit
                    </span>
                  ) : null}
                  {d.decisionNote ? (
                    <span className="block truncate text-[12px] text-muted" title={d.decisionNote}>
                      “{d.decisionNote}” {d.decidedByName ? `— ${d.decidedByName}` : ""}
                    </span>
                  ) : null}
                  {d.submittedAt ? (
                    <span className="block text-[12px] text-muted">
                      submitted {stamp(d.submittedAt)}
                    </span>
                  ) : null}
                </Cell>
                <Cell align="right">
                  {canDecide && (pending || d.lockedAt) ? (
                    <DecideDay
                      dayId={d.dayId}
                      who={d.userName}
                      what={shortDate(d.day)}
                      claimedPaise={Number(d.claimedPaise)}
                      eligiblePaise={Number(d.eligiblePaise)}
                      locked={d.lockedAt !== null}
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
