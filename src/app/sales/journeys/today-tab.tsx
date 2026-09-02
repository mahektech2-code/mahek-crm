import {
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  RowMenu,
  Table,
} from "../parts";
import { plural } from "../words";
import type { Salesman, JourneyPlan, VisitRow, TrackPoint } from "@/lib/services/sales-service";
import { metresBetween } from "@/lib/geo";

/**
 * How today actually went, one row per salesman.
 *
 * From `MBOS Manager Console.dc.html`'s Journey planning screen — the one tab
 * of its four the design actually wired with real data (`jRows`/`jBeats`).
 * The other three (Refusals, Plan, Routes) are markup only in that file, with
 * nothing behind them; `journeys-screen.tsx` already covers proposing days
 * AND answering refusals in one considered flow, so this adds what the
 * design's Today tab has and the rest of the screen does not — a same-day
 * read of who worked their plan.
 *
 * "Distance" is the GPS trail's own length: the sum of the gaps between
 * consecutive fixes `tracksForDay` already returns, not a new measurement —
 * the same honesty rule as everywhere else GPS shows up here, including that
 * a stale or absent fix says so rather than being papered over with zero.
 */
export function TodayTab({
  team,
  plans,
  visits,
  tracks,
}: {
  team: Salesman[];
  plans: JourneyPlan[];
  visits: VisitRow[];
  tracks: Map<string, TrackPoint[]>;
}) {
  const active = team.filter((t) => t.active);

  const rows = active.map((t) => {
    const plan = plans.find((p) => p.userId === t.id) ?? null;
    const planned = plan?.dayState === "planned" ? plan.stops.length : 0;
    const done = plan ? plan.stops.filter((s) => s.status === "visited").length : 0;
    const skipped = plan ? plan.stops.filter((s) => s.status === "skipped").length : 0;
    const salesmanVisits = visits.filter((v) => v.salesmanId === t.id);
    const offPlan = salesmanVisits.filter((v) => !v.wasPlanned).length;
    const unverified = salesmanVisits.filter((v) => !v.verified).length;

    const points = (tracks.get(t.id) ?? []).slice().sort((a, b) => a.at.getTime() - b.at.getTime());
    let metres = 0;
    for (let i = 1; i < points.length; i++) {
      metres += metresBetween(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    }

    const adherencePct = planned ? Math.round((done / planned) * 100) : null;

    const note = !plan
      ? "Nothing planned"
      : unverified
        ? `${plural(unverified, "visit")} unverified`
        : offPlan
          ? `${plural(offPlan, "off-plan visit")}`
          : skipped
            ? `${plural(skipped, "stop")} skipped`
            : "—";

    return {
      id: t.id,
      name: t.name,
      initials: t.initials,
      planned,
      done,
      offPlan,
      km: metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : metres ? `${Math.round(metres)} m` : "—",
      adherencePct,
      note,
      hasFixes: points.length > 0,
    };
  });

  const totals = rows.reduce(
    (a, r) => ({
      planned: a.planned + r.planned,
      done: a.done + r.done,
      offPlan: a.offPlan + r.offPlan,
      withFixes: a.withFixes + (r.hasFixes ? 1 : 0),
    }),
    { planned: 0, done: 0, offPlan: 0, withFixes: 0 },
  );

  return (
    <div>
      <MetricRow
        metrics={[
          { label: "Tracked today", value: `${totals.withFixes} of ${active.length}` },
          { label: "Planned stops", value: String(totals.planned) },
          {
            label: "Worked",
            value: String(totals.done),
            sub: totals.offPlan ? `Off-plan ${totals.offPlan}` : undefined,
          },
          {
            label: "Team adherence",
            value: totals.planned ? `${Math.round((totals.done / totals.planned) * 100)}%` : "—",
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty title="Nobody in the field" body="No active salesman holds the Salesman App yet." />
      ) : (
        <Table
          minWidth={980}
          head={
            <>
              <HeadCell width={190}>Salesman</HeadCell>
              <HeadCell width={110}>Stops</HeadCell>
              <HeadCell align="right" width={100}>Off plan</HeadCell>
              <HeadCell align="right" width={100}>Distance</HeadCell>
              <HeadCell width={120}>Adherence</HeadCell>
              <HeadCell>What happened</HeadCell>
              <HeadCell width={44} />
            </>
          }
        >
          {rows.map((r, i) => (
            <tr key={r.id} className={i % 2 === 1 ? "bg-canvas" : "bg-surface"}>
              <Cell truncate={190}>
                <span className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-[#5223E0]">
                    {r.initials}
                  </span>
                  <span className="font-medium text-ink">{r.name}</span>
                </span>
              </Cell>
              <Cell>
                {r.done} of {r.planned || "—"}
              </Cell>
              <Cell align="right">{r.offPlan}</Cell>
              <Cell align="right">{r.km}</Cell>
              <Cell>
                {r.adherencePct === null ? (
                  <span className="text-muted">—</span>
                ) : (
                  <span className="flex items-center gap-2">
                    <span className="block h-1.5 w-[70px] overflow-hidden rounded-[3px] bg-canvas">
                      <span
                        className={
                          "block h-full rounded-[3px] " +
                          (r.adherencePct >= 80
                            ? "bg-success"
                            : r.adherencePct >= 50
                              ? "bg-warn"
                              : "bg-danger")
                        }
                        style={{ width: `${Math.min(100, r.adherencePct)}%` }}
                      />
                    </span>
                    <span className="tabular-nums text-ink">{r.adherencePct}%</span>
                  </span>
                )}
              </Cell>
              <Cell truncate={280} className={r.note === "—" ? "text-muted" : undefined}>
                {r.note}
              </Cell>
              <Cell align="right">
                <RowMenu
                  items={[
                    { label: "See the route on a map", href: "/sales/live" },
                    { label: "This person's plan", href: `/sales/journeys?tab=plan&salesman=${r.id}` },
                    { label: "Assign a task", href: "/sales/tasks" },
                  ]}
                />
              </Cell>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
