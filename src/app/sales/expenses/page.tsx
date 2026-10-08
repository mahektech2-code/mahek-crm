import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import { today } from "@/lib/recompute";
import { endOfMonth } from "@/lib/business-date";
import { MonthNav } from "@/components/ui/month-nav";
import {
  claimDays,
  unsentClaimDays,
  type UnsentClaimDayRow,
} from "@/lib/services/expense-claims-service";
import { canDecideExpenses } from "@/lib/actions/expenses";
import { DecideDay } from "./decide-day";
import {
  Banner,
  Cell,
  Empty,
  EntityLink,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  SortHead,
  Table,
} from "@/components/console/parts";
import { readSort, sortHref, sortRows, type SortColumns } from "@/components/console/sort";
import { plural } from "@/components/console/words";

export const metadata = { title: "Expenses — Sales Dashboard — MahekOne" };

const km = (metres: number) => `${(metres / 1000).toFixed(0)} km`;

/**
 * What the field spent, and what it is owed back — one row a day.
 *
 * A DAY is the unit: it is what is sent, locked and decided. "Asked for" is
 * what he claimed and "Policy allows" what the hard-coded policy pays; the
 * manager approves the second by default and may change it. Being over the
 * policy never stops a claim being recorded — the money was already spent.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; month?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : now.slice(0, 7);
  const from = `${month}-01`;
  const to = endOfMonth(month);

  const [all, unsent, canDecide] = await Promise.all([
    claimDays({ from, to }),
    unsentClaimDays({ from, to }),
    canDecideExpenses(),
  ]);

  const show = ["all", "waiting", "decided", "unsent"].includes(params.show ?? "")
    ? params.show!
    : "waiting";

  const waiting = all.filter((d) => !d.approvalState || d.approvalState === "pending");
  const decided = all.filter((d) => d.approvalState && d.approvalState !== "pending");
  const rows = show === "all" ? all : show === "decided" ? decided : waiting;

  const owed = waiting.reduce((n, d) => n + Number(d.eligiblePaise), 0);
  const approvedTotal = decided.reduce((n, d) => n + Number(d.approvedAmountPaise ?? 0), 0);

  /* Sorting is DISPLAY ONLY, over the rows the chip has already cut, so the
     figures above never move when somebody clicks a column. The chip and the
     month ride on every header link — a sort that dropped the month would
     look like March's claims had vanished. */
  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(rows, sort, COLUMNS);
  const head = (key: string, text: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/expenses", sort, key, `show=${show}&month=${month}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {text}
    </SortHead>
  );

  return (
    <div className="p-6">
      <ScreenHeader
        title="Expenses"
        subtitle="Each day a salesman sends is worked out against the expense policy. Approve it, or change the amount."
        actions={
          <div className="flex items-center gap-3">
            <Link href="/sales/expense-policy" className="text-sm font-medium">
              The policy
            </Link>
            <MonthNav month={month} basePath="/sales/expenses" />
          </div>
        }
      />

      <MetricRow
        metrics={[
          {
            label: "Days to approve",
            value: String(waiting.length),
            tone: waiting.length ? "warn" : undefined,
          },
          { label: "Policy allows", value: money(owed), sub: "on the days to approve" },
          { label: "Approved this month", value: money(approvedTotal) },
          {
            label: "Not sent yet",
            value: String(unsent.length),
            sub: unsent.length ? "the salesman has to close the day" : undefined,
          },
        ]}
      />

      <FilterChips
        current={show}
        options={[
          { key: "waiting", href: `/sales/expenses?show=waiting&month=${month}`, label: "To approve", count: waiting.length },
          { key: "decided", href: `/sales/expenses?show=decided&month=${month}`, label: "Done", count: decided.length },
          { key: "all", href: `/sales/expenses?show=all&month=${month}`, label: "All", count: all.length },
          { key: "unsent", href: `/sales/expenses?show=unsent&month=${month}`, label: "Not sent yet", count: unsent.length },
        ]}
      />

      {show === "unsent" ? (
        <UnsentDays rows={unsent} />
      ) : rows.length === 0 ? (
        <Empty
          title={show === "waiting" ? "Nothing to approve" : "No days sent this month"}
          body="A salesman closes his day on his phone. The day arrives here already worked out against the policy."
        />
      ) : (
        <Table
          minWidth={1080}
          head={
            <>
              {head("name", "Salesman", 180)}
              {head("day", "Day", 110)}
              <HeadCell width={220}>Spent on</HeadCell>
              {head("claimed", "Asked for", 120, "right")}
              {head("eligible", "Policy allows", 130, "right")}
              <HeadCell width={170}>Status</HeadCell>
              <HeadCell align="right" width={150} />
            </>
          }
        >
          {sorted.map((d, i) => {
            const claimed = Number(d.claimedPaise);
            const eligible = Number(d.eligiblePaise);
            const over = Math.max(0, claimed - eligible);
            const pending = !d.approvalState || d.approvalState === "pending";
            return (
              <Row key={d.dayId} striped={i % 2 === 1}>
                <Cell truncate={180}>
                  <EntityLink href={`/sales/people/${d.userId}`}>{d.userName}</EntityLink>
                </Cell>
                <Cell>{shortDate(d.day)}</Cell>
                <Cell>
                  <span className="text-[13px] text-body">{spentOn(d)}</span>
                </Cell>
                <Cell align="right">{money(claimed)}</Cell>
                <Cell align="right">
                  {money(eligible)}
                  {over > 0 ? (
                    <span className="block text-[12px] text-warn-ink">{money(over)} over</span>
                  ) : null}
                </Cell>
                <Cell>
                  <Status
                    state={d.approvalState}
                    approvedPaise={d.approvedAmountPaise === null ? null : Number(d.approvedAmountPaise)}
                    auto={d.routeReason === "auto"}
                  />
                  {pending && d.openExceptions > 0 ? (
                    <Link href="/sales/exceptions" className="mt-1 block text-[12px] text-warn-ink">
                      {plural(d.openExceptions, "thing")} to check
                    </Link>
                  ) : null}
                  {d.decisionNote ? (
                    <span className="block truncate text-[12px] text-muted" title={d.decisionNote}>
                      “{d.decisionNote}”
                    </span>
                  ) : null}
                </Cell>
                <Cell align="right">
                  {canDecide && (pending || d.lockedAt) ? (
                    <DecideDay
                      dayId={d.dayId}
                      who={d.userName}
                      what={shortDate(d.day)}
                      claimedPaise={claimed}
                      eligiblePaise={eligible}
                      locked={d.lockedAt !== null}
                      pending={pending}
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

/** One line saying what the day's money went on. */
function spentOn(d: {
  legCount: number;
  metres: number | string;
  foodPaise: number | string;
  lodgingPaise: number | string;
  otherPaise: number | string;
}): string {
  return (
    [
      d.legCount ? `Travel ${km(Number(d.metres))}` : null,
      Number(d.foodPaise) ? `Meals ${money(Number(d.foodPaise))}` : null,
      Number(d.lodgingPaise) ? `Hotel ${money(Number(d.lodgingPaise))}` : null,
      Number(d.otherPaise) ? `Bills ${money(Number(d.otherPaise))}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Nothing recorded"
  );
}

function Status({
  state,
  approvedPaise,
  auto,
}: {
  state: string | null;
  approvedPaise: number | null;
  auto: boolean;
}) {
  if (state === "approved") {
    return (
      <>
        <Pill tone="success">Approved</Pill>
        <span className="block text-[12px] text-muted">
          {approvedPaise !== null ? money(approvedPaise) : null}
          {auto ? " · automatically" : ""}
        </span>
      </>
    );
  }
  if (state === "partially_approved") {
    return (
      <>
        <Pill tone="warn">Part approved</Pill>
        {approvedPaise !== null ? (
          <span className="block text-[12px] text-muted">{money(approvedPaise)}</span>
        ) : null}
      </>
    );
  }
  if (state === "rejected") return <Pill tone="danger">Refused</Pill>;
  return <Pill tone="warn">To approve</Pill>;
}

/**
 * What each sortable column is worth.
 *
 * Every money figure is read through `Number` for the reason the cells are:
 * these come off a raw `db.execute`, so a paise column arrives as a string
 * whatever the row type says, and comparing "9000" against "10000" as text
 * would put the larger claim underneath the smaller one.
 *
 * APPROVED is null until somebody has decided, and a day nobody has decided is
 * not a day approved for nothing — so it answers null and sorts last in either
 * direction rather than sitting at the bottom of the descending pass as a
 * zero. The two columns beside it are what a waiting day is read by.
 *
 * The day is compared as its own `YYYY-MM-DD` text rather than parsed: the
 * spelling sorts correctly on its own and every row here is inside one month,
 * so there is nothing a timestamp would settle that the string does not.
 */
const COLUMNS: SortColumns<{
  userName: string;
  day: string;
  claimedPaise: number;
  eligiblePaise: number;
  approvedAmountPaise: number | null;
  monthToDatePaise: number;
}> = {
  name: (d) => d.userName,
  day: (d) => d.day,
  claimed: (d) => Number(d.claimedPaise),
  eligible: (d) => Number(d.eligiblePaise),
  approved: (d) => (d.approvedAmountPaise === null ? null : Number(d.approvedAmountPaise)),
  monthToDate: (d) => Number(d.monthToDatePaise),
};

/**
 * Claims raised on the phone whose day was never closed.
 *
 * Read-only on purpose: nothing here has been priced against the policy or
 * locked, so there is no Eligible to show and no day to decide. What the row
 * owes the reader is WHO has to act — the salesman — and the one thing stopping
 * him, which is usually that he never said when he got back.
 */
function UnsentDays({ rows }: { rows: UnsentClaimDayRow[] }) {
  if (!rows.length) {
    return (
      <Empty
        title="Nothing waiting on a salesman"
        body="Every claim raised this month belongs to a day that has been closed and sent."
      />
    );
  }
  return (
    <>
      <Banner
        tone="info"
        title="Claims raised, day not closed"
        body="These claims reached us, but the salesman has not closed the day on his phone (More → Close the day), so they cannot be approved yet."
      />
      <Table
        minWidth={960}
        head={
          <>
            <HeadCell width={190}>Salesman</HeadCell>
            <HeadCell width={110}>Day</HeadCell>
            <HeadCell width={220}>What is on it</HeadCell>
            <HeadCell align="right" width={130}>Claimed</HeadCell>
            <HeadCell width={260}>What is holding it</HeadCell>
          </>
        }
      >
        {rows.map((d, i) => (
          <Row key={`${d.userId}:${d.day}`} striped={i % 2 === 1}>
            <Cell truncate={190}>
              <EntityLink href={`/sales/people/${d.userId}`}>{d.userName}</EntityLink>
            </Cell>
            <Cell>{shortDate(d.day)}</Cell>
            <Cell>
              <span className="text-[12px] text-muted">
                {[
                  d.lineCount ? plural(Number(d.lineCount), "claim") : null,
                  d.legCount
                    ? `${plural(Number(d.legCount), "leg")}, ${km(Number(d.metres))}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </Cell>
            <Cell align="right">{money(Number(d.claimedPaise))}</Cell>
            <Cell>
              <Pill tone="warn">Day not closed</Pill>
              <span className="block text-[12px] text-muted">
                {d.returnedAt
                  ? "Waiting for him to send the day"
                  : "He has not said when he got back"}
              </span>
            </Cell>
          </Row>
        ))}
      </Table>
    </>
  );
}
