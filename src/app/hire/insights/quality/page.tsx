import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { insightFilters, quality, rangeOf, RANGES } from "@/lib/hire/services/insights";
import { DataTable, pct, Scatter } from "../../_charts/charts";
import { Callout, PageHead, Panel, Stat } from "../../_ui/kit";
import { Picks } from "../_ui/picks";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quality" };

const rWords = (r: number | null) => {
  if (r == null) return "Too few hires with a performance figure to say — it needs at least five.";
  const a = Math.abs(r);
  const strength = a >= 0.6 ? "a strong" : a >= 0.35 ? "a moderate" : a >= 0.15 ? "a weak" : "no meaningful";
  return `${strength.replace(/^./, (c) => c.toUpperCase())} ${a >= 0.15 ? (r > 0 ? "positive " : "negative ") : ""}relationship (r = ${r.toFixed(2)}). ${
    a < 0.15 ? "The stage scores are not, on this evidence, telling us who performs — a reason to review the rubric, not to trust it more." : r > 0 ? "Higher stage scores have gone with better performance." : "Higher stage scores have gone with WORSE performance — the rubric needs review."
  }`;
};

export default async function QualityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireHireScreen("quality");
  const sp = await searchParams;
  const now = nowMs();
  const { roles } = await insightFilters(ctx);
  const range = sp.range ? rangeOf(sp.range) : "all";
  const role = roles.find((r) => r.key === sp.role)?.key;
  const q = await quality(ctx, { range, bpKey: role }, now);

  return (
    <>
      <PageHead title="Quality" sub="Whether the people hired stay and perform. Score-to-performance correlation feeds rubric review." />
      <Picks
        picks={[
          { k: "role", label: "Role", value: role ?? "", opts: [{ v: "", l: "All roles" }, ...roles.map((r) => ({ v: r.key, l: r.title }))] },
          { k: "range", label: "Applied", value: range, opts: RANGES.map((r) => ({ v: r.v, l: r.l })) },
        ]}
      />
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-4 gap-4">
          <Stat label="Hires" value={q.hires} sub={q.medianDaysToHire == null ? "no hires yet" : `median ${Math.round(q.medianDaysToHire)} days to hire`} />
          <Stat label="Offer acceptance" value={pct(q.acceptance)} sub={q.accepted + q.declined ? `${q.accepted} accepted · ${q.declined} declined` : "no offer answered yet"} />
          {q.windows
            .filter((w) => w.days !== 30)
            .map((w) => (
              <Stat key={w.days} label={`Retention at ${w.days} days`} value={pct(w.rate)} sub={w.measurable ? `${w.stayed} of ${w.measurable} still here${w.tooYoung ? ` · ${w.tooYoung} too recent to measure` : ""}` : "not yet measurable — no hire is that old"} />
            ))}
        </div>
        <Panel title="Stage score against performance" sub="Each dot is one hire: the average of their stage scores, against the performance score recorded after they joined.">
          {q.pairs.length ? (
            <>
              <Scatter points={q.pairs.map((p) => ({ x: p.x, y: p.y, title: `${p.role}: stage average ${p.x}, performance ${p.y}` }))} xLabel="Average stage score" yLabel="Performance after joining" fit={q.fit} xDomain={[50, 100]} />
              <p className="mt-3 mb-0 text-sm text-body">{rWords(q.r)}</p>
            </>
          ) : (
            <p className="m-0 text-sm text-muted">No hire has a performance figure yet. It is recorded once somebody has been in the job long enough to have one.</p>
          )}
        </Panel>
        <Panel title="Retention" sub="A hire is counted for a window only once they have been in the job that long; a younger hire is not yet measurable, never counted as staying." pad={false}>
          <DataTable
            cols={["Window", "Measurable hires", "Still here", "Retention", "Too recent to measure"]}
            align={["l", "r", "r", "r", "r"]}
            rows={q.windows.map((w) => [`${w.days} days`, w.measurable, w.stayed, w.measurable ? pct(w.rate) : "Not yet measurable", w.tooYoung])}
          />
        </Panel>
        <Panel title="By role" pad={false}>
          <DataTable
            cols={["Role", "Hires", "Offer acceptance", "Retention at 90 days", "Median days to hire", "Average performance"]}
            align={["l", "r", "r", "r", "r", "r"]}
            rows={q.byRole.map((r) => [r.role, r.hires, pct(r.acceptance), r.measurable90 ? pct(r.retention90) : "Not yet measurable", r.medianDaysToHire == null ? "—" : Math.round(r.medianDaysToHire), r.avgPerformance == null ? "—" : Math.round(r.avgPerformance)])}
            empty="No applications in this window."
          />
        </Panel>
        {q.r != null && Math.abs(q.r) < 0.15 ? <Callout tone="warn">Stage scores are not predicting performance on this evidence. That is advice to review the rubric — nothing changes on its own.</Callout> : null}
        <div className="text-xs text-muted">Time to first target and the manager’s 90-day satisfaction are recorded on the hire’s outcome as they arrive; offer acceptance counts offers that were issued and answered.</div>
      </div>
    </>
  );
}
