import { MetricRow } from "@/components/console/parts";
import { TodayTable } from "./today-table";
import { plural } from "@/components/console/words";
import type { Salesman, JourneyPlan, VisitRow, TrackPoint } from "@/lib/services/sales-service";
import { formatDistance, metresBetween } from "@/lib/geo";

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
  today,
}: {
  today: string;
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
      km: formatDistance(metres),
      adherencePct,
      note,
      hasFixes: points.length > 0,
      /* What the modal lists: his route and what he actually walked into.
         Plain values, so they cross to the client table. */
      route: plan
        ? plan.stops
            .slice()
            .sort((a, b) => a.sequence - b.sequence)
            .map((st) => ({ id: st.id, name: st.customerName, status: st.status, skipReason: st.skipReason }))
        : [],
      city: plan?.city ?? plan?.shopCities[0] ?? null,
      walked: salesmanVisits
        .slice()
        .sort((a, b) => (a.checkInAt ? new Date(a.checkInAt).getTime() : 0) - (b.checkInAt ? new Date(b.checkInAt).getTime() : 0))
        .map((v) => ({
          id: v.id,
          name: v.customerName,
          at: v.checkInAt ? new Date(v.checkInAt).toISOString() : null,
          outcome: v.outcome,
          wasPlanned: v.wasPlanned,
          verified: v.verified,
        })),
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

      <TodayTable rows={rows} today={today} />
    </div>
  );
}
