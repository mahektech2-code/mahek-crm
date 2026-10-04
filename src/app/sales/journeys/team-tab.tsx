import Link from "next/link";
import { addDays } from "@/lib/business-date";
import type { Salesman } from "@/lib/services/sales-service";
import type { TeamJourneySummary, TeamPlanDay } from "@/lib/services/journey-service";
import {
  DAY_STATE_LABEL,
  areaAnswerState,
  datesBetween,
} from "@/lib/journey-days";
import { Banner, Empty, MetricRow, RowMenu } from "@/components/console/parts";
import { plural } from "@/components/console/words";

/**
 * THE WHOLE TEAM'S DAYS ON ONE SCREEN, and who owes whom an answer.
 *
 * Opening Journey planning used to land on a salesman picker and a blank card
 * — the one screen a manager opens to find out who is going where showed
 * nobody going anywhere until he chose a name, and then only a week forward.
 * This is the answer before any choice: for every salesman, the areas he was
 * allocated and whether he accepted them, today's city, the fortnight ahead
 * day by day, what is waiting on whom, and what the last thirty days came to —
 * shops allocated against shops visited, and the visits off the route.
 */

const AHEAD = 14;
const BEHIND = 30;

export function teamWindow(today: string): { from: string; to: string } {
  return { from: addDays(today, -(BEHIND - 1)), to: addDays(today, AHEAD - 1) };
}

export function TeamTab({
  team,
  summary,
  today,
}: {
  team: Salesman[];
  summary: TeamJourneySummary;
  today: string;
}) {
  const active = team.filter((t) => t.active);
  const ahead = datesBetween(today, addDays(today, AHEAD - 1));
  const tomorrow = addDays(today, 1);
  const holiday = new Map(summary.holidays.map((h) => [h.onDate, h.name]));

  const rows = active.map((t) => {
    const plans = summary.plans.filter((p) => p.userId === t.id);
    const visits = summary.visits.filter((v) => v.userId === t.id);
    const leave = summary.leave.filter((l) => l.userId === t.id);
    const onLeave = (d: string) => leave.find((l) => l.fromDate <= d && l.toDate >= d) ?? null;
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
      onLeave,
      refused: future.filter((p) => p.dayState === "refused"),
      proposed: future.filter((p) => p.dayState === "proposed"),
      agreed: future.filter((p) => p.dayState === "agreed"),
      bareTomorrow: !plans.some((p) => p.planDate === tomorrow) && !onLeave(tomorrow) && !holiday.has(tomorrow),
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

  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0);
  const refused = rows.flatMap((r) => r.refused.map((p) => ({ r, p })));
  const areaAsks = rows.filter((r) => r.area.key === "change-pending");
  const areaGaps = rows.filter((r) => r.area.key === "none-allocated");
  const teamAllocated = sum((r) => r.allocated);

  return (
    <div>
      <MetricRow
        metrics={[
          {
            label: "Waiting on you",
            value: String(refused.length + areaAsks.length),
            sub: `${plural(refused.length, "refused day")} · ${plural(areaAsks.length, "area change")}`,
            tone: refused.length + areaAsks.length ? "danger" : undefined,
          },
          {
            label: "Waiting on them",
            value: String(sum((r) => r.proposed.length + r.agreed.length)),
            sub: `${sum((r) => r.proposed.length)} to answer · ${sum((r) => r.agreed.length)} to pick shops`,
            tone: sum((r) => r.proposed.length + r.agreed.length) ? "warn" : undefined,
          },
          {
            label: "Nothing tomorrow",
            value: String(rows.filter((r) => r.bareTomorrow).length),
            sub: `of ${active.length} in the field`,
            tone: rows.some((r) => r.bareTomorrow) ? "warn" : "success",
          },
          {
            label: `Last ${BEHIND} days`,
            value: teamAllocated ? `${Math.round((sum((r) => r.visited) / teamAllocated) * 100)}%` : "—",
            sub: `${sum((r) => r.visited)} of ${teamAllocated} allocated shops visited`,
          },
          {
            label: "Off the route",
            value: String(sum((r) => r.offPlan)),
            sub: `of ${sum((r) => r.visits)} visits`,
          },
        ]}
      />

      {refused.length ? (
        <Banner
          tone="danger"
          title={`${plural(refused.length, "day")} came back refused`}
          body={
            <span className="flex flex-col gap-0.5">
              {refused.slice(0, 6).map(({ r, p }) => (
                <Link
                  key={p.planId}
                  href={dayHref(r.t.id, p.planDate)}
                  className="text-[13px] text-body no-underline hover:underline"
                >
                  <span className="font-medium text-ink">{r.t.name}</span> · {shortDate(p.planDate)} ·{" "}
                  {p.city} — “{p.refusalReason}”{p.counterCity ? `, wants ${p.counterCity}` : ""}
                </Link>
              ))}
              {refused.length > 6 ? <span className="text-muted">and {refused.length - 6} more</span> : null}
            </span>
          }
        />
      ) : null}

      {areaAsks.length || areaGaps.length ? (
        <Banner
          tone="warn"
          title="Areas"
          body={
            <span className="flex flex-col gap-0.5">
              {areaAsks.map((r) => (
                <span key={r.t.id}>
                  <span className="font-medium text-ink">{r.t.name}</span>: {r.area.text}
                  {r.t.areaAnswer?.reason ? ` — “${r.t.areaAnswer.reason}”` : ""} ·{" "}
                  <Link href="/sales/approvals" className="text-brand no-underline hover:underline">
                    decide it
                  </Link>
                </span>
              ))}
              {areaGaps.map((r) => (
                <span key={r.t.id}>
                  <span className="font-medium text-ink">{r.t.name}</span> has no area allocated, so his handset shows
                  no shops ·{" "}
                  <Link href={`/sales/people/${r.t.id}`} className="text-brand no-underline hover:underline">
                    allocate one
                  </Link>
                </span>
              ))}
            </span>
          }
        />
      ) : null}

      {rows.length === 0 ? (
        <Empty title="Nobody in the field" body="No active salesman holds the Salesman App yet." />
      ) : (
        <div className="overflow-x-auto rounded-[6px] border border-line bg-surface">
          <table className="w-full min-w-[1080px] border-collapse text-[13px]">
            <thead className="border-b border-line bg-canvas">
              <tr>
                {[
                  ["Salesman", "w-[170px]"],
                  ["Areas allocated", "w-[190px]"],
                  ["Today", "w-[140px]"],
                  [`Next ${AHEAD} days`, ""],
                  ["Waiting", "w-[130px]"],
                  [`Last ${BEHIND} days`, "w-[160px]"],
                  ["", "w-[44px]"],
                ].map(([h, w]) => (
                  <th
                    key={h || "menu"}
                    className={`px-3 py-2 text-left text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase ${w}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.t.id} className="border-b border-divider align-top last:border-0 hover:bg-canvas/60">
                  <td className="px-3 py-2.5">
                    <Link
                      href={`/sales/journeys?tab=salesman&salesman=${r.t.id}`}
                      className="flex items-center gap-2.5 no-underline"
                    >
                      <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-[#5223E0]">
                        {r.t.initials}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-ink hover:text-brand">{r.t.name}</span>
                        <span className="block text-[11px] text-muted">
                          {plural(Number(r.t.customerCount), "shop")}
                        </span>
                      </span>
                    </Link>
                  </td>

                  <td className="px-3 py-2.5">
                    <span className="block truncate text-body" title={areaList(r.t)}>
                      {areaList(r.t) || <span className="text-muted">None</span>}
                    </span>
                    <span className={"block text-[11px] " + toneText(r.area.tone)} title={r.t.areaAnswer?.reason ?? undefined}>
                      {r.area.text}
                    </span>
                  </td>

                  <td className="px-3 py-2.5">
                    {r.today ? (
                      <>
                        <span className="block truncate font-medium text-ink">{r.today.city ?? "—"}</span>
                        <span className="block text-[11px] text-muted">
                          {r.today.dayState === "planned"
                            ? `${r.today.visited}/${r.today.stops} visited${r.today.skipped ? ` · ${r.today.skipped} skipped` : ""}`
                            : DAY_STATE_LABEL[r.today.dayState]}
                          {r.todayVisits?.offPlan ? ` · +${r.todayVisits.offPlan} off route` : ""}
                        </span>
                      </>
                    ) : r.onLeave(today) ? (
                      <span className="text-muted">On leave</span>
                    ) : holiday.has(today) ? (
                      <span className="text-muted">Holiday</span>
                    ) : (
                      <span className="text-muted">
                        Nothing planned
                        {r.todayVisits ? ` · ${plural(r.todayVisits.visits, "visit")}` : ""}
                      </span>
                    )}
                  </td>

                  <td className="px-3 py-2.5">
                    <span className="flex gap-[2px]">
                      {ahead.map((d) => {
                        const p = r.byDay.get(d);
                        const leave = r.onLeave(d);
                        const off = holiday.get(d);
                        return (
                          <Link
                            key={d}
                            href={dayHref(r.t.id, d)}
                            title={`${shortDate(d)} — ${dayTitle(p, leave?.state ?? null, off ?? null)}`}
                            className={
                              "flex h-9 w-[28px] flex-none flex-col items-center justify-center rounded-[3px] text-[10px] leading-3 no-underline hover:no-underline hover:ring-1 hover:ring-brand " +
                              cellSkin(p, Boolean(leave), Boolean(off), d === today)
                            }
                          >
                            <span className="font-medium">{Number(d.slice(8))}</span>
                            <span className="w-full truncate px-0.5 text-center">
                              {p?.city ? p.city.slice(0, 4) : leave ? "lv" : off ? "hol" : ""}
                            </span>
                          </Link>
                        );
                      })}
                    </span>
                  </td>

                  <td className="px-3 py-2.5 text-[12px]">
                    {r.refused.length ? (
                      <span className="block text-danger">{plural(r.refused.length, "refusal")} for you</span>
                    ) : null}
                    {r.proposed.length ? (
                      <span className="block text-warn-ink">{r.proposed.length} for him to answer</span>
                    ) : null}
                    {r.agreed.length ? (
                      <span className="block text-[#5223E0]">{r.agreed.length} to pick shops</span>
                    ) : null}
                    {r.bareTomorrow ? <span className="block text-muted">Nothing tomorrow</span> : null}
                    {!r.refused.length && !r.proposed.length && !r.agreed.length && !r.bareTomorrow ? (
                      <span className="text-muted">Nothing</span>
                    ) : null}
                  </td>

                  <td className="px-3 py-2.5 text-[12px]">
                    {r.allocated ? (
                      <>
                        <span className="flex items-center gap-2">
                          <span className="block h-1.5 w-[64px] overflow-hidden rounded-[3px] bg-divider">
                            <span
                              className={
                                "block h-full " +
                                (r.adherence! >= 80 ? "bg-success" : r.adherence! >= 50 ? "bg-warn" : "bg-danger")
                              }
                              style={{ width: `${r.adherence}%` }}
                            />
                          </span>
                          <span className="text-ink tabular-nums">{r.adherence}%</span>
                        </span>
                        <span className="block text-muted">
                          {r.visited}/{r.allocated} shops · {plural(r.daysWalked, "day")}
                        </span>
                        {r.missed ? <span className="block text-danger">{r.missed} missed, no reason</span> : null}
                      </>
                    ) : (
                      <span className="block text-muted">No route walked</span>
                    )}
                    <span className="block text-muted">
                      {plural(r.visits, "visit")}
                      {r.offPlan ? ` · ${r.offPlan} off route` : ""}
                      {r.unverified ? ` · ${r.unverified} unverified` : ""}
                    </span>
                  </td>

                  <td className="px-2 py-2.5 text-right">
                    <RowMenu
                      items={[
                        { label: "His calendar", href: `/sales/journeys?tab=salesman&salesman=${r.t.id}` },
                        { label: "His days as a list", href: `/sales/journeys?tab=salesman&salesman=${r.t.id}&view=list` },
                        { label: "Propose days", href: `/sales/journeys?tab=salesman&salesman=${r.t.id}&view=propose` },
                        { label: "Today's visits", href: `/sales/journeys?tab=visits&salesman=${r.t.id}` },
                        { label: "His trail today", href: "/sales/live?view=today" },
                        { label: "Change his areas", href: `/sales/people/${r.t.id}` },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[12px] text-muted">
        Each square is a day; the letters are the start of its city. Green is a route ready or walked, amber a city
        waiting on his answer, red one he refused, violet one he agreed and has not picked shops for. Click a square to
        open that day.
      </p>
    </div>
  );
}

function areaList(t: Salesman): string {
  return t.territories
    .filter((a) => a.kind !== "region")
    .map((a) => a.value)
    .join(", ");
}

function dayHref(salesmanId: string, date: string) {
  return `/sales/journeys?tab=salesman&salesman=${salesmanId}&month=${date.slice(0, 7)}&open=${date}`;
}

function dayTitle(p: TeamPlanDay | undefined, leave: string | null, holiday: string | null): string {
  if (!p) return leave ? `on leave (${leave})` : holiday ? `holiday — ${holiday}` : "nothing planned";
  const where = p.city ?? "no city";
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

function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}
