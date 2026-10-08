import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { aiUsage, rangeOf, RANGES } from "@/lib/hire/services/insights";
import { DataTable, HBars, pct } from "../../_charts/charts";
import { Callout, Empty, inr, PageHead, Panel, Stat } from "../../_ui/kit";
import { Picks } from "../_ui/picks";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI usage" };

const TASK: Record<string, string> = {
  rubric_score: "Rubric scoring",
  embedding: "Search embeddings",
  cv_parse: "CV parsing",
  consistency: "Consistency check",
  message_draft: "Message drafting",
  blueprint_generate: "Blueprint generation",
  rubric_critic: "Rubric critic",
  document_extract: "Document reading",
  ranking: "Candidate ranking",
  committee_brief: "Committee brief",
};
const STATUS: Record<string, string> = {
  success: "Answered",
  cached: "Answered from cache",
  disabled: "AI off — manual path",
  schema_violation: "Malformed answer — manual path",
  evidence_invalid: "Quotes did not match — discarded",
  prohibited: "Prohibited inference — discarded",
  timeout: "Timed out",
  refused: "Refused",
  error: "Error",
};
const ms = (v: number | null) => (v == null ? "—" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
const tok = (n: number) => n.toLocaleString("en-IN");

export default async function AiUsagePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireHireScreen("aiusage");
  const sp = await searchParams;
  const range = sp.range ? rangeOf(sp.range) : "30";
  const u = await aiUsage(ctx, { range }, nowMs());
  const share = u.budget ? u.spendMonth / u.budget : 0;

  return (
    <>
      <PageHead title="AI usage" sub="Cost, volume, latency and fallbacks for every AI task. Costs are estimates from list prices, not an invoice." />
      <Picks picks={[{ k: "range", label: "Period", value: range, opts: RANGES.map((r) => ({ v: r.v, l: r.l })) }]} />
      <div className="flex flex-col gap-4">
        {share >= 1 ? (
          <Callout tone="danger">This month’s estimated AI spend, {inr(u.spendMonth)}, is past the budget of {inr(u.budget)}. Nothing is blocked — hiring carries on — but somebody should decide whether to raise the budget or move tasks to a cheaper model (Admin Console → Settings → Hire).</Callout>
        ) : share >= 0.8 ? (
          <Callout tone="warn">This month’s estimated AI spend is {pct(share)} of the {inr(u.budget)} budget.</Callout>
        ) : null}
        <div className="grid grid-cols-4 gap-4">
          <Stat label="This month" value={inr(u.spendMonth)} sub={`of a ${inr(u.budget)} budget · estimated`} tone={share >= 1 ? "danger" : share >= 0.8 ? "warn" : undefined} />
          <Stat label="Calls" value={u.calls} sub={u.calls ? `${pct(u.success / u.calls)} answered` : "none in this period"} />
          <Stat label="Per candidate" value={u.perCandidate == null ? "—" : inr(u.perCandidate)} sub={u.candidates ? `across ${u.candidates} candidates · estimated` : undefined} />
          <Stat label="Latency" value={ms(u.p50)} sub={`median · p95 ${ms(u.p95)}`} />
        </div>
        {u.calls === 0 ? (
          <Empty title="No AI calls in this period">
            Every scoring, parsing and drafting call lands here with its model, tokens, latency and an estimated cost — including the ones that fell back to the manual path. If AI is switched off or has no key, Hire runs by hand and says so; the calls it would have made appear here as “AI off”.
          </Empty>
        ) : (
          <>
            <Panel title="By task" pad={false}>
              <DataTable
                cols={["Task", "Calls", "Answered", "Fell back", "Tokens in", "Tokens out", "Median", "p95", "Est. cost"]}
                align={["l", "r", "r", "r", "r", "r", "r", "r", "r"]}
                rows={u.byType.map((r) => [TASK[r.key] ?? r.key, r.calls, r.success, r.fallbacks, tok(r.inTok), tok(r.outTok), ms(r.p50), ms(r.p95), inr(r.cost)])}
              />
            </Panel>
            <div className="grid grid-cols-2 gap-4">
              <Panel title="By role" sub="Calls tied to a candidate or a blueprint.">
                <HBars bars={u.byRole.map((r) => ({ label: r.key, value: r.cost, display: inr(r.cost), sub: `${r.calls} calls${r.apps ? ` · ${inr(Math.round(r.cost / r.apps))} a candidate` : ""}` }))} labelWidth={150} />
              </Panel>
              <Panel title="How calls ended" sub="Every fallback is a manual path somebody took instead.">
                <HBars bars={u.statuses.map((r) => ({ label: STATUS[r.key] ?? r.key, value: r.calls, display: String(r.calls), warn: r.key !== "success" && r.key !== "cached" }))} labelWidth={220} />
              </Panel>
            </div>
          </>
        )}
        <div className="text-xs text-muted">Tokens and cost come from the provider’s usage figures where it gave them; the rupee figure applies list prices per model and is an estimate. The budget alerts — it never stops a hire.</div>
      </div>
    </>
  );
}
