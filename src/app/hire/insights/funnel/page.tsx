import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { funnel, insightFilters, rangeOf, RANGES } from "@/lib/hire/services/insights";
import { STAGE_TYPE_LABEL, type StageType } from "@/lib/hire/blueprint-types";
import { DataTable, HBars, hrs, pct } from "../../_charts/charts";
import { Empty, PageHead, Panel, Stat } from "../../_ui/kit";
import { Picks } from "../_ui/picks";

export const dynamic = "force-dynamic";
export const metadata = { title: "Funnel" };

export default async function FunnelPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireHireScreen("funnel");
  const sp = await searchParams;
  const now = nowMs();
  const { roles, locations } = await insightFilters(ctx);
  const range = rangeOf(sp.range);
  const role = roles.find((r) => r.key === sp.role)?.key ?? roles[0]?.key;
  const location = sp.loc && locations.includes(sp.loc) ? sp.loc : undefined;

  const head = <PageHead title="Funnel" sub="Conversion, time in stage and drop-off per stage, by role and location." />;
  if (!role) return <>{head}<Empty title="No candidates yet">The funnel fills in as soon as the first candidate enters a pipeline.</Empty></>;

  const f = await funnel(ctx, { range, bpKey: role, location }, now);
  const title = roles.find((r) => r.key === role)?.title ?? role;
  /* The narrowest step is judged on people whose stage is settled — still being in a stage is not dropping out of it. */
  const settled = (s: (typeof f.stages)[number]) => (s.passed + s.dropped ? s.passed / (s.passed + s.dropped) : 1);
  const worst = f.stages.filter((s) => s.passed + s.dropped >= 5 && s.dropped > 0).sort((a, b) => settled(a) - settled(b))[0];
  const slowest = f.stages.filter((s) => s.medianHours != null && s.slaHours).sort((a, b) => (b.medianHours as number) / b.slaHours - (a.medianHours as number) / a.slaHours)[0];

  return (
    <>
      {head}
      <Picks
        picks={[
          { k: "role", label: "Role", value: role, opts: roles.map((r) => ({ v: r.key, l: `${r.title} (${r.n})` })) },
          { k: "loc", label: "Location", value: location ?? "", opts: [{ v: "", l: "All locations" }, ...locations.map((l) => ({ v: l, l }))] },
          { k: "range", label: "Applied", value: range, opts: RANGES.map((r) => ({ v: r.v, l: r.l })) },
        ]}
      />
      {f.total === 0 ? (
        <Empty title="Nobody applied in this window">Widen the date range or pick another location.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-4 gap-4">
            <Stat label="Entered" value={f.total} sub={`${title}${location ? ` · ${location}` : ""}`} />
            <Stat label="Still in the pipeline" value={f.open} sub="in progress or on hold" />
            <Stat label="Hired" value={f.hired} sub={f.total ? `${pct(f.hired / f.total, 1)} of everyone who entered` : undefined} />
            <Stat label="Median time to hire" value={f.medianDaysToHire == null ? "—" : `${Math.round(f.medianDaysToHire)}d`} sub="application to provisioned account" />
          </div>
          {worst || slowest ? (
            <div className="rounded-[6px] border border-line bg-surface px-4 py-3 text-sm leading-[21px] text-body">
              {worst ? (
                <>
                  The narrowest step is <b className="text-heading">{worst.name}</b>: of the {worst.passed + worst.dropped} whose stage there is settled, {worst.dropped} ended there ({pct(1 - settled(worst))}).{" "}
                </>
              ) : null}
              {slowest && slowest.medianHours != null && slowest.medianHours > slowest.slaHours ? (
                <>
                  <b className="text-heading">{slowest.name}</b> is where the funnel is slow — a median of {hrs(slowest.medianHours)} against a target of {hrs(slowest.slaHours)}.
                </>
              ) : null}
            </div>
          ) : null}
          <Panel title="Reached each stage" sub="How many of the people who applied in this window got at least this far. The figure after it is the share who then moved on.">
            <HBars
              bars={f.stages.map((s) => ({ label: s.name, value: s.reached, display: String(s.reached), sub: s.conversion == null ? undefined : `${pct(s.conversion)} on`, title: `${s.name}: ${s.reached} reached, ${s.passed} moved on, ${s.dropped} ended here, ${s.here} still here` }))}
              labelWidth={200}
            />
          </Panel>
          <Panel
            title="Stage by stage"
            sub="Time in stage runs from when the previous stage was completed (the application, for the first) to this stage's completion. Candidates still in a stage count from when they entered it, so an open stage's figure is a floor. It is measured here for the first time — the AppSheet app kept only dates (D15)."
            pad={false}
          >
            <DataTable
              cols={["Stage", "Type", "Reached", "Moved on", "Conversion", "Ended here", "Still here", "Median time", "Average", "Target", "Over target"]}
              align={["l", "l", "r", "r", "r", "r", "r", "r", "r", "r", "r"]}
              rows={f.stages.map((s) => [
                s.name,
                <span key="t" className="text-muted">{STAGE_TYPE_LABEL[s.type as StageType] ?? s.type}</span>,
                s.reached,
                s.passed,
                pct(s.conversion),
                s.dropped,
                s.here,
                hrs(s.medianHours),
                hrs(s.avgHours),
                s.slaHours ? hrs(s.slaHours) : "—",
                <span key="o" className={s.overSla != null && s.overSla > 0.25 ? "font-medium text-warn-ink" : ""}>{s.overSla == null ? "—" : `${s.overSla > 0.25 ? "▲ " : ""}${pct(s.overSla)}`}</span>,
              ])}
            />
          </Panel>
          {!location ? (
            <Panel title="By location" sub="The same window and role, one row per location." pad={false}>
              <DataTable
                cols={["Location", "Entered", "Still in", "Hired", "Hire rate", "Ended without a hire"]}
                align={["l", "r", "r", "r", "r", "r"]}
                rows={f.byLocation.map((l) => [l.location, l.entered, l.open, l.hired, pct(l.entered ? l.hired / l.entered : null, 1), l.closed])}
              />
            </Panel>
          ) : null}
          <div className="text-xs text-muted">Candidates are counted against the blueprint version they entered under. A candidate who skipped a stage on an override counts as having reached it.</div>
        </div>
      )}
    </>
  );
}
