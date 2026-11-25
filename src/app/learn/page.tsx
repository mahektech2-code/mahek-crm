import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { APP_TIMEZONE } from "@/lib/business-date";
import { nowMs } from "@/lib/format";
import { enrollmentView, enrollmentsForUser, type EnrollmentView } from "@/lib/training/service";
import { cx } from "@/components/ui/primitives";
import { Bar, Empty, Section, StatePill } from "./ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home" };

const DAY = 86_400_000;

/** The learner's home: progress, what needs them, and every module in order. */
export default async function LearnHome() {
  const user = await requireUser();
  const now = nowMs();
  const enrolments = await enrollmentsForUser(user.id);
  const views = (await Promise.all(enrolments.map((e) => enrollmentView(e.id, now)))).filter((v): v is EnrollmentView => v != null);
  const active = views.filter((v) => v.enrollment.status === "active");
  const done = views.filter((v) => v.enrollment.status === "completed");

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-[13px] text-muted">{active[0]?.track.title ?? "Training"}</div>
        <h1 className="m-0 text-[22px] leading-7 font-semibold text-heading">Hello, {user.name.split(" ")[0]}</h1>
      </div>

      {!views.length ? (
        <Empty title="No training assigned to you">When you are enrolled on a track it appears here. HR enrols new joiners when their account is created.</Empty>
      ) : null}

      {active.map((v) => (
        <Track key={v.enrollment.id} v={v} now={now} />
      ))}

      {done.length ? (
        <Section title="Completed">
          <div className="overflow-hidden rounded-[8px] border border-line bg-surface">
            {done.map((v) => (
              <div key={v.enrollment.id} className="flex min-h-12 items-center gap-3 border-t border-canvas px-4 first:border-t-0">
                <span className="flex-1 text-sm text-heading">{v.track.title}</span>
                <span className="text-[12px] text-success">
                  Completed {v.enrollment.completedAt ? new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, day: "numeric", month: "short" }).format(v.enrollment.completedAt) : ""}
                </span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function Track({ v, now }: { v: EnrollmentView; now: number }) {
  const s = v.summary;
  const day = Math.max(1, Math.floor((now - v.enrollment.assignedAt.getTime()) / DAY) + 1);
  const within = v.track.def.completeWithinDays;
  const retraining = v.modules.filter((m) => m.state === "retraining_required");
  const retakes = v.modules.filter((m) => m.state === "retake_open");
  const inTest = v.modules.find((m) => m.state === "assessment_pending");
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[8px] border border-line bg-surface px-4 py-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[28px] font-semibold text-heading tabular-nums">{s.percent}%</span>
          <span className="text-[13px] text-muted tabular-nums">
            {s.passed} of {s.required} modules{within ? ` · day ${day} of ${within}` : ""}
          </span>
        </div>
        <div className="mt-2">
          <Bar percent={s.percent} />
        </div>
        {v.trainerName ? <div className="mt-2 text-[12px] text-muted">Your trainer: {v.trainerName}</div> : null}
      </div>

      {inTest ? (
        <Link href={`/learn/${v.enrollment.id}/${encodeURIComponent(inTest.moduleKey)}`} className="rounded-[8px] bg-warn-soft px-3.5 py-3 text-[13px] leading-[19px] text-warn-ink no-underline">
          <b>A test is in progress:</b> {inTest.title}. Carry on before the time runs out.
        </Link>
      ) : null}
      {retraining.map((m) => (
        <div key={m.moduleKey} className="rounded-[8px] bg-danger-soft px-3.5 py-3 text-[13px] leading-[19px] text-danger">
          <b>{m.title} needs a retake.</b> {m.why}
          {v.trainerName ? ` ${v.trainerName} will go through it with you.` : ""}
        </div>
      ))}
      {retakes.map((m) => (
        <Link key={m.moduleKey} href={`/learn/${v.enrollment.id}/${encodeURIComponent(m.moduleKey)}`} className="rounded-[8px] bg-brand-soft px-3.5 py-3 text-[13px] leading-[19px] text-brand-hover no-underline">
          <b>{m.title}: your retake is open.</b> Open the module to take it.
        </Link>
      ))}

      <Section title="Your modules">
        <div className="overflow-hidden rounded-[8px] border border-line bg-surface">
          {v.modules.map((m) => {
            const locked = m.state === "locked";
            return (
              <Link
                key={m.moduleKey}
                href={`/learn/${v.enrollment.id}/${encodeURIComponent(m.moduleKey)}`}
                className="flex min-h-[52px] items-center gap-3 border-t border-canvas px-3.5 no-underline first:border-t-0 hover:bg-canvas hover:no-underline"
              >
                <span
                  className={cx(
                    "flex size-[26px] flex-none items-center justify-center rounded-full text-[12px] font-semibold tabular-nums",
                    m.state === "passed" ? "bg-success-soft text-success" : m.state === "retraining_required" ? "bg-danger-soft text-danger" : locked ? "bg-divider text-muted" : "bg-brand-soft text-brand-hover",
                  )}
                >
                  {m.n}
                </span>
                <span className={cx("min-w-0 flex-1 truncate text-sm", locked ? "text-muted" : "text-heading")}>
                  {m.title}
                  {!m.required ? <span className="text-muted"> · optional</span> : null}
                </span>
                <StatePill state={m.state} score={m.bestScore} />
              </Link>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
