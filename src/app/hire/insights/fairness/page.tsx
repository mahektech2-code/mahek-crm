import { nowMs } from "@/lib/format";
import { redirect } from "next/navigation";
import type { ImpactRow } from "@/lib/hire/engines/fairness";
import { requireHireScreen } from "@/lib/hire/access";
import { FAIR_ATTRS, fairness, insightFilters, rangeOf, RANGES, type FairAttr } from "@/lib/hire/services/insights";
import { DataTable, HBars, pct } from "../../_charts/charts";
import { Callout, Empty, PageHead, Panel, Stat } from "../../_ui/kit";
import { Picks } from "../_ui/picks";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fairness" };

function ratioCell(r: ImpactRow) {
  if (r.small) return <span className="text-muted">Too few to read ({r.entered})</span>;
  if (r.ratio == null) return "—";
  return <span className={r.flagged ? "font-medium text-warn-ink" : ""}>{r.flagged ? "▲ " : ""}{r.ratio.toFixed(2)}</span>;
}

export default async function FairnessPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireHireScreen("fairness");
  if (!ctx.can("bias")) redirect("/hire");
  const sp = await searchParams;
  const now = nowMs();
  const { roles } = await insightFilters(ctx);
  const range = sp.range ? rangeOf(sp.range) : "365";
  const role = roles.find((r) => r.key === sp.role)?.key ?? roles[0]?.key;
  const attr: FairAttr = FAIR_ATTRS.some((a) => a.v === sp.attr) ? (sp.attr as FairAttr) : "gender";
  const head = <PageHead title="Fairness" sub="Selection rates by group at each stage, against the four-fifths line. Aggregate only — never about an individual." />;
  if (!role) return <>{head}<Empty title="Nothing to monitor yet">Selection rates appear once candidates have been scored.</Empty></>;
  const f = await fairness(ctx, { range, bpKey: role, attr }, now);
  const attrLabel = FAIR_ATTRS.find((a) => a.v === attr)!.l.toLowerCase();

  return (
    <>
      {head}
      <Picks
        picks={[
          { k: "role", label: "Role", value: role, opts: roles.map((r) => ({ v: r.key, l: r.title })) },
          { k: "attr", label: "Attribute", value: attr, opts: FAIR_ATTRS.map((a) => ({ v: a.v, l: a.l })) },
          { k: "range", label: "Applied", value: range, opts: RANGES.map((r) => ({ v: r.v, l: r.l })) },
        ]}
      />
      <div className="flex flex-col gap-4">
        {!f.monitored ? <Callout tone="neutral">This blueprint does not switch on adverse-impact monitoring for {attrLabel}. The figures are shown, but nobody is alerted on them.</Callout> : null}
        {f.flagged.length ? (
          <Callout tone="warn">
            {f.flagged.length === 1 ? "One group sits" : `${f.flagged.length} groups sit`} below the {f.threshold.toFixed(2)} line:{" "}
            {f.flagged.map((x) => `${x.group} at ${x.stage} (${x.ratio.toFixed(2)})`).join("; ")}. This is advice to look at the stage and its rubric — no candidate is affected by it, and nothing in the process changes on its own.
          </Callout>
        ) : null}
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Decisions monitored" value={f.decided} sub="stage outcomes, pass or fail" />
          <Stat label="Line" value={f.threshold.toFixed(2)} sub="each group's rate ÷ the highest group's (four-fifths rule)" />
          <Stat label="Below the line" value={f.flagged.length} sub={f.flagged.length ? "advisory — see above" : "no group, at any stage"} />
        </div>
        {f.stages.length === 0 ? (
          <Empty title="No stage outcomes in this window">Widen the date range.</Empty>
        ) : (
          f.stages.map((s) => (
            <Panel key={s.key} title={s.name} sub={`${s.decided} outcomes. Rate is the share of each group that passed; the ratio compares it to the highest group with enough people to read.`}>
              <HBars
                bars={s.rows.map((r) => ({
                  label: r.group,
                  value: r.rate ?? 0,
                  display: r.small ? `${r.entered} — too few` : pct(r.rate),
                  sub: r.small || r.ratio == null ? undefined : `ratio ${r.ratio.toFixed(2)}`,
                  warn: r.flagged,
                  title: `${r.group}: ${r.passed} of ${r.entered} passed`,
                }))}
                max={1}
                labelWidth={160}
              />
              <div className="mt-4 overflow-hidden rounded-[4px] border border-divider">
                <DataTable
                  cols={["Group", "Outcomes", "Passed", "Rate", "Ratio", "AI-scored ratio", "Human-scored ratio"]}
                  align={["l", "r", "r", "r", "r", "r", "r"]}
                  rows={s.rows.map((r) => {
                    const ai = s.ai.find((x) => x.group === r.group);
                    const hu = s.human.find((x) => x.group === r.group);
                    return [r.group, r.entered, r.passed, pct(r.rate), ratioCell(r), ai && ai.entered ? ratioCell(ai) : "—", hu && hu.entered ? ratioCell(hu) : "—"];
                  })}
                />
              </div>
            </Panel>
          ))
        )}
        <div className="text-xs text-muted">
          Groups with fewer than ten outcomes are named but not given a ratio. AI-scored outcomes are stages where at least one answer was scored by the AI and confirmed by a person; human-scored are the rest — shown apart so a divergence between them is visible.
        </div>
      </div>
    </>
  );
}
