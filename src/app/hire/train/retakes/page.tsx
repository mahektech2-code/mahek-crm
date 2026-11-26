import { CardGrid } from "@/components/ui/card-grid";
import type { Metadata } from "next";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { getConfig } from "@/lib/config/store";
import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { attemptDetail, CORRECTION_MIN, retakeQueue, SIGN_OFF_MIN } from "@/lib/training/service";
import { Empty, PageHead, Panel, Pill, Stat, fd, type Tone } from "../../_ui/kit";
import { RetakePanel } from "./retake-panel";

export const metadata: Metadata = { title: "Retakes" };
export const dynamic = "force-dynamic";

const STATE: Record<string, [string, Tone]> = {
  retraining_required: ["Waiting for sign-off", "warn"],
  retake_open: ["Retake open", "info"],
  passed_on_retake: ["Passed on retake", "success"],
};

/** PRD §18 — a failed module waits here until a trainer reviews it with the learner and signs it off. */
export default async function RetakesPage({ searchParams }: { searchParams: Promise<{ attempt?: string; enrollment?: string; module?: string }> }) {
  const ctx = await requireHireScreen("retakes");
  const sp = await searchParams;
  const now = nowMs();
  const [rows, cfg] = await Promise.all([retakeQueue({ trainerId: ctx.role === "trainer" ? ctx.user.id : null, nowMs: now }), getConfig()]);
  const lateDays = cfg["hire.reminders.retrainingDays"];
  const late = (r: (typeof rows)[number]) => r.state === "retraining_required" && now - new Date(r.failedAt).getTime() > lateDays * 86_400_000;
  const sel = rows.find((r) => r.attemptId === sp.attempt) ?? rows.find((r) => r.enrollmentId === sp.enrollment && r.moduleKey === sp.module) ?? rows.find((r) => r.state === "retraining_required") ?? rows[0] ?? null;
  const detail = sel ? await attemptDetail(sel.attemptId) : null;
  const waiting = rows.filter((r) => r.state === "retraining_required");
  return (
    <>
      <PageHead title="Retakes" sub="A failed module waits here. The trainer reviews it with the employee and signs that off; only then does the retake open, once they have studied it again. Every attempt stays in the history." />
      <CardGrid min={180} gap="gap-3" className="mb-5">
        <Stat label="Waiting for sign-off" value={waiting.length} tone={waiting.length ? "warn" : undefined} sub={waiting.some(late) ? `${waiting.filter(late).length} past ${lateDays} days` : "none late"} />
        <Stat label="Retake open" value={rows.filter((r) => r.state === "retake_open").length} sub="signed off, not passed yet" />
        <Stat label="Failed twice or more" value={rows.filter((r) => r.attemptNo >= 2 && r.state !== "passed_on_retake").length} tone={rows.some((r) => r.attemptNo >= 2 && r.state !== "passed_on_retake") ? "danger" : undefined} sub="consider a one-to-one" />
        <Stat label="Passed on retake · 90 days" value={rows.filter((r) => r.state === "passed_on_retake").length} tone="success" />
      </CardGrid>
      {!rows.length ? (
        <Empty title="Nobody is waiting">{ctx.role === "trainer" ? "Nobody you train has failed a module in the last 90 days." : "No failed module in the last 90 days."}</Empty>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_440px] items-start gap-4">
          <Panel pad={false}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-divider text-left text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                    <th className="px-3 py-2.5">Employee</th>
                    <th className="px-3 py-2.5">Module</th>
                    <th className="px-3 py-2.5">Attempt</th>
                    <th className="px-3 py-2.5 text-right">Score</th>
                    <th className="px-3 py-2.5">Failed</th>
                    <th className="px-3 py-2.5">Weak topics</th>
                    <th className="px-3 py-2.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const [l, tone] = STATE[r.state];
                    return (
                      <tr key={r.attemptId} className={cx("border-b border-canvas", sel?.attemptId === r.attemptId ? "bg-brand-soft" : "hover:bg-canvas")}>
                        <td className="px-3 py-2.5">
                          <Link href={`/hire/train/retakes?attempt=${r.attemptId}`} scroll={false} className="font-medium text-heading no-underline hover:underline">
                            {r.name}
                          </Link>
                          <div className="text-xs text-muted">{r.trackTitle}</div>
                        </td>
                        <td className="px-3 py-2.5">{r.moduleTitle}</td>
                        <td className="px-3 py-2.5 text-muted">{r.attemptNo === 1 ? "1st" : r.attemptNo === 2 ? "2nd" : r.attemptNo === 3 ? "3rd" : `${r.attemptNo}th`}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          <span className="font-semibold text-danger">{r.scorePercent}%</span>
                          <span className="text-muted"> / {r.passMark}%</span>
                        </td>
                        <td className={cx("px-3 py-2.5", late(r) ? "font-medium text-danger" : "text-muted")}>{fd(r.failedAt)}</td>
                        <td className="px-3 py-2.5 text-muted">{r.weak.slice(0, 3).join(", ") || "—"}</td>
                        <td className="px-3 py-2.5">
                          <Pill tone={tone}>{l}</Pill>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
          {sel && detail ? (
            <RetakePanel
              key={sel.attemptId}
              row={sel}
              detail={{
                attemptId: detail.attempt.id,
                learner: detail.learner,
                moduleTitle: detail.moduleTitle,
                moduleVersion: detail.moduleVersion,
                startedAt: detail.attempt.startedAt.toISOString(),
                submittedAt: detail.attempt.submittedAt?.toISOString() ?? null,
                scorePercent: sel.scorePercent,
                passMark: detail.attempt.passMark,
                correct: detail.attempt.correctAnswers ?? 0,
                total: detail.attempt.totalQuestions,
                minStudyMinutes: detail.minStudyMinutes,
                studiedSinceSeconds: detail.studiedSinceSeconds,
                questions: detail.questions,
                corrections: detail.corrections.map((c) => ({ id: c.id, scorePercent: c.scorePercent, result: c.result, reason: c.reason, at: c.at.toISOString() })),
              }}
              canSignOff={ctx.can("trainingTrain")}
              signOffWhy={lockedWhy("trainingTrain")}
              canCorrect={ctx.can("attemptCorrect")}
              correctWhy={lockedWhy("attemptCorrect")}
              signOffMin={SIGN_OFF_MIN}
              correctionMin={CORRECTION_MIN}
            />
          ) : null}
        </div>
      )}
    </>
  );
}
