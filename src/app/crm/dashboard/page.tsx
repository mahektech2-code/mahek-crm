import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { currentPeriod, dayActivity, teamDay, today } from "@/lib/queries";
import { APP_TIMEZONE } from "@/lib/business-date";
import { getQueue } from "@/lib/services/queue-service";
import { getFollowUpWorklist } from "@/lib/services/payment-service";
import { listInactiveWatch, listTargets } from "@/lib/services/worklist-services";
import { getConfig } from "@/lib/config/store";
import { isWorkingDay, previousWorkingDay } from "@/lib/business-date";
import { money, moneyShort, monthLabel, pct } from "@/lib/format";
import {
  Card,
  CardHeader,
  PageHeader,
  Progress,
  SectionLabel,
  Th,
  Td,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Icon } from "@/components/shell/icons";
import { DayStages } from "./day-stages";

export const metadata = { title: "Dashboard - MahekOne CRM" };

export default async function DashboardPage() {
  const user = await requireUser();
  const scope = await getScope(user);
  const manager = isManager(user);
  const teamView = manager && scope === "team";
  const day = await today();
  const period = await currentPeriod();
  const config = await getConfig();

  // One wave, not three. Each of these is a round trip to a database in another
  // continent, so waiting on them in sequence shows up directly as page load.
  const previousDay = previousWorkingDay(day, {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  });

  const [activity, yesterday, queue, followUps, inactive, targets, counts, team, over60, teamActivity] =
    await Promise.all([
      dayActivity(teamView ? null : user.id, day),
      // The last working day, so Monday compares against Saturday.
      dayActivity(teamView ? null : user.id, previousDay),
      getQueue(),
      getFollowUpWorklist(),
      listInactiveWatch(),
      listTargets(period),
      dashboardCounts(teamView ? null : user.id, day, {
        reminders: config["dashboard.reminderOverdueFlagDays"],
        complaints: config["dashboard.complaintUnresolvedFlagDays"],
      }),
      teamView ? teamDay(day) : Promise.resolve([]),
      teamView ? overSixtyDays() : Promise.resolve(0),
      // The team's own day, so a telecaller's connect rate has something to sit
      // beside. A rate with nothing to compare it to tells nobody anything.
      teamView ? Promise.resolve(null) : dayActivity(null, day),
    ]);

  const { dueReminders, overdueReminders, openComplaints } = counts;

  const targetTotal = targets.reduce((a, t) => a + t.target, 0);
  const achieved = targets.reduce((a, t) => a + t.achieved, 0);
  const targetPct = pct(achieved, targetTotal);

  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: APP_TIMEZONE,
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
  );
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const needs = [
    {
      href: "/crm/reminders",
      title: "Reminders due today",
      sub: overdueReminders
        ? `${overdueReminders} of them are already overdue`
        : "Promises you made on earlier calls",
      count: dueReminders,
      tone: overdueReminders ? "danger" : "warn",
    },
    {
      href: "/crm/payments",
      title: "Payment follow-ups open",
      sub: `${money(followUps.reduce((a, f) => a + f.totalOverdue, 0))} collectable`,
      count: followUps.length,
      tone: "warn",
    },
    {
      href: "/crm/complaints",
      title: "Complaints unresolved",
      sub: "Mention these before anything else on the call",
      count: openComplaints,
      tone: "danger",
    },
    {
      href: "/crm/inactive",
      title: "Customers gone quiet",
      sub: `${moneyShort(inactive.reduce((a, i) => a + i.valueAtRisk, 0))} of business at risk`,
      count: inactive.length,
      tone: "muted",
    },
    {
      href: "/crm/call-log",
      title: "Queue still to work",
      sub: "Worked top to bottom, most urgent first",
      count: queue.entries.length,
      tone: "brand",
    },
  ] as const;

  return (
    <div className="max-w-[1440px] px-6 pt-6 pb-10">
      <PageHeader
        title={teamView ? "Team overview" : `${greeting}, ${user.name.split(" ")[0]}`}
        subtitle={`${scopeLabel(scope, user)} · ${
          teamView
            ? "Yesterday's comparison and today's red flags"
            : "Everything below is live - the numbers open the records behind them"
        }`}
        actions={
          <Link
            href="/crm/call-log"
            className="inline-flex h-9 items-center gap-2 rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white no-underline hover:border-brand-hover hover:bg-brand-hover hover:no-underline"
          >
            <Icon name="phone" size={16} />
            Start calling
          </Link>
        }
      />

      <DayStages
        worked={queue.progress.worked}
        total={queue.progress.total}
        dueReminders={dueReminders}
        followUps={followUps.length}
        complaints={openComplaints}
      />

      {teamView ? (
        <TeamView
          activity={activity}
          yesterday={yesterday}
          remindersFlagged={counts.remindersFlagged}
          complaintsFlagged={counts.complaintsFlagged}
          overdueGrowth={counts.overdueGrowth}
          flagDays={{
            reminders: config["dashboard.reminderOverdueFlagDays"],
            complaints: config["dashboard.complaintUnresolvedFlagDays"],
          }}
          outstanding={followUps.reduce((a, f) => a + f.totalOverdue, 0)}
          targetPct={targetPct}
          rows={team}
          over60={over60}
        />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(216px,1fr))] gap-4">
            <StatCard
              href="/crm/call-log"
              label="Calling progress"
              value={`${queue.progress.worked}`}
              suffix={`/${queue.progress.total}`}
              foot={`${queue.entries.length} still to work`}
              progress={queue.progress.percent}
              delta={
                <Delta
                  today={queue.progress.worked}
                  yesterday={yesterday.queueWorked}
                  suffix="ahead of yesterday"
                />
              }
            />
            <StatCard
              href="/crm/history"
              label="Calls connected"
              value={String(activity.callsConnected)}
              foot={`of ${activity.callsAttempted} placed${
                activity.callsInbound
                  ? ` · ${activity.callsInbound} inbound received separately`
                  : ""
              }`}
              foot2={`${activity.connectRate}% connect rate`}
              foot3={
                teamActivity ? `team ${teamActivity.connectRate}%` : undefined
              }
              delta={
                <Delta
                  today={activity.callsConnected}
                  yesterday={yesterday.callsConnected}
                />
              }
            />
            {/* "Orders taken" is the telecaller's own work, so it counts what
                they took — not what accounts have got round to approving. The
                value underneath is the approved figure, because only an
                approved order is money. */}
            <StatCard
              href="/crm/history"
              label="Orders taken"
              value={String(activity.ordersCaptured)}
              foot={
                activity.ordersCaptured > activity.ordersCount
                  ? `${activity.ordersCaptured - activity.ordersCount} awaiting approval`
                  : `${money(activity.ordersValue)} booked today`
              }
              foot2={
                activity.ordersCaptured
                  ? `${money(activity.ordersValue)} approved so far`
                  : "No orders yet today"
              }
              delta={
                <Delta today={activity.ordersCaptured} yesterday={yesterday.ordersCaptured} />
              }
            />
            <StatCard
              href="/crm/history"
              label="Missed calls"
              value={String(activity.callsMissed)}
              tone="danger"
              foot="Not reachable - retry after 4 pm"
              foot2="fewer is better"
              delta={
                <Delta
                  today={activity.callsMissed}
                  yesterday={yesterday.callsMissed}
                  moreIsBetter={false}
                />
              }
            />
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_clamp(300px,26%,420px)] items-start gap-4">
            <Card>
              <CardHeader
                title="Needs you today"
                action={
                  <span className="text-[13px] text-muted">
                    Every number opens the records behind it
                  </span>
                }
              />
              <div>
                {needs.map((n) => (
                  <Link
                    key={n.href + n.title}
                    href={n.href}
                    className="flex items-center gap-3 border-b border-divider px-5 py-3.5 no-underline last:border-0 hover:bg-canvas hover:no-underline"
                  >
                    <span
                      className={cx(
                        "block h-2 w-2 flex-none rounded-full",
                        n.tone === "danger"
                          ? "bg-danger"
                          : n.tone === "warn"
                            ? "bg-warn"
                            : n.tone === "brand"
                              ? "bg-brand"
                              : "bg-line-strong",
                      )}
                    />
                    <span className="flex-1">
                      <span className="block text-sm font-medium text-ink">
                        {n.title}
                      </span>
                      <span className="mt-0.5 block text-[13px] text-muted">
                        {n.sub}
                      </span>
                    </span>
                    <span
                      className={cx(
                        "text-lg font-semibold",
                        n.count === 0
                          ? "text-muted"
                          : n.tone === "danger"
                            ? "text-danger"
                            : "text-ink",
                      )}
                    >
                      {n.count}
                    </span>
                    <Icon name="chevron" size={16} className="text-line-strong" />
                  </Link>
                ))}
              </div>
            </Card>

            <div className="flex flex-col gap-4">
              <Card className="p-5">
                <SectionLabel>Monthly target - {monthLabel(period)}</SectionLabel>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-[32px] leading-9 font-semibold text-ink">
                    {money(achieved)}
                  </span>
                  <span className="text-[13px] text-muted">
                    of {money(targetTotal)}
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-2.5">
                  <Progress value={targetPct} className="flex-1" />
                  <span className="text-[13px] font-medium text-ink">
                    {targetPct}%
                  </span>
                </div>
                <div className="mt-3 flex justify-between text-[13px] text-muted">
                  <span>Gap {money(Math.max(0, targetTotal - achieved))}</span>
                  <span>{workingDaysLeft(
                    day,
                    config["workingDay.workingDays"],
                    config["workingDay.timezone"],
                    config["workingDay.dayBoundaryHour"],
                  )}{" "}
                  working days left</span>
                </div>
                <Link
                  href="/crm/targets"
                  className="mt-4 flex h-8 items-center justify-center rounded-[4px] border border-line-strong bg-surface text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
                >
                  View target breakdown
                </Link>
              </Card>

              <Card className="p-5">
                <SectionLabel>End of day</SectionLabel>
                <p className="mt-3 text-sm text-body">
                  {dueReminders
                    ? `${dueReminders} reminder${dueReminders === 1 ? "" : "s"} due today ${
                        dueReminders === 1 ? "is" : "are"
                      } still open. Close or carry ${
                        dueReminders === 1 ? "it" : "them"
                      } forward before you submit the EOD report.`
                    : "Every reminder due today is closed. The EOD report is ready to submit."}
                </p>
                <Link
                  href="/crm/eod"
                  className="mt-4 flex h-8 items-center justify-center rounded-[4px] border border-brand bg-brand text-sm font-medium text-white no-underline hover:bg-brand-hover hover:no-underline"
                >
                  Open EOD report
                </Link>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TeamView({
  activity,
  yesterday,
  remindersFlagged,
  complaintsFlagged,
  overdueGrowth,
  flagDays,
  outstanding,
  targetPct,
  rows,
  over60,
}: {
  activity: Awaited<ReturnType<typeof dayActivity>>;
  yesterday: Awaited<ReturnType<typeof dayActivity>>;
  remindersFlagged: number;
  complaintsFlagged: number;
  overdueGrowth: number;
  flagDays: { reminders: number; complaints: number };
  outstanding: number;
  targetPct: number;
  rows: Awaited<ReturnType<typeof teamDay>>;
  over60: number;
}) {
  const yesterdayMissed = yesterday.callsMissed;
  const avg = (pick: (r: (typeof rows)[number]) => number) =>
    rows.length ? Math.round(rows.reduce((a, r) => a + pick(r), 0) / rows.length) : 0;

  return (
    <div>
      <div className="mb-4 flex items-center gap-5 rounded-[6px] border border-warn-line bg-warn-soft px-4 py-3">
        <span className="text-xs font-medium tracking-[0.04em] text-warn-ink uppercase">
          Red flags
        </span>
        <span className="text-sm text-body">
          <strong className="font-semibold text-danger">{activity.callsMissed}</strong>{" "}
          missed calls yesterday, up from {yesterdayMissed}
        </span>
        <Divider />
        <span className="text-sm text-body">
          <strong className="font-semibold text-danger">{remindersFlagged}</strong>{" "}
          reminders overdue more than {flagDays.reminders} days
        </span>
        <Divider />
        <span className="text-sm text-body">
          <strong className="font-semibold text-danger">{complaintsFlagged}</strong>{" "}
          complaints unresolved past {flagDays.complaints} days
        </span>
        <Divider />
        <span className="text-sm text-body">
          Overdue balance grew{" "}
          <strong className="font-semibold text-danger">{money(overdueGrowth)}</strong>{" "}
          this week
        </span>
        <span className="flex-1" />
        <Link
          href="/crm/payments"
          className="flex h-7.5 items-center rounded-[4px] border border-line-strong bg-surface px-3 text-[13px] font-medium text-body no-underline hover:bg-canvas hover:no-underline"
        >
          Review collections
        </Link>
      </div>

      <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(216px,1fr))] gap-4">
        <Card className="p-5">
          <SectionLabel>Team calls yesterday</SectionLabel>
          <div className="mt-2 text-[32px] leading-9 font-semibold text-ink">
            {activity.callsAttempted}
          </div>
          <div className="mt-1.5 text-[13px] text-muted">
            {activity.callsConnected} connected ·{" "}
            <span className="text-danger">{activity.callsMissed} missed</span>
          </div>
        </Card>
        <Card className="p-5">
          <SectionLabel>Orders booked</SectionLabel>
          <div className="mt-2 text-[32px] leading-9 font-semibold text-ink">
            {money(activity.ordersValue)}
          </div>
          <div className="mt-1.5 text-[13px]">
            <PercentDelta today={activity.ordersValue} yesterday={yesterday.ordersValue} />
          </div>
        </Card>
        <Card className="p-5">
          <SectionLabel>Outstanding</SectionLabel>
          <div className="mt-2 text-[32px] leading-9 font-semibold text-ink">
            {money(outstanding)}
          </div>
          <div className="mt-1.5 text-[13px] text-muted">
            {money(over60)} over 60 days
          </div>
        </Card>
        <Card className="p-5">
          <SectionLabel>Team target</SectionLabel>
          <div className="mt-2 text-[32px] leading-9 font-semibold text-ink">
            {targetPct}%
          </div>
          <Progress value={targetPct} className="mt-2.5" />
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-divider px-5 py-3.5 text-lg leading-6 font-semibold text-ink">
          Telecaller comparison - yesterday
        </div>
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>Telecaller</Th>
                <Th align="right">Queue calls</Th>
                <Th align="right">Overdue reminders</Th>
                <Th align="right">Connected</Th>
                <Th align="right">Missed</Th>
                <Th align="right">Orders</Th>
                <Th align="right">Value</Th>
                <Th align="right">Collected</Th>
                <Th className="w-[150px]">Target</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.user.id} className="hover:bg-canvas">
                  <Td className="font-medium text-ink">{r.user.name}</Td>
                  <Td align="right">
                    {r.activity.queueWorked}
                  </Td>
                  <Td
                    align="right"
                    className={r.overdueReminders > 3 ? "font-medium text-danger" : ""}
                  >
                    {r.overdueReminders}
                  </Td>
                  <Td align="right">{r.activity.callsConnected}</Td>
                  <Td align="right" className={r.activity.callsMissed > 5 ? "text-danger" : ""}>
                    {r.activity.callsMissed}
                  </Td>
                  <Td align="right">{r.activity.ordersCaptured}</Td>
                  <Td align="right" className="font-medium text-ink">
                    {moneyShort(r.activity.ordersValue)}
                  </Td>
                  <Td align="right">{moneyShort(r.activity.paymentsConfirmed)}</Td>
                  <Td>
                    <span className="flex items-center gap-2">
                      <Progress value={r.targetPercent} className="flex-1" />
                      <span className="w-9 text-right text-[13px] text-body">
                        {r.targetPercent}%
                      </span>
                    </span>
                  </Td>
                </Tr>
              ))}
              <tr className="border-t border-line bg-canvas">
                <Td className="font-semibold text-ink">Team average</Td>
                <Td align="right" className="font-medium text-ink">
                  {avg((r) => r.activity.queueWorked)}
                </Td>
                <Td align="right" className="font-medium text-ink">
                  {avg((r) => r.overdueReminders)}
                </Td>
                <Td align="right" className="font-medium text-ink">
                  {avg((r) => r.activity.callsConnected)}
                </Td>
                <Td align="right" className="font-medium text-ink">
                  {avg((r) => r.activity.callsMissed)}
                </Td>
                <Td align="right" className="font-medium text-ink">
                  {avg((r) => r.activity.ordersCaptured)}
                </Td>
                <Td align="right" className="font-semibold text-ink">
                  {moneyShort(avg((r) => r.activity.ordersValue))}
                </Td>
                <Td align="right" className="font-medium text-ink">
                  {moneyShort(avg((r) => r.activity.paymentsConfirmed))}
                </Td>
                <Td className="text-[13px] text-muted">
                  {avg((r) => r.targetPercent)}% of team target
                </Td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/**
 * "+2 vs yesterday". Nothing is shown when the two days match, because a
 * delta of zero is noise, and "yesterday" means the last WORKING day.
 */
function Delta({
  today,
  yesterday,
  moreIsBetter = true,
  suffix = "vs yesterday",
}: {
  today: number;
  yesterday: number;
  moreIsBetter?: boolean;
  suffix?: string;
}) {
  const diff = today - yesterday;
  if (diff === 0) return null;
  const good = moreIsBetter ? diff > 0 : diff < 0;
  return (
    <span
      className={cx(
        "text-[13px] font-medium",
        good ? "text-success" : "text-danger",
      )}
    >
      {diff > 0 ? "+" : "−"}
      {Math.abs(diff)} {suffix}
    </span>
  );
}

/**
 * Movement as a percentage rather than a count. Money moves in numbers too big
 * for "+₹1,54,200 vs yesterday" to mean anything at a glance.
 */
function PercentDelta({ today, yesterday }: { today: number; yesterday: number }) {
  if (!yesterday) {
    return (
      <span className="text-muted">
        {today ? "no figure for the previous day" : "nothing booked yet"}
      </span>
    );
  }
  const change = Math.round(((today - yesterday) / yesterday) * 100);
  if (change === 0) return <span className="text-muted">level with the previous day</span>;
  return (
    <span className={cx("font-medium", change > 0 ? "text-success" : "text-danger")}>
      {change > 0 ? "+" : "−"}
      {Math.abs(change)}% vs previous day
    </span>
  );
}

function Divider() {
  return <span className="h-4 w-px bg-warn-line" />;
}

function StatCard({
  href,
  label,
  value,
  suffix,
  foot,
  foot2,
  foot3,
  progress,
  tone,
  delta,
}: {
  href: string;
  label: string;
  value: string;
  suffix?: string;
  foot?: string;
  foot2?: string;
  /** A comparison figure, shown in muted type beside foot2. */
  foot3?: string;
  progress?: number;
  tone?: "danger";
  delta?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="rounded-[6px] border border-line bg-surface p-5 no-underline transition-colors duration-100 hover:border-line-strong hover:no-underline"
    >
      <div className="flex items-center justify-between">
        <SectionLabel>{label}</SectionLabel>
        <Icon name="chevron" size={16} className="text-line-strong" />
      </div>
      <div
        className={cx(
          "mt-2 text-[32px] leading-9 font-semibold",
          tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {value}
        {suffix ? <span className="text-xl text-muted">{suffix}</span> : null}
      </div>
      {progress !== undefined ? <Progress value={progress} className="mt-3" /> : null}
      {foot || delta ? (
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          {foot ? <span className="text-[13px] text-muted">{foot}</span> : null}
          {delta}
        </div>
      ) : null}
      {foot2 ? (
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-success">{foot2}</span>
          {foot3 ? <span className="text-[13px] text-muted">{foot3}</span> : null}
        </div>
      ) : null}
    </Link>
  );
}

/**
 * The "needs you today" figures plus the manager's red flags, in one query.
 * The flag ages are configuration — "more than three days" is a number Mahek
 * may well want to move.
 */
async function dashboardCounts(
  userId: string | null,
  day: string,
  flagDays: { reminders: number; complaints: number },
) {
  const [row] = await db.execute<{
    due: number;
    overdue: number;
    complaints: number;
    reminders_flagged: number;
    complaints_flagged: number;
    overdue_growth: string;
  }>(sql`
    select
      (select count(*) from reminders r
        where r.status = 'pending' and r.due_date <= ${day}::date
          and (${userId}::text is null or r.assigned_user_id = ${userId}))::int as due,
      (select count(*) from reminders r
        where r.status = 'pending' and r.due_date < ${day}::date
          and (${userId}::text is null or r.assigned_user_id = ${userId}))::int as overdue,
      (select count(*) from complaints c
        join customers cu on cu.id = c.customer_id
        where c.status in ('open','in_progress','awaiting_customer')
          and (${userId}::text is null or cu.owner_id = ${userId}))::int as complaints,
      (select count(*) from reminders r
        where r.status = 'pending'
          and r.due_date < (${day}::date - ${flagDays.reminders}::int)
          and (${userId}::text is null or r.assigned_user_id = ${userId}))::int as reminders_flagged,
      (select count(*) from complaints c
        join customers cu on cu.id = c.customer_id
        where c.status in ('open','in_progress','awaiting_customer')
          and c.created_at < (${day}::date - ${flagDays.complaints}::int)
          and (${userId}::text is null or cu.owner_id = ${userId}))::int as complaints_flagged,
      -- How much the overdue pile grew this week: bills that fell due in the
      -- last seven days and are still unpaid.
      (select coalesce(sum(b.amount - b.paid_amount), 0) from bills b
        join customers cu on cu.id = b.customer_id
        where b.amount > b.paid_amount
          and b.due_date <= ${day}::date
          and b.due_date > (${day}::date - 7)
          and (${userId}::text is null or cu.owner_id = ${userId})) as overdue_growth
  `);
  return {
    dueReminders: row?.due ?? 0,
    overdueReminders: row?.overdue ?? 0,
    openComplaints: row?.complaints ?? 0,
    remindersFlagged: row?.reminders_flagged ?? 0,
    complaintsFlagged: row?.complaints_flagged ?? 0,
    overdueGrowth: Number(row?.overdue_growth ?? 0),
  };
}

async function overSixtyDays(): Promise<number> {
  const [row] = await db.execute<{ total: string }>(sql`
    select coalesce(sum(b.amount - b.paid_amount), 0) as total from bills b
     where b.amount > b.paid_amount
       and b.due_date < current_date - interval '60 days'
  `);
  return Number(row?.total ?? 0);
}

/**
 * Working days left this month, against the configured working week rather
 * than a hardcoded one — which is the whole point of having it in settings.
 */
function workingDaysLeft(
  day: string,
  workingDays: number[],
  timezone: string,
  dayBoundaryHour: number,
): number {
  const [year, month] = day.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 0;
  for (let d = Number(day.slice(8)); d <= lastDay; d++) {
    const date = `${day.slice(0, 8)}${String(d).padStart(2, "0")}`;
    if (isWorkingDay(date, { timezone, dayBoundaryHour, workingDays })) {
      count++;
    }
  }
  return count;
}
