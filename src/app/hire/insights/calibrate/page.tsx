import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { calibration, insightFilters, rangeOf, RANGES } from "@/lib/hire/services/insights";
import { DataTable, pct, Strips } from "../../_charts/charts";
import { Empty, PageHead, Panel, Pill, Stat } from "../../_ui/kit";
import { Picks } from "../_ui/picks";

export const dynamic = "force-dynamic";
export const metadata = { title: "Calibrate" };

export default async function CalibratePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireHireScreen("calibrate");
  const sp = await searchParams;
  const now = nowMs();
  const { roles } = await insightFilters(ctx);
  const range = sp.range ? rangeOf(sp.range) : "180";
  const role = roles.find((r) => r.key === sp.role)?.key;
  const c = await calibration(ctx, { range, bpKey: role }, now);

  return (
    <>
      <PageHead title="Calibrate" sub="How each interviewer scores against the panel. For development conversations, not surveillance." />
      <Picks
        picks={[
          { k: "role", label: "Role", value: role ?? "", opts: [{ v: "", l: "All roles" }, ...roles.map((r) => ({ v: r.key, l: r.title }))] },
          { k: "range", label: "Applied", value: range, opts: RANGES.map((r) => ({ v: r.v, l: r.l })) },
        ]}
      />
      {c.n === 0 ? (
        <Empty title="No confirmed stage scores in this window">Calibration needs completed, scored stages.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-4 gap-4">
            <Stat label="Panel mean" value={c.panelMean ?? "—"} sub={`${c.n} scored stages`} />
            <Stat label="Interviewers" value={c.rows.length} />
            <Stat label="Grace used" value={c.graceUses} sub={c.n ? `${pct(c.graceUses / c.n)} of stages` : undefined} />
            <Stat label="Outcomes changed by grace" value={c.flips} sub="a fail made a pass, or the reverse" tone={c.flips ? "warn" : undefined} />
          </div>
          <Panel title="Scores against the panel mean" sub="Each dot is one stage an interviewer scored, on the 0–100 scale. The long dashed line is the panel mean; the short one is the usual pass mark of 70.">
            <Strips rows={c.rows.map((r) => ({ label: r.name, values: r.scores }))} mean={c.panelMean} pass={70} />
          </Panel>
          <Panel title="Per interviewer" sub="Someone a few points above the mean is not wrong; a consistent gap is worth a conversation about the rubric’s anchors." pad={false}>
            <DataTable
              cols={["Interviewer", "Stages", "Mean", "Against the panel", "Reading", "Accepted AI scores unchanged", "Grace used", "Up / down", "Outcome changed"]}
              align={["l", "r", "r", "r", "l", "r", "r", "r", "r"]}
              rows={c.rows.map((r) => [
                r.name,
                r.n,
                r.mean,
                `${r.delta > 0 ? "+" : r.delta < 0 ? "−" : ""}${Math.abs(r.delta)}`,
                <span key="l">
                  <Pill tone={r.label === "In line" || r.label === "Too few to say" ? "neutral" : "warn"}>{r.label}</Pill>
                </span>,
                <span key="a" title={r.perfectAgreement ? "Every AI score accepted unchanged — automation complacency is the risk this watches for (PRD R2)." : undefined} className={r.perfectAgreement ? "font-medium text-warn-ink" : ""}>
                  {r.perfectAgreement ? "▲ " : ""}
                  {pct(r.agreement)}
                </span>,
                r.graceUses,
                `${r.graceUp} / ${r.graceDown}`,
                r.flips,
              ])}
            />
          </Panel>
          {c.rows.some((r) => r.perfectAgreement) ? (
            <div className="rounded-[6px] border border-warn-line bg-warn-soft px-4 py-3 text-sm text-warn-ink">
              Accepting every AI score unchanged is itself worth a look: the AI recommends and the interviewer decides, and a perfect agreement rate can mean the second step is not happening.
            </div>
          ) : null}
          <div className="text-xs text-muted">“Lenient” and “Severe” mean a mean more than six points from the panel over at least five stages. Fewer than five reads as too few to say.</div>
        </div>
      )}
    </>
  );
}
