import { CardGrid } from "@/components/ui/card-grid";
import type { Metadata } from "next";
import { cx } from "@/components/ui/primitives";
import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { trainingInsights } from "@/lib/training/service";
import { Empty, PageHead, Panel, Pill, Stat, fd } from "../../_ui/kit";

export const metadata: Metadata = { title: "Training" };
export const dynamic = "force-dynamic";

/** PRD §19, the management view: how new people are getting through their tracks. Every figure is read from the attempts. */
export default async function TrainingInsightsPage() {
  await requireHireScreen("training");
  const now = nowMs();
  const d = await trainingInsights(now);
  const t = d.totals;
  const mods = d.perModule.filter((m) => m.attempts > 0);
  const people = [...d.people].sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(b.retraining) - Number(a.retraining) || (a.passed ?? 0) / Math.max(1, a.required ?? 1) - (b.passed ?? 0) / Math.max(1, b.required ?? 1));
  const day = (iso: string) => Math.max(1, Math.floor((now - new Date(iso).getTime()) / 86_400_000) + 1);
  return (
    <>
      <PageHead title="Training" sub="How new people are getting through their tracks: first-attempt pass rates, retakes and average scores per module, and the topics most often answered wrong." />
      <CardGrid min={180} gap="gap-3" className="mb-5">
        <Stat label="In training now" value={t.active} />
        <Stat label="Completed" value={t.completed} tone={t.completed ? "success" : undefined} />
        <Stat label="First-attempt pass rate" value={t.firstAttemptPassRate == null ? "—" : `${t.firstAttemptPassRate}%`} sub={`of ${t.firstAttempts} first attempts`} />
        <Stat label="Retakes per completion" value={t.retakesPerCompletion ?? "—"} />
        <Stat label="Overdue" value={t.overdue} tone={t.overdue ? "danger" : undefined} sub="past their track’s window" />
      </CardGrid>
      {!mods.length && !people.length ? (
        <Empty title="Nothing to report yet">Figures appear once somebody has taken a module test.</Empty>
      ) : (
        <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] items-start gap-4">
          <Panel title="By module" sub="First-attempt pass rate, from submitted attempts" pad={false}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-divider text-left text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                    <th className="px-3 py-2.5">Module</th>
                    <th className="w-[34%] px-3 py-2.5">First-attempt pass</th>
                    <th className="px-3 py-2.5 text-right">Attempts</th>
                    <th className="px-3 py-2.5 text-right">Avg score</th>
                    <th className="px-3 py-2.5 text-right">Retakes</th>
                  </tr>
                </thead>
                <tbody>
                  {mods.map((m) => {
                    const p = m.first_n ? Math.round((m.first_pass / m.first_n) * 100) : null;
                    return (
                      <tr key={m.key} className="border-b border-canvas">
                        <td className="px-3 py-2 text-heading">{m.title}</td>
                        <td className="px-3 py-2">
                          {p == null ? (
                            <span className="text-muted">—</span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <div className="h-2 flex-1 overflow-hidden rounded-[2px] bg-divider">
                                <div className={cx("h-full", p >= 70 ? "bg-brand" : "bg-warn")} style={{ width: `${p}%` }} />
                              </div>
                              <span className="w-9 text-right font-medium tabular-nums">{p}%</span>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{m.attempts}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{m.avg_score == null ? "—" : `${m.avg_score}%`}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{m.retakes}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex gap-4 border-t border-divider px-5 py-2.5 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-[2px] bg-brand" />
                At or above 70%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-[2px] bg-warn" />
                Below 70% — look at the content
              </span>
            </div>
          </Panel>
          <div className="flex flex-col gap-4">
            <Panel title="Training gaps" sub="Share of answers wrong, by question tag (3+ answers)">
              {!d.gaps.length ? (
                <div className="text-[13px] text-muted">Not enough answers yet.</div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {d.gaps.map((g) => {
                    const p = g.total ? Math.round((g.wrong / g.total) * 100) : 0;
                    return (
                      <div key={g.tag}>
                        <div className="mb-1 flex justify-between text-[13px]">
                          <span className="text-heading">{g.tag}</span>
                          <span className="font-medium text-heading tabular-nums">
                            {p}% <span className="font-normal text-muted">of {g.total}</span>
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-[2px] bg-divider">
                          <div className="h-full bg-warn" style={{ width: `${p}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
            <Panel title="By employee" sub="Furthest behind first" pad={false}>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-divider text-left text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                      <th className="px-3 py-2.5">Employee</th>
                      <th className="px-3 py-2.5 text-right">Done</th>
                      <th className="px-3 py-2.5 text-right">Day</th>
                      <th className="px-3 py-2.5">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.slice(0, 40).map((p) => (
                      <tr key={p.id} className="border-b border-canvas">
                        <td className="px-3 py-2">
                          <div className="text-heading">{p.name}</div>
                          <div className="text-xs text-muted">{p.track}</div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{p.status === "completed" ? "All" : `${p.passed ?? 0} / ${p.required ?? 0}`}</td>
                        <td className={cx("px-3 py-2 text-right tabular-nums", p.overdue ? "text-danger" : "")}>{p.status === "completed" ? fd(p.completed_at) : day(p.assigned_at)}</td>
                        <td className="px-3 py-2">
                          {p.status === "completed" ? <Pill tone="success">Completed</Pill> : p.overdue ? <Pill tone="danger">Overdue</Pill> : p.retraining ? <Pill tone="warn">Retraining</Pill> : <Pill tone="neutral">On track</Pill>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
