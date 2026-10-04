"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { money } from "@/lib/format";
import { APP_TIMEZONE } from "@/lib/business-date";
import { shiftMonth, monthName } from "@/components/ui/month";
import { useToast } from "@/components/ui/toast";
import { ComboBox } from "@/components/ui/combo-box";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { answerRefusal, proposeJourneyDays } from "@/lib/actions/sales";
import type { JourneyPlan, PlanStop, Salesman, VisitRow } from "@/lib/services/sales-service";
import type {
  CalendarFacts,
  CalendarLeave,
  CalendarTour,
  JourneyEvent,
} from "@/lib/services/journey-service";
import {
  DAY_STATE_LABEL,
  DAY_STATE_TONE,
  areaAnswerState,
  dayOwed,
  dayWhere,
  stopFate,
  sumTallies,
  tallyDay,
  type DayOwed,
  type DayTally,
} from "@/lib/journey-days";
import { Banner, Button, Empty, MetricRow, Pill, RowMenu } from "@/components/console/parts";
import { CustomerName } from "@/components/console/customer-name";
import { accountTypeLabel } from "@/lib/account-types";
import { VISIT_OUTCOME_LABEL, label, plural } from "@/components/console/words";
import { VisitDetail, VisitState, clock, useVisitActions } from "./visit-parts";

/**
 * ONE SALESMAN'S DAYS, EVERY ONE OF THEM, AND WHAT EACH CAME TO.
 *
 * The screen this replaced could propose a run of days and nothing else: it
 * could not show what he had been allocated last week, whether he agreed, what
 * he asked for instead, which of the shops on a walked day he actually went
 * into, or the visits he made that were on no route at all. Those are the
 * questions a manager opens a salesman's plan to answer, so this is a month at
 * a time — as a calendar or as a list — and a day opens into the whole of it:
 * the negotiation and its history, the route stop by stop against the visits
 * that answered it, the visits off it, and where he was on the clock.
 *
 * Proposing a run of days is still here, as its own view, because that is a
 * different act from reading a month. A single day can be proposed or answered
 * from inside its drawer.
 */

type DayInfo = {
  date: string;
  inMonth: boolean;
  plan: JourneyPlan | null;
  visits: VisitRow[];
  tally: DayTally;
  owed: DayOwed;
  attendance: CalendarFacts["attendance"][number] | null;
  leave: CalendarLeave | null;
  holiday: string | null;
  tours: CalendarTour[];
};

export function SalesmanTab({
  salesman,
  month,
  gridDays,
  today,
  view,
  openDay,
  plans,
  visits,
  facts,
  history,
  cities,
}: {
  salesman: Salesman;
  month: string;
  gridDays: string[];
  today: string;
  view: "calendar" | "list";
  openDay: string | null;
  plans: JourneyPlan[];
  visits: VisitRow[];
  facts: CalendarFacts;
  history: JourneyEvent[];
  cities: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState<string | null>(openDay);
  const [onlyBusy, setOnlyBusy] = React.useState(true);

  const days: DayInfo[] = React.useMemo(
    () =>
      gridDays.map((date) => {
        const plan = plans.find((p) => p.planDate === date) ?? null;
        const dayVisits = visits.filter((v) => v.day === date);
        const leave =
          facts.leave.find(
            (l) => l.state !== "rejected" && l.state !== "cancelled" && l.fromDate <= date && l.toDate >= date,
          ) ?? null;
        return {
          date,
          inMonth: date.startsWith(month),
          plan,
          visits: dayVisits,
          tally: tallyDay(
            { planDate: date, stops: plan?.dayState === "planned" ? plan.stops : [] },
            dayVisits.map((v) => ({ wasPlanned: isOnRoute(v, plan) })),
            today,
          ),
          owed: dayOwed(plan, today),
          attendance: facts.attendance.find((a) => a.day === date) ?? null,
          leave,
          holiday: facts.holidays.find((h) => h.onDate === date)?.name ?? null,
          tours: facts.tours.filter(
            (t) => t.state !== "rejected" && t.startDate <= date && t.endDate >= date,
          ),
        };
      }),
    [gridDays, plans, visits, facts, month, today],
  );

  const monthDays = days.filter((d) => d.inMonth);
  const total = sumTallies(monthDays.map((d) => d.tally));
  const count = (state: string, future?: boolean) =>
    monthDays.filter(
      (d) => d.plan?.dayState === state && (future === undefined || (d.date >= today) === future),
    ).length;
  const refusedAhead = days.filter((d) => d.plan?.dayState === "refused" && d.date >= today);
  const punched = monthDays.filter((d) => d.attendance?.checkInAt).length;
  const leaveDays = monthDays.filter((d) => d.leave?.state === "approved").length;

  const area = areaAnswerState(salesman.territories, salesman.areaAnswer);
  const areas = salesman.territories.filter((t) => t.kind !== "region");
  const selected = days.find((d) => d.date === open) ?? null;
  const base = `/sales/journeys?tab=salesman&salesman=${salesman.id}`;

  return (
    <>
      {/* ------------------------------------------------------- who he is */}
      <section className="mb-4 grid gap-4 rounded-[6px] border border-line bg-surface px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-brand-soft text-[13px] font-semibold text-[#5223E0]">
            {salesman.initials}
          </span>
          <span className="min-w-0">
            <Link
              href={`/sales/people/${salesman.id}`}
              className="block truncate text-[15px] font-semibold text-ink no-underline hover:text-brand"
            >
              {salesman.name}
            </Link>
            <span className="block text-[12px] text-muted">
              {plural(Number(salesman.customerCount), "shop")} in his book
              {salesman.phone ? ` · ${salesman.phone}` : ""}
            </span>
            <span className="block text-[12px] text-muted">
              {salesman.lastSeenAt
                ? `Handset last spoke ${stamp(salesman.lastSeenAt)}`
                : salesman.deviceBoundAt
                  ? "Handset has not spoken since it was bound"
                  : "Has never signed in on a handset"}
            </span>
          </span>
        </div>

        <div className="min-w-0">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Areas allocated to him
          </span>
          {areas.length ? (
            <span className="flex flex-wrap gap-1.5">
              {areas.map((t) => (
                <span
                  key={`${t.kind}:${t.parent}:${t.value}`}
                  className="inline-flex h-6 items-center gap-1 rounded-[4px] border border-line bg-canvas px-2 text-[12px] text-body"
                  title={`${t.kind}${t.parent ? ` in ${t.parent}` : ""}`}
                >
                  {t.value}
                  {t.parent ? <span className="text-muted">· {t.parent}</span> : null}
                </span>
              ))}
            </span>
          ) : (
            <span className="block text-[13px] text-muted">None</span>
          )}
          <span
            className={
              "mt-1.5 block text-[12px] " +
              (area.tone === "success"
                ? "text-success"
                : area.tone === "danger"
                  ? "text-danger"
                  : area.tone === "warn"
                    ? "text-warn-ink"
                    : "text-muted")
            }
            title={salesman.areaAnswer?.reason ?? undefined}
          >
            {area.text}
            {salesman.areaAnswer ? ` · ${shortDate(salesman.areaAnswer.at)}` : ""}
            {salesman.areaAnswer?.reason ? ` — “${salesman.areaAnswer.reason}”` : ""}
          </span>
        </div>

        <div className="flex flex-none flex-col items-stretch gap-1.5">
          <Link href={`${base}&view=propose`} className="no-underline">
            <Button tone="primary" size="sm">
              Propose days
            </Button>
          </Link>
          <Link href={`/sales/people/${salesman.id}`} className="no-underline">
            <Button size="sm">Change his areas</Button>
          </Link>
          <Link href={`/sales/journeys?tab=visits&salesman=${salesman.id}`} className="no-underline">
            <Button size="sm" tone="quiet">
              Today&rsquo;s visits
            </Button>
          </Link>
        </div>
      </section>

      {refusedAhead.length ? (
        <Banner
          tone="danger"
          title={`${plural(refusedAhead.length, "day")} came back refused — waiting on you`}
          body={
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {refusedAhead.map((d) => (
                <button
                  key={d.date}
                  onClick={() => setOpen(d.date)}
                  className="cursor-pointer text-left text-[13px] text-body underline decoration-dotted underline-offset-2 hover:text-ink"
                >
                  {shortDate(d.date)}: {d.plan?.city} — “{d.plan?.refusalReason}”
                  {d.plan?.counterCity ? ` (he wants ${d.plan.counterCity})` : ""}
                </button>
              ))}
            </span>
          }
        />
      ) : null}

      {/* ------------------------------------------------------ the month */}
      <MetricRow
        metrics={[
          {
            label: "Route days",
            value: String(count("planned")),
            sub: `${count("planned", false)} walked · ${count("planned", true)} ahead`,
          },
          {
            label: "Waiting on him",
            value: String(count("proposed", true) + count("agreed", true)),
            sub: `${count("proposed", true)} to answer · ${count("agreed", true)} to pick shops`,
            tone: count("proposed", true) + count("agreed", true) ? "warn" : undefined,
          },
          {
            label: "Waiting on you",
            value: String(count("refused", true)),
            sub: "refused days",
            tone: count("refused", true) ? "danger" : undefined,
          },
          {
            label: "Shops allocated",
            value: String(total.allocated),
            sub: `${total.visited} visited · ${total.skipped} skipped`,
          },
          {
            label: "Adherence",
            value: total.adherencePct === null ? "—" : `${total.adherencePct}%`,
            sub: total.missed ? `${total.missed} missed with no reason` : "visited of allocated",
            tone:
              total.adherencePct === null
                ? undefined
                : total.adherencePct >= 80
                  ? "success"
                  : total.adherencePct >= 50
                    ? "warn"
                    : "danger",
          },
          {
            label: "Visits",
            value: String(total.visits),
            sub: `${total.offPlan} off the route`,
          },
          {
            label: "Punched in",
            value: String(punched),
            sub: leaveDays ? `${plural(leaveDays, "day")} on leave` : "days",
          },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 text-[13px]">
          <Link
            href={`${base}&view=${view}&month=${shiftMonth(month, -1)}`}
            aria-label="The month before"
            className="rounded-[4px] border border-line bg-surface px-2.5 py-1 text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ←
          </Link>
          <span className="min-w-[130px] text-center font-medium text-ink">{monthName(month)}</span>
          <Link
            href={`${base}&view=${view}&month=${shiftMonth(month, 1)}`}
            aria-label="The month after"
            className="rounded-[4px] border border-line bg-surface px-2.5 py-1 text-body no-underline hover:bg-canvas hover:no-underline"
          >
            →
          </Link>
          {month !== today.slice(0, 7) ? (
            <Link
              href={`${base}&view=${view}`}
              className="ml-1 rounded-[4px] px-2 py-1 text-brand no-underline hover:bg-canvas hover:no-underline"
            >
              This month
            </Link>
          ) : null}
        </div>

        <div className="flex-1" />

        {view === "list" ? (
          <label className="flex items-center gap-1.5 text-[13px] text-body">
            <input type="checkbox" checked={onlyBusy} onChange={(e) => setOnlyBusy(e.target.checked)} />
            Only days with something on them
          </label>
        ) : (
          <Legend />
        )}
      </div>

      {view === "calendar" ? (
        <CalendarGrid days={days} today={today} onOpen={setOpen} />
      ) : (
        <DayList
          days={monthDays.filter(
            (d) =>
              !onlyBusy ||
              d.plan ||
              d.visits.length ||
              d.leave ||
              d.holiday ||
              d.tours.length ||
              d.attendance?.checkInAt,
          )}
          today={today}
          onOpen={setOpen}
        />
      )}

      {selected ? (
        <DayDrawer
          /* Keyed on the day so a different one opens with fresh typing rather
             than resetting state in an effect. */
          key={selected.date}
          day={selected}
          today={today}
          salesman={salesman}
          cities={cities}
          history={history}
          onClose={() => setOpen(null)}
          onRefresh={() => router.refresh()}
        />
      ) : null}
    </>
  );
}

/* ================================================================ calendar */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function CalendarGrid({
  days,
  today,
  onOpen,
}: {
  days: DayInfo[];
  today: string;
  onOpen: (date: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-[6px] border border-line bg-surface">
      <div className="grid min-w-[880px] grid-cols-7">
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="border-b border-line px-2.5 py-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase"
          >
            {w}
          </div>
        ))}
        {days.map((d, i) => (
          <button
            key={d.date}
            onClick={() => onOpen(d.date)}
            className={
              "group flex min-h-[128px] cursor-pointer flex-col gap-1 border-divider px-2.5 py-2 text-left align-top hover:bg-canvas " +
              (i % 7 !== 6 ? "border-r " : "") +
              (i < days.length - 7 ? "border-b " : "") +
              (d.inMonth ? "" : "bg-canvas/60 opacity-60 ") +
              (d.date === today ? "ring-2 ring-brand ring-inset " : "")
            }
          >
            <span className="flex items-center justify-between gap-1">
              <span
                className={
                  "text-[13px] tabular-nums " +
                  (d.date === today ? "font-semibold text-[#5223E0]" : "font-medium text-ink")
                }
              >
                {Number(d.date.slice(8))}
                {d.date.slice(8) === "01" ? ` ${monthShort(d.date)}` : ""}
              </span>
              {d.plan ? (
                <Pill tone={DAY_STATE_TONE[d.plan.dayState]}>{DAY_STATE_LABEL[d.plan.dayState]}</Pill>
              ) : d.leave ? (
                <Pill tone={d.leave.state === "approved" ? "neutral" : "warn"}>
                  {d.leave.state === "approved" ? "Leave" : "Leave?"}
                </Pill>
              ) : d.holiday ? (
                <Pill>Holiday</Pill>
              ) : null}
            </span>

            {d.plan && dayWhere(d.plan).text ? (
              <span
                className="block truncate text-[13px] font-medium text-body"
                title={dayWhere(d.plan).fromShops ? "No city was proposed — this is where the shops are" : undefined}
              >
                {dayWhere(d.plan).text}
                {d.plan.selfPlanned ? <span className="font-normal text-muted"> · his own</span> : null}
              </span>
            ) : d.holiday ? (
              <span className="block truncate text-[12px] text-muted">{d.holiday}</span>
            ) : d.tours.length ? (
              <span className="block truncate text-[12px] text-muted">Tour: {d.tours[0].cities.join(", ")}</span>
            ) : null}

            {d.tally.allocated ? (
              <>
                <StopBar tally={d.tally} />
                <span className="block text-[12px] text-body tabular-nums">
                  {d.tally.visited}/{d.tally.allocated} visited
                  {d.tally.skipped ? <span className="text-warn-ink"> · {d.tally.skipped} skipped</span> : null}
                  {d.tally.missed ? <span className="text-danger"> · {d.tally.missed} missed</span> : null}
                </span>
              </>
            ) : d.plan && d.date >= today ? (
              <span className={"block text-[12px] " + toneText(d.owed.tone)}>{d.owed.text}</span>
            ) : null}

            {d.plan?.dayState === "refused" && d.plan.refusalReason ? (
              <span className="block truncate text-[12px] text-danger" title={d.plan.refusalReason}>
                “{d.plan.refusalReason}”
                {d.plan.counterCity ? ` → ${d.plan.counterCity}` : ""}
              </span>
            ) : null}

            {d.visits.length && d.date <= today ? (
              <span className="block text-[11px] leading-[14px] text-body">
                {d.visits.slice(0, 3).map((v) => (
                  <span key={v.id} className="block truncate" title={`${v.customerName} — ${label(VISIT_OUTCOME_LABEL, v.outcome)}`}>
                    <span className={v.customerKind === "lead" ? "text-warn-ink" : "text-success"}>•</span> {v.customerName}
                  </span>
                ))}
                {d.visits.length > 3 ? <span className="block text-muted">+{d.visits.length - 3} more</span> : null}
              </span>
            ) : null}

            {d.tally.offPlan ? (
              <span className="block text-[12px] text-muted">+{d.tally.offPlan} off the route</span>
            ) : !d.plan && d.tally.visits ? (
              <span className="block text-[12px] text-muted">{plural(d.tally.visits, "visit")}, no plan</span>
            ) : null}

            {d.attendance?.checkInAt ? (
              <span className="mt-auto block text-[11px] text-muted tabular-nums">
                {clock(d.attendance.checkInAt)}–{d.attendance.checkOutAt ? clock(d.attendance.checkOutAt) : "…"}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Visited, skipped, missed and still to come, as one bar. */
function StopBar({ tally }: { tally: DayTally }) {
  const parts = [
    { n: tally.visited, c: "bg-success", t: "visited" },
    { n: tally.skipped, c: "bg-warn", t: "skipped" },
    { n: tally.missed, c: "bg-danger", t: "missed" },
    { n: tally.pending, c: "bg-line-strong", t: "still to come" },
  ];
  return (
    <span
      className="flex h-1.5 w-full overflow-hidden rounded-[3px] bg-divider"
      title={parts
        .filter((p) => p.n)
        .map((p) => `${p.n} ${p.t}`)
        .join(", ")}
    >
      {parts.map((p) =>
        p.n ? (
          <span key={p.t} className={"block h-full " + p.c} style={{ width: `${(p.n / tally.allocated) * 100}%` }} />
        ) : null,
      )}
    </span>
  );
}

function Legend() {
  const dots = [
    ["bg-success", "visited"],
    ["bg-warn", "skipped"],
    ["bg-danger", "missed"],
    ["bg-line-strong", "to come"],
  ];
  return (
    <span className="flex flex-wrap items-center gap-3 text-[12px] text-muted">
      {dots.map(([c, t]) => (
        <span key={t} className="inline-flex items-center gap-1">
          <span className={"inline-block h-2 w-2 rounded-full " + c} />
          {t}
        </span>
      ))}
    </span>
  );
}

/* ==================================================================== list */

function DayList({
  days,
  today,
  onOpen,
}: {
  days: DayInfo[];
  today: string;
  onOpen: (date: string) => void;
}) {
  if (!days.length) {
    return (
      <Empty
        title="Nothing this month"
        body="No day was proposed, planned or worked, and he logged no visit. Untick the box above to see every date."
      />
    );
  }
  const th = "px-3 py-2 text-left text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase";
  return (
    <div className="overflow-x-auto rounded-[6px] border border-line bg-surface">
      <table className="w-full min-w-[1100px] border-collapse text-[13px]">
        <thead className="border-b border-line bg-canvas">
          <tr>
            <th className={th}>Day</th>
            <th className={th}>Where</th>
            <th className={th}>State</th>
            <th className={th + " text-right"}>Allocated</th>
            <th className={th + " text-right"}>Visited</th>
            <th className={th + " text-right"}>Skipped</th>
            <th className={th + " text-right"}>Missed</th>
            <th className={th + " text-right"}>Off route</th>
            <th className={th}>Punched</th>
            <th className={th}>What was said</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr
              key={d.date}
              onClick={() => onOpen(d.date)}
              className={
                "cursor-pointer border-b border-divider hover:bg-canvas " +
                (d.date === today ? "bg-brand-soft/40" : "")
              }
            >
              <td className="px-3 py-2 whitespace-nowrap">
                <span className="block font-medium text-ink">{shortDate(d.date)}</span>
                <span className="block text-[11px] text-muted">
                  {weekday(d.date)}
                  {d.date === today ? " · today" : ""}
                </span>
              </td>
              <td className="max-w-[260px] px-3 py-2">
                <span className="block truncate text-body">
                  {(d.plan && dayWhere(d.plan).text) ?? (d.holiday ? d.holiday : <span className="text-muted">—</span>)}
                </span>
                {d.plan && dayWhere(d.plan).fromShops ? (
                  <span className="block text-[11px] text-muted">from the shops — no city proposed</span>
                ) : null}
                {d.plan?.selfPlanned ? <span className="block text-[11px] text-muted">planned it himself</span> : null}
                {d.plan && d.holiday ? <span className="block text-[11px] text-warn-ink">Holiday — {d.holiday}</span> : null}
                {d.tours.length ? (
                  <span className="block truncate text-[11px] text-muted">Tour: {d.tours[0].cities.join(", ")}</span>
                ) : null}
                {d.visits.length ? (
                  <span
                    className="block truncate text-[11px] text-body"
                    title={d.visits.map((v) => v.customerName).join(", ")}
                  >
                    Visited {d.visits.map((v) => v.customerName).join(", ")}
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-2">
                {d.plan ? (
                  <Pill tone={DAY_STATE_TONE[d.plan.dayState]}>{DAY_STATE_LABEL[d.plan.dayState]}</Pill>
                ) : d.leave ? (
                  <Pill tone={d.leave.state === "approved" ? "neutral" : "warn"}>
                    {d.leave.state === "approved" ? "On leave" : "Leave asked"}
                  </Pill>
                ) : d.holiday ? (
                  <Pill>Holiday</Pill>
                ) : null}
                <span className={"mt-0.5 block text-[11px] " + toneText(d.owed.tone)}>
                  {d.plan || !d.leave ? d.owed.text : ""}
                </span>
              </td>
              <Num n={d.tally.allocated} />
              <Num n={d.tally.visited} tone="text-success" />
              <Num n={d.tally.skipped} tone="text-warn-ink" />
              <Num n={d.tally.missed} tone="text-danger" />
              <Num n={d.tally.offPlan} />
              <td className="px-3 py-2 whitespace-nowrap text-body tabular-nums">
                {d.attendance?.checkInAt ? (
                  `${clock(d.attendance.checkInAt)}–${d.attendance.checkOutAt ? clock(d.attendance.checkOutAt) : "…"}`
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td className="max-w-[300px] px-3 py-2">
                {d.plan?.refusalReason ? (
                  <span className="block truncate text-danger" title={d.plan.refusalReason}>
                    “{d.plan.refusalReason}”{d.plan.counterCity ? ` → wants ${d.plan.counterCity}` : ""}
                  </span>
                ) : d.leave?.reason ? (
                  <span className="block truncate text-muted">{d.leave.reason}</span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Num({ n, tone }: { n: number; tone?: string }) {
  return (
    <td className={"px-3 py-2 text-right tabular-nums " + (n ? (tone ?? "text-body") : "text-muted")}>
      {n || "—"}
    </td>
  );
}

/* ============================================================== one day */

function DayDrawer({
  day,
  today,
  salesman,
  cities,
  history,
  onClose,
  onRefresh,
}: {
  day: DayInfo;
  today: string;
  salesman: Salesman;
  cities: string[];
  history: JourneyEvent[];
  onClose: () => void;
  onRefresh: () => void;
}) {
  const toast = useToast();
  const actions = useVisitActions();
  const plan = day.plan;
  const [city, setCity] = React.useState(
    plan?.dayState === "planned" || plan?.dayState === "refused" ? "" : (plan?.city ?? ""),
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const future = day.date >= today;
  const canPropose = future && (!plan || plan.dayState === "proposed");
  const stops = plan?.stops ?? [];
  const visitById = new Map(day.visits.map((v) => [v.id, v]));
  const offRoute = day.visits.filter((v) => !isOnRoute(v, plan));

  const events = history.filter(
    (e) =>
      (plan && e.planId === plan.id) ||
      (!e.planId && e.from && e.from <= day.date && (e.to ?? e.from) >= day.date),
  );

  async function run(work: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (!result.ok) return setError(result.error ?? "That did not save.");
      toast.push(result.message ?? "Saved.");
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open onClose={onClose} width={820} label={`${salesman.name}, ${longDate(day.date)}`}>
      <DrawerHeader onClose={onClose}>
        <span className="block text-[12px] text-muted">
          {salesman.name} · {weekday(day.date)}
          {day.date === today ? " · today" : ""}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-semibold text-ink">{longDate(day.date)}</span>
          {plan ? <Pill tone={DAY_STATE_TONE[plan.dayState]}>{DAY_STATE_LABEL[plan.dayState]}</Pill> : null}
          {plan && dayWhere(plan).text ? <span className="text-[15px] text-body">{dayWhere(plan).text}</span> : null}
        </span>
        <span className={"block text-[13px] " + toneText(day.owed.tone)}>{day.owed.text}</span>
      </DrawerHeader>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-[13px] text-body">
        {error ? <Banner tone="danger" title="That did not save" body={error} /> : null}

        {/* ------------------------------------------- his day, on the clock */}
        {day.leave || day.holiday || day.tours.length || day.attendance ? (
          <section className="flex flex-wrap gap-2">
            {day.holiday ? <Fact tone="neutral">Holiday — {day.holiday}</Fact> : null}
            {day.leave ? (
              <Fact tone={day.leave.state === "approved" ? "neutral" : "warn"}>
                {day.leave.state === "approved" ? "On leave" : `Leave ${day.leave.state}`} ·{" "}
                {day.leave.leaveType.replace(/_/g, " ")}
                {day.leave.halfDay ? " (half day)" : ""}
                {day.leave.reason ? ` — ${day.leave.reason}` : ""}
              </Fact>
            ) : null}
            {day.tours.map((t) => (
              <Fact key={t.id} tone={t.state === "approved" ? "neutral" : "warn"}>
                Tour {t.state === "approved" ? "" : `(${t.state}) `}to {t.cities.join(", ") || "somewhere unnamed"}
                {t.purpose ? ` — ${t.purpose}` : ""}
              </Fact>
            ))}
            {day.attendance?.checkInAt ? (
              <Fact tone={day.attendance.withinGeofence === false ? "warn" : "neutral"}>
                Punched in {clock(day.attendance.checkInAt)}
                {day.attendance.checkOutAt
                  ? `, out ${clock(day.attendance.checkOutAt)}${day.attendance.autoCheckedOut ? " (closed by the system)" : ""}`
                  : day.date === today
                    ? ", still working"
                    : ", never punched out"}
                {day.attendance.workedSeconds != null ? ` · ${hours(day.attendance.workedSeconds)} worked` : ""}
                {day.attendance.withinGeofence === false ? " · outside his base" : ""}
              </Fact>
            ) : day.date < today && (plan || day.visits.length) ? (
              <Fact tone="warn">No punch-in recorded</Fact>
            ) : null}
          </section>
        ) : null}

        {/* ------------------------------------------------ the negotiation */}
        <section>
          <SectionTitle>The plan</SectionTitle>
          {plan ? (
            <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="text-muted">Where</dt>
              <dd>
                {plan.city ??
                  (plan.shopCities.length ? (
                    <>
                      {plan.shopCities.join(", ")}
                      <span className="block text-[12px] text-muted">
                        Read off the {plan.stops.length === 1 ? "shop" : "shops"} on the route — the office picked
                        shops rather than proposing a city.
                      </span>
                    </>
                  ) : (
                    "No city named"
                  ))}
                {plan.beat ? ` · beat ${plan.beat}` : ""}
                {plan.area ? ` · ${plan.area}` : ""}
              </dd>
              <dt className="text-muted">Who decided it</dt>
              <dd>
                {plan.selfPlanned
                  ? "He planned this day himself"
                  : plan.proposedByName
                    ? `Proposed by ${plan.proposedByName}${plan.proposedAt ? ` on ${stamp(plan.proposedAt)}` : ""}`
                    : "Arranged from the office"}
              </dd>
              <dt className="text-muted">His answer</dt>
              <dd>
                {plan.dayState === "proposed" ? (
                  <span className="text-warn-ink">Not answered yet</span>
                ) : plan.dayState === "refused" ? (
                  <span className="text-danger">
                    Refused{plan.respondedAt ? ` on ${stamp(plan.respondedAt)}` : ""} — “{plan.refusalReason}”
                    {plan.counterCity ? `. He wants ${plan.counterCity} instead.` : ". He named nowhere else."}
                  </span>
                ) : plan.selfPlanned ? (
                  "His own day — nothing to agree"
                ) : (
                  `Agreed${plan.respondedAt ? ` on ${stamp(plan.respondedAt)}` : ""}`
                )}
              </dd>
              <dt className="text-muted">Shops</dt>
              <dd>
                {stops.length
                  ? `${plural(stops.length, "shop")} on the route`
                  : plan.dayState === "agreed"
                    ? future
                      ? "Not picked yet — he picks them on his handset"
                      : "None were ever picked"
                    : "None yet"}
                {plan.estimatedTravelMinutes ? ` · about ${plan.estimatedTravelMinutes} min on the road` : ""}
              </dd>
              {plan.startedAt || plan.completedAt ? (
                <>
                  <dt className="text-muted">Walked</dt>
                  <dd>
                    {plan.startedAt ? `Started ${clock(plan.startedAt)}` : ""}
                    {plan.completedAt ? ` · finished ${clock(plan.completedAt)}` : ""}
                  </dd>
                </>
              ) : null}
              {plan.notes ? (
                <>
                  <dt className="text-muted">Notes</dt>
                  <dd className="whitespace-pre-wrap">{plan.notes}</dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p className="text-muted">
              {future ? "Nothing proposed for this day yet." : "Nothing was planned for this day."}
              {!future && day.visits.length ? ` He still logged ${plural(day.visits.length, "visit")} — below.` : ""}
            </p>
          )}

          {/* ANSWERING, right where the answer is read. */}
          {plan?.dayState === "refused" && future ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[6px] border border-danger/30 bg-danger-soft/40 px-3 py-2.5">
              {plan.counterCity ? (
                <Button
                  size="sm"
                  tone="primary"
                  disabled={busy}
                  onClick={() => void run(() => answerRefusal({ planId: plan.id, take: "counter" }))}
                >
                  Take {plan.counterCity}
                </Button>
              ) : null}
              <ComboBox
                value={city}
                options={cities}
                onChange={setCity}
                disabled={busy}
                label="A different city"
                placeholder="Or propose a different city"
                emptyHint="No city in his book matches — what you type is still proposed"
                className="w-[230px]"
              />
              <Button
                size="sm"
                disabled={busy || !city.trim() || city.trim() === plan.city}
                title={!city.trim() ? "Type the city to put back to him." : undefined}
                onClick={() => void run(() => answerRefusal({ planId: plan.id, take: "other", city: city.trim() }))}
              >
                Propose instead
              </Button>
            </div>
          ) : canPropose ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[6px] border border-line bg-canvas px-3 py-2.5">
              <ComboBox
                value={city}
                options={cities}
                onChange={setCity}
                disabled={busy}
                label={`City for ${shortDate(day.date)}`}
                placeholder="Propose a city"
                emptyHint="No city in his book matches — what you type is still proposed"
                className="w-[230px]"
              />
              <Button
                size="sm"
                tone="primary"
                disabled={busy || !city.trim() || city.trim() === plan?.city}
                title={!city.trim() ? "Type a city first." : undefined}
                onClick={() =>
                  void run(() =>
                    proposeJourneyDays({ salesmanId: salesman.id, days: [{ planDate: day.date, city: city.trim() }] }),
                  )
                }
              >
                {plan ? "Propose a different city" : "Propose"}
              </Button>
              <span className="text-[12px] text-muted">He answers on his handset.</span>
            </div>
          ) : null}

          {future && plan?.dayState !== "planned" ? (
            <Link
              href={`/sales/journeys?tab=salesman&salesman=${salesman.id}&view=propose&from=${day.date}&days=1`}
              className="mt-2 inline-block text-[12px] text-brand no-underline hover:underline"
            >
              Pick the shops yourself from the office →
            </Link>
          ) : null}
        </section>

        {/* ------------------------------------------------- what was said */}
        {events.length ? (
          <section>
            <SectionTitle>What was said about this day</SectionTitle>
            <ol className="space-y-1.5 border-l border-divider pl-3">
              {events.map((e) => (
                <li key={e.id} className="relative">
                  <span className="absolute top-1.5 -left-[16px] h-1.5 w-1.5 rounded-full bg-line-strong" />
                  <span className="text-muted tabular-nums">{stamp(e.at)}</span> ·{" "}
                  <span className="text-ink">{e.actorName ?? "Somebody"}</span> {eventSentence(e)}
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {/* ---------------------------------- allocated against visited */}
        <section>
          <SectionTitle>
            Allocated against visited
            {day.tally.allocated ? (
              <span className="ml-2 font-normal tracking-normal normal-case">
                {day.tally.visited} of {day.tally.allocated} visited
                {day.tally.adherencePct !== null ? ` · ${day.tally.adherencePct}%` : ""}
              </span>
            ) : null}
          </SectionTitle>
          {stops.length ? (
            <>
              <StopBar tally={day.tally} />
              <ol className="mt-2 divide-y divide-divider rounded-[6px] border border-line">
                {stops.map((s) => {
                  const v = s.visitId ? (visitById.get(s.visitId) ?? null) : null;
                  return (
                    <StopRow
                      key={s.id}
                      stop={s}
                      planDate={day.date}
                      today={today}
                      visit={v}
                      open={v ? expanded.has(v.id) : false}
                      onToggle={() => v && toggle(v.id)}
                      menu={v ? actions.items(v) : []}
                    />
                  );
                })}
              </ol>
            </>
          ) : (
            <p className="text-muted">
              {future ? "No shops on the route yet." : "No shops were allocated for this day."}
            </p>
          )}
        </section>

        {/* ------------------------------- every shop he walked into */}
        <section>
          <SectionTitle>
            Shops he visited, in order
            <span className="ml-2 font-normal tracking-normal normal-case">
              {day.visits.length
                ? `${plural(day.visits.length, "visit")}${offRoute.length ? ` · ${offRoute.length} off the route` : ""}`
                : "none"}
            </span>
          </SectionTitle>
          {day.visits.length ? (
            <>
              <ol className="divide-y divide-divider rounded-[6px] border border-line">
                {[...day.visits]
                  .sort((x, y) => String(x.checkInAt ?? "").localeCompare(String(y.checkInAt ?? "")))
                  .map((v) => {
                    const stop = stops.find((s) => s.visitId === v.id || s.id === v.journeyPlanStopId);
                    const on = isOnRoute(v, plan);
                    return (
                      <li key={v.id}>
                        <div
                          className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-canvas"
                          onClick={() => toggle(v.id)}
                        >
                          <span className="w-[46px] flex-none pt-0.5 text-muted tabular-nums">
                            {v.checkInAt ? clock(v.checkInAt) : "—"}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                className="cursor-pointer text-left font-medium text-ink hover:text-brand hover:underline"
                                title="See what happened at this shop that day"
                              >
                                {v.customerName}
                              </button>
                              <Pill tone={v.customerThirdParty ? "neutral" : v.customerKind === "lead" ? "warn" : "brand"}>
                                {accountTypeLabel({ kind: v.customerKind, thirdParty: v.customerThirdParty })}
                              </Pill>
                              {on ? (
                                <Pill tone="success">{stop ? `Route stop ${stop.sequence}` : "On the route"}</Pill>
                              ) : (
                                <Pill>Off the route</Pill>
                              )}
                            </span>
                            <span className="block text-[12px] text-body">
                              <span className="font-medium">{label(VISIT_OUTCOME_LABEL, v.outcome)}</span>
                              {v.durationSeconds != null
                                ? ` · ${Math.round(v.durationSeconds / 60)} min inside`
                                : " · never checked out"}
                              {v.checkOutAt ? ` · left ${clock(v.checkOutAt)}` : ""}
                              {Number(v.orderValuePaise) ? ` · order ${money(v.orderValuePaise)}` : ""}
                              {v.tookPayment ? " · took a payment" : ""}
                              {v.raisedComplaint ? " · raised a complaint" : ""}
                              {v.gaveSample ? " · left a sample" : ""}
                            </span>
                            {v.customerCity ? (
                              <span className="block text-[12px] text-muted">{v.customerCity}</span>
                            ) : null}
                            {!on && v.deviationReason ? (
                              <span className="block text-[12px] text-body italic">
                                Why he went: “{v.deviationReason}”
                              </span>
                            ) : !on && !v.wasPlanned ? (
                              <span className="block text-[12px] text-muted">No reason given for going here</span>
                            ) : null}
                            {v.notes?.trim() && !expanded.has(v.id) ? (
                              <span className="block truncate text-[12px] text-muted">“{v.notes.trim()}”</span>
                            ) : null}
                            <span className="mt-1 block">
                              <VisitState v={v} />
                            </span>
                          </span>
                          <span className="flex flex-none items-center gap-2" onClick={(e) => e.stopPropagation()}>
                            <span className="text-[12px]">
                              <CustomerName id={v.customerId} name="Account" />
                            </span>
                            <RowMenu items={actions.items(v)} />
                          </span>
                        </div>
                        {expanded.has(v.id) ? (
                          <div className="border-t border-divider bg-canvas px-3 py-3">
                            <VisitDetail v={v} />
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
              </ol>
              <p className="mt-1.5 text-[12px] text-muted">
                Click a shop for that day&rsquo;s visit in full — notes, voice note, photographs and the competition he
                found. &ldquo;Account&rdquo; opens the shop itself.
              </p>
            </>
          ) : (
            <p className="text-muted">
              {day.date > today ? "The day has not come yet." : "No visit was logged on this day."}
            </p>
          )}
        </section>

        <section className="flex flex-wrap gap-x-4 gap-y-1 border-t border-divider pt-3 text-[12px]">
          <Link href={`/sales/live?day=${day.date}&view=today`} className="text-brand no-underline hover:underline">
            His trail on the Live map →
          </Link>
          <Link
            href={`/sales/journeys?tab=visits&day=${day.date}&salesman=${salesman.id}`}
            className="text-brand no-underline hover:underline"
          >
            This day in the visit log →
          </Link>
          <Link
            href={`/sales/travel?month=${day.date.slice(0, 7)}&who=${salesman.id}`}
            className="text-brand no-underline hover:underline"
          >
            Travel ledger →
          </Link>
        </section>
      </div>
      {actions.modal}
    </Drawer>
  );
}

function StopRow({
  stop,
  planDate,
  today,
  visit,
  open,
  onToggle,
  menu,
}: {
  stop: PlanStop;
  planDate: string;
  today: string;
  visit: VisitRow | null;
  open: boolean;
  onToggle: () => void;
  menu: ReturnType<ReturnType<typeof useVisitActions>["items"]>;
}) {
  const fate = stopFate(stop.status, planDate, today);
  const tone = { visited: "success", skipped: "warn", missed: "danger", pending: "neutral" } as const;
  const word = { visited: "Visited", skipped: "Skipped", missed: "Missed", pending: "To come" }[fate];
  return (
    <li>
      <div
        className={"flex items-start gap-3 px-3 py-2 " + (visit ? "cursor-pointer hover:bg-canvas" : "")}
        onClick={onToggle}
      >
        <span className="w-[22px] flex-none pt-0.5 text-right text-muted tabular-nums">{stop.sequence}</span>
        <span className="min-w-0 flex-1">
          {visit ? (
            <button
              type="button"
              className="cursor-pointer text-left font-medium text-ink hover:text-brand hover:underline"
              title="See what happened at this shop that day"
            >
              {stop.customerName}
            </button>
          ) : (
            <span onClick={(e) => e.stopPropagation()}>
              <CustomerName id={stop.customerId} name={stop.customerName} />
            </span>
          )}
          <span className="ml-1.5 text-[12px] text-muted">
            {accountTypeLabel({ kind: stop.kind, thirdParty: stop.thirdParty })}
          </span>
          <span className="block text-[12px] text-muted">
            {[stop.area, stop.city].filter(Boolean).join(", ") || "No place recorded"}
            {!stop.hasGps ? " · no pin" : ""}
            {Number(stop.outstandingPaise) ? ` · owes ${money(stop.outstandingPaise)}` : ""}
            {stop.lastVisitDate ? ` · last visited ${shortDate(stop.lastVisitDate)}` : ""}
          </span>
          {fate === "skipped" ? (
            <span className="block text-[12px] text-warn-ink">
              {stop.skipReason ? `Why: “${stop.skipReason}”` : "Skipped without a reason"}
            </span>
          ) : fate === "missed" ? (
            <span className="block text-[12px] text-danger">Never visited and never skipped — nobody said why</span>
          ) : null}
          {stop.visitId ? (
            <span className="block text-[12px] text-body">
              {stop.visitCheckInAt ? `In at ${clock(stop.visitCheckInAt)}` : "Visited"}
              {stop.visitDurationSeconds != null ? ` · ${Math.round(stop.visitDurationSeconds / 60)} min inside` : ""}
              {stop.visitOutcome ? ` · ${label(VISIT_OUTCOME_LABEL, stop.visitOutcome)}` : ""}
              {Number(stop.visitOrderValuePaise) ? ` · order ${money(stop.visitOrderValuePaise)}` : ""}
            </span>
          ) : null}
          {visit ? (
            <span className="mt-1 block">
              <VisitState v={visit} />
            </span>
          ) : null}
        </span>
        <span className="flex flex-none items-center gap-1">
          <Pill tone={tone[fate]}>{word}</Pill>
          {menu.length ? (
            <span onClick={(e) => e.stopPropagation()}>
              <RowMenu items={menu} />
            </span>
          ) : null}
        </span>
      </div>
      {open && visit ? (
        <div className="border-t border-divider bg-canvas px-3 py-3">
          <VisitDetail v={visit} />
        </div>
      ) : null}
    </li>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{children}</h3>
  );
}

function Fact({ tone, children }: { tone: "neutral" | "warn"; children: React.ReactNode }) {
  return (
    <span
      className={
        "inline-flex items-center rounded-[4px] border px-2 py-1 text-[12px] " +
        (tone === "warn" ? "border-warn bg-warn-soft text-warn-ink" : "border-line bg-canvas text-body")
      }
    >
      {children}
    </span>
  );
}

/* ================================================================= helpers */

/**
 * Whether a visit answered a stop on THIS day's route.
 *
 * The handset's own `wasPlanned` is read first; the stop link is the fallback,
 * and a visit naming a stop that is not on this route — a shop moved to
 * another day — is drawn off it, where somebody will see it.
 */
function isOnRoute(v: VisitRow, plan: JourneyPlan | null): boolean {
  if (!plan) return false;
  if (v.journeyPlanStopId) return plan.stops.some((s) => s.id === v.journeyPlanStopId);
  return v.wasPlanned && plan.stops.some((s) => s.customerId === v.customerId);
}

function eventSentence(e: JourneyEvent): string {
  const a = e.after ?? {};
  const b = e.before ?? {};
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
  switch (e.action) {
    case "mbos.journey.answered":
      return a.answer === "refused"
        ? `refused ${str(b.city) ?? "the day"} — “${str(a.reason) ?? "no reason"}”${str(a.counterCity) ? `, wanted ${str(a.counterCity)}` : ""}`
        : `agreed ${str(b.city) ?? "the day"}`;
    case "mbos.journey.took_counter":
      return `took his counter-proposal: ${str(a.city) ?? "his city"}${str(b.refusalReason) ? ` (he had refused ${str(b.city) ?? "it"}: “${str(b.refusalReason)}”)` : ""}`;
    case "mbos.journey.reproposed":
      return `proposed ${str(a.city) ?? "a different city"} instead${str(b.refusalReason) ? ` (he had refused ${str(b.city) ?? "it"}: “${str(b.refusalReason)}”)` : ""}`;
    case "mbos.journey.propose":
      return `proposed cities for ${e.from === e.to ? "this day" : `${shortDate(e.from!)}–${shortDate(e.to!)}`}`;
    case "mbos.journey.period":
      return `arranged the shops from the office for ${e.from === e.to ? "this day" : `${shortDate(e.from!)}–${shortDate(e.to!)}`}`;
    default:
      return e.action;
  }
}

function toneText(tone: DayOwed["tone"]): string {
  return tone === "danger"
    ? "text-danger"
    : tone === "warn"
      ? "text-warn-ink"
      : tone === "brand"
        ? "text-[#5223E0]"
        : tone === "success"
          ? "text-success"
          : "text-muted";
}

/* Calendar days, built in UTC: there is no time of day in them to get wrong. */
function utcDay(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...o, timeZone: "UTC" });
const weekday = (iso: string) => fmt({ weekday: "long" }).format(utcDay(iso));
const shortDate = (iso: string) => fmt({ day: "numeric", month: "short" }).format(utcDay(iso));
const longDate = (iso: string) => fmt({ day: "numeric", month: "long", year: "numeric" }).format(utcDay(iso));
const monthShort = (iso: string) => fmt({ month: "short" }).format(utcDay(iso));

/** An instant, as a date and a clock in the business zone. */
function stamp(at: Date | string): string {
  const d = new Date(at);
  return `${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: APP_TIMEZONE }).format(d)}, ${clock(d)}`;
}

function hours(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

