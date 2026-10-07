"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { addDays } from "@/lib/business-date";
import type { Salesman } from "@/lib/services/sales-service";
import type { TeamJourneySummary, TeamPlanDay } from "@/lib/services/journey-service";
import { DAY_STATE_LABEL, areaAnswerState, datesBetween, dayWhere } from "@/lib/journey-days";
import { Cell, Empty, HeadCell, Row, Table } from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { CardGrid } from "@/components/ui/card-grid";
import { cx } from "@/components/ui/primitives";

/**
 * THE WHOLE TEAM'S DAYS ON ONE SCREEN, and who owes whom an answer.
 *
 * Four figures, a short list of what needs the manager, and one row per
 * salesman that fits the screen: his areas, today, the week ahead as seven
 * squares, what is waiting and the last thirty days. A row opens the whole of
 * him over this list — his month as a calendar or a list, every day's drawer,
 * proposing days and his visit log — so the table never needs scrolling
 * sideways and nothing is a page away.
 */

/* The window itself is `teamWindow` in page.tsx, which reads it on the
   server; these must sit inside it. */
const STRIP = 7;
const BEHIND = 30;

type Leave = TeamJourneySummary["leave"][number];

type TeamRow = {
  t: Salesman;
  area: ReturnType<typeof areaAnswerState>;
  today: TeamPlanDay | null;
  todayVisits: TeamJourneySummary["visits"][number] | null;
  byDay: Map<string, TeamPlanDay>;
  leaveOn: (d: string) => Leave | null;
  refused: TeamPlanDay[];
  proposed: TeamPlanDay[];
  agreed: TeamPlanDay[];
  bareTomorrow: boolean;
  allocated: number;
  visited: number;
  skipped: number;
  missed: number;
  adherence: number | null;
  offPlan: number;
  visits: number;
  unverified: number;
  daysWalked: number;
};

export function TeamTab({
  team,
  summary,
  today,
}: {
  team: Salesman[];
  summary: TeamJourneySummary;
  today: string;
}) {
  const router = useRouter();
  const openPerson = (id: string) => router.push(personHref(id), { scroll: false });

  const active = team.filter((t) => t.active);
  const tomorrow = addDays(today, 1);
  const holiday = new Map(summary.holidays.map((h) => [h.onDate, h.name]));

  const rows: TeamRow[] = active.map((t) => {
    const plans = summary.plans.filter((p) => p.userId === t.id);
    const visits = summary.visits.filter((v) => v.userId === t.id);
    const leave = summary.leave.filter((l) => l.userId === t.id);
    const leaveOn = (d: string) => leave.find((l) => l.fromDate <= d && l.toDate >= d) ?? null;
    const future = plans.filter((p) => p.planDate >= today);
    const past = plans.filter((p) => p.planDate < today);

    let allocated = 0;
    let visited = 0;
    let skipped = 0;
    let missed = 0;
    for (const p of past.filter((p) => p.dayState === "planned")) {
      allocated += p.stops;
      visited += p.visited;
      skipped += p.skipped;
      missed += p.stops - p.visited - p.skipped;
    }
    const pastVisits = visits.filter((v) => v.day < today);
    return {
      t,
      area: areaAnswerState(t.territories, t.areaAnswer),
      today: plans.find((p) => p.planDate === today) ?? null,
      todayVisits: visits.find((v) => v.day === today) ?? null,
      byDay: new Map(plans.map((p) => [p.planDate, p])),
      leaveOn,
      refused: future.filter((p) => p.dayState === "refused"),
      proposed: future.filter((p) => p.dayState === "proposed"),
      agreed: future.filter((p) => p.dayState === "agreed"),
      bareTomorrow: !plans.some((p) => p.planDate === tomorrow) && !leaveOn(tomorrow) && !holiday.has(tomorrow),
      allocated,
      visited,
      skipped,
      missed,
      adherence: allocated ? Math.round((visited / allocated) * 100) : null,
      offPlan: pastVisits.reduce((n, v) => n + v.offPlan, 0),
      visits: pastVisits.reduce((n, v) => n + v.visits, 0),
      unverified: pastVisits.reduce((n, v) => n + v.unverified, 0),
      daysWalked: past.filter((p) => p.dayState === "planned" && p.stops).length,
    };
  });

  const sum = (f: (r: TeamRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const teamAllocated = sum((r) => r.allocated);
  const waitingOnYou = sum((r) => r.refused.length) + rows.filter((r) => r.area.key === "change-pending").length;
  const waitingOnThem = sum((r) => r.proposed.length + r.agreed.length);
  const bare = rows.filter((r) => r.bareTomorrow).length;

  /* What needs the manager, one line each — the old banners, without the prose. */
  const needs = rows.flatMap((r) => [
    ...r.refused.map((p) => ({
      key: `r:${p.planId}`,
      id: r.t.id,
      tone: "danger" as const,
      who: r.t.name,
      what: `refused ${shortDate(p.planDate)}${p.city ? ` · ${p.city}` : ""}`,
    })),
    ...(r.area.key === "change-pending"
      ? [{ key: `a:${r.t.id}`, id: r.t.id, tone: "warn" as const, who: r.t.name, what: "asked for different areas" }]
      : []),
    ...(r.area.key === "none-allocated"
      ? [{ key: `n:${r.t.id}`, id: r.t.id, tone: "warn" as const, who: r.t.name, what: "has no area allocated" }]
      : []),
  ]);

  const strip = datesBetween(today, addDays(today, STRIP - 1));

  return (
    <div className="space-y-4">
      <CardGrid min={170} gap="gap-3">
        <Tile label="Waiting on you" value={String(waitingOnYou)} tone={waitingOnYou ? "danger" : undefined} />
        <Tile label="Waiting on them" value={String(waitingOnThem)} tone={waitingOnThem ? "warn" : undefined} />
        <Tile label="Nothing tomorrow" value={`${bare} of ${active.length}`} tone={bare ? "warn" : undefined} />
        <Tile
          label={`Route kept · ${BEHIND} days`}
          value={teamAllocated ? `${Math.round((sum((r) => r.visited) / teamAllocated) * 100)}%` : "—"}
          sub={teamAllocated ? `${sum((r) => r.visited)} of ${teamAllocated} shops` : undefined}
        />
      </CardGrid>

      {needs.length ? (
        <section className="rounded-[6px] border border-line bg-surface">
          <div className="border-b border-divider px-4 py-2.5 text-[13px] font-semibold text-ink">
            Needs you <span className="ml-1 font-normal text-muted">{needs.length}</span>
          </div>
          <ul className="divide-y divide-divider">
            {needs.slice(0, 8).map((n) => (
              <li key={n.key}>
                <button
                  type="button"
                  onClick={() => openPerson(n.id)}
                  className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13px] hover:bg-canvas"
                >
                  <span
                    className={cx("block size-2 flex-none rounded-full", n.tone === "danger" ? "bg-danger" : "bg-warn")}
                  />
                  <span className="font-medium text-ink">{n.who}</span>
                  <span className="truncate text-muted">{n.what}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <Empty title="Nobody in the field" body="No active salesman holds the Salesman App yet." />
      ) : (
        <Table
          minWidth={910}
          head={
            <>
              <HeadCell width={200}>Salesman</HeadCell>
              <HeadCell width={140}>Areas</HeadCell>
              <HeadCell width={150}>Today</HeadCell>
              <HeadCell width={180}>Next {STRIP} days</HeadCell>
              <HeadCell width={140}>Waiting</HeadCell>
              <HeadCell width={100}>Last {BEHIND} days</HeadCell>
            </>
          }
        >
          {rows.map((r, i) => {
            const areas = areaNames(r.t);
            return (
              <Row key={r.t.id} striped={i % 2 === 1} onClick={() => openPerson(r.t.id)}>
                <Cell>
                  <span className="flex items-center gap-2.5">
                    <Avatar initials={r.t.initials} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{r.t.name}</span>
                      <span className="block text-[11px] text-muted">{plural(Number(r.t.customerCount), "shop")}</span>
                    </span>
                  </span>
                </Cell>
                <Cell title={areas.join(", ")}>
                  <span className="block truncate text-body">
                    {areas.length ? (
                      <>
                        {areas[0]}
                        {areas.length > 1 ? <span className="text-muted"> +{areas.length - 1}</span> : null}
                      </>
                    ) : (
                      <span className="text-muted">None</span>
                    )}
                  </span>
                  <span className={cx("block truncate text-[11px]", toneText(r.area.tone))}>{shortArea(r.area.key)}</span>
                </Cell>
                <Cell>
                  <TodayLine r={r} today={today} holiday={holiday.get(today) ?? null} />
                </Cell>
                <Cell>
                  <span className="flex gap-[3px]">
                    {strip.map((d) => {
                      const p = r.byDay.get(d);
                      return (
                        <span
                          key={d}
                          title={`${shortDate(d)} — ${dayTitle(p, r.leaveOn(d)?.state ?? null, holiday.get(d) ?? null)}`}
                          className={cx(
                            "flex h-7 w-[20px] flex-none items-center justify-center rounded-[3px] text-[10px] font-medium",
                            cellSkin(p, Boolean(r.leaveOn(d)), holiday.has(d), d === today),
                          )}
                        >
                          {Number(d.slice(8))}
                        </span>
                      );
                    })}
                  </span>
                </Cell>
                <Cell>
                  <WaitingChips r={r} />
                </Cell>
                <Cell>
                  {r.adherence == null ? (
                    <span className="text-[12px] text-muted">No route</span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <Bar pct={r.adherence} />
                      <span className="text-[12px] text-ink tabular-nums">{r.adherence}%</span>
                    </span>
                  )}
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}

      <Legend />

    </div>
  );
}

function TodayLine({ r, today, holiday }: { r: TeamRow; today: string; holiday: string | null }) {
  if (r.today) {
    const where = dayWhere(r.today).text ?? "No city";
    return (
      <>
        <span className="block truncate font-medium text-ink">{where}</span>
        <span className="block truncate text-[11px] text-muted">
          {r.today.dayState === "planned"
            ? `${r.today.visited}/${r.today.stops} visited`
            : DAY_STATE_LABEL[r.today.dayState]}
          {r.todayVisits?.offPlan ? ` · +${r.todayVisits.offPlan} off route` : ""}
        </span>
      </>
    );
  }
  const label = r.leaveOn(today) ? "On leave" : holiday ? "Holiday" : "Nothing planned";
  return (
    <>
      <span className="block text-muted">{label}</span>
      {r.todayVisits ? (
        <span className="block text-[11px] text-muted">{plural(r.todayVisits.visits, "visit")}</span>
      ) : null}
    </>
  );
}

function WaitingChips({ r }: { r: TeamRow }) {
  const chips: Array<{ n: number; cls: string; title: string }> = [
    { n: r.refused.length, cls: "bg-danger-soft text-danger", title: "refused — yours to answer" },
    { n: r.proposed.length, cls: "bg-warn-soft text-warn-ink", title: "proposed — his to answer" },
    { n: r.agreed.length, cls: "bg-brand-soft text-[#5223E0]", title: "agreed — shops not picked" },
  ].filter((c) => c.n > 0);
  if (!chips.length) {
    return r.bareTomorrow ? (
      <span className="text-[12px] text-warn-ink">Nothing tomorrow</span>
    ) : (
      <span className="text-[12px] text-muted">—</span>
    );
  }
  return (
    <span className="flex gap-1">
      {chips.map((c) => (
        <span key={c.title} title={`${c.n} ${c.title}`} className={cx("rounded-[9px] px-2 text-[11px] font-semibold tabular-nums", c.cls)}>
          {c.n}
        </span>
      ))}
    </span>
  );
}

function Legend() {
  const items = [
    ["bg-success-soft", "Route set"],
    ["bg-brand-soft", "Agreed, no shops"],
    ["bg-warn-soft", "Awaiting his answer"],
    ["bg-danger-soft", "Refused"],
    ["bg-divider", "Leave / holiday"],
  ];
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
      {items.map(([cls, label]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className={cx("block size-2.5 rounded-[2px]", cls)} />
          {label}
        </span>
      ))}
      <span>Click a salesman for his detail.</span>
    </p>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "danger" | "warn" }) {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-4 py-3">
      <div className="text-[12px] text-muted">{label}</div>
      <div
        className={cx(
          "mt-0.5 text-[22px] leading-7 font-semibold tabular-nums",
          tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn-ink" : "text-ink",
        )}
      >
        {value}
      </div>
      {sub ? <div className="text-[12px] text-muted">{sub}</div> : null}
    </div>
  );
}




function Avatar({ initials, size = "md" }: { initials: string; size?: "md" | "lg" }) {
  return (
    <span
      className={cx(
        "flex flex-none items-center justify-center rounded-full bg-brand-soft font-semibold text-[#5223E0]",
        size === "lg" ? "size-10 text-[13px]" : "size-7 text-[11px]",
      )}
    >
      {initials}
    </span>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <span className="block h-1.5 w-[44px] overflow-hidden rounded-[3px] bg-divider">
      <span
        className={cx("block h-full", pct >= 80 ? "bg-success" : pct >= 50 ? "bg-warn" : "bg-danger")}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </span>
  );
}

/* ---------------------------------------------------------------- helpers */

function areaNames(t: Salesman): string[] {
  return t.territories.filter((a) => a.kind !== "region").map((a) => a.value);
}

/** The area state in two or three words, for a table cell. The modal has the sentence. */
function shortArea(key: ReturnType<typeof areaAnswerState>["key"]): string {
  switch (key) {
    case "none-allocated":
      return "Not allocated";
    case "unanswered":
      return "Not answered";
    case "accepted":
      return "Accepted";
    case "accepted-earlier":
      return "Accepted earlier set";
    case "change-pending":
      return "Asked to change";
    case "change-approved":
      return "Change approved";
    case "change-declined":
      return "Change declined";
  }
}


/** His whole month and visit log, opened over this list. */
function personHref(salesmanId: string) {
  return `/sales/journeys?tab=salesman&salesman=${salesmanId}&in=team`;
}

function dayTitle(p: TeamPlanDay | undefined, leave: string | null, holiday: string | null): string {
  if (!p) return leave ? `on leave (${leave})` : holiday ? `holiday — ${holiday}` : "nothing planned";
  const w = dayWhere(p);
  const where = w.text ? (w.fromShops ? `${w.text} (from the shops)` : w.text) : "no city";
  if (p.dayState === "planned") return `${where} · ${p.stops} shops, ${p.visited} visited`;
  if (p.dayState === "refused") return `${where} · refused: ${p.refusalReason ?? ""}`;
  return `${where} · ${DAY_STATE_LABEL[p.dayState].toLowerCase()}${p.selfPlanned ? " (his own)" : ""}`;
}

function cellSkin(p: TeamPlanDay | undefined, leave: boolean, holiday: boolean, isToday: boolean): string {
  const ring = isToday ? "ring-1 ring-brand " : "";
  if (!p) return ring + (leave || holiday ? "bg-divider text-muted" : "border border-dashed border-line text-muted");
  switch (p.dayState) {
    case "planned":
      return ring + "bg-success-soft text-success";
    case "agreed":
      return ring + "bg-brand-soft text-[#5223E0]";
    case "proposed":
      return ring + "bg-warn-soft text-warn-ink";
    case "refused":
      return ring + "bg-danger-soft text-danger";
  }
}

function toneText(tone: string): string {
  return tone === "danger"
    ? "text-danger"
    : tone === "warn"
      ? "text-warn-ink"
      : tone === "success"
        ? "text-success"
        : "text-muted";
}

/*
 * Dates are spelled by hand, not with Intl. This is a client component and
 * it is rendered twice — on the server and in the browser — and the two ICU
 * builds disagree about punctuation ("Mon 12 Oct" against "Mon, 12 Oct"),
 * which React reports as a hydration mismatch on every square.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return { weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()], day: d, month: MONTHS[m - 1] };
}

/** "Mon 12 Oct". */
function shortDate(iso: string): string {
  const p = parts(iso);
  return `${p.weekday} ${p.day} ${p.month}`;
}

