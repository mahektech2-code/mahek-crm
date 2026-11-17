import { jobHealth, queueOwners, type JobRow } from "@/lib/services/admin-platform-service";
import { today } from "@/lib/queries";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { RebuildQueues, RunByHand } from "../platform-real";
import { clock, nowMs, shortDate, stamp, stampDate } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { DataTable, Pill, TD, TH, btnClass, type Tone } from "../_shell/kit";
import { RunJobButton } from "./run-job-button";

/**
 * The droplet's crontab calls four cadences (deploy/sheet-sync.sh and the
 * monthly line); each lane is the job that cadence ends with, read off its
 * last run. A lane is LATE when its job has not started in twice its
 * interval — the commonest failure of a schedule is not a red run but no run.
 * "Next" is the last start plus the interval: what the schedule owes, not a
 * promise read off the crontab, which this server cannot see.
 */
const LANES = [
  { label: "Every 30 min · sheets", job: "sheet-append", minutes: 30, cadence: "30 min" },
  { label: "Hourly", job: "hourly", minutes: 60, cadence: "Hourly" },
  { label: "Nightly", job: "nightly", minutes: 24 * 60, cadence: "Nightly" },
  { label: "Monthly · 1st", job: "top-customers-report", minutes: 31 * 24 * 60, cadence: "Monthly" },
] as const;

const CADENCE: Record<string, string> = Object.fromEntries(LANES.map((l) => [l.job, l.cadence]));

function took(j: JobRow) {
  if (!j.finishedAt) return "Running";
  const s = Math.max(0, Math.round((new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Today's runs read as a time; anything older as a date. */
function when(iso: string, now: number) {
  const d = new Date(iso);
  return now - d.getTime() < 20 * 3600_000 ? clock(d) : shortDate(d);
}

function CadenceLanes({ jobs, now }: { jobs: JobRow[]; now: number }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
      {LANES.map((l) => {
        const j = jobs.find((x) => x.job === l.job);
        const started = j ? new Date(j.startedAt).getTime() : null;
        const late = started != null && now - started > l.minutes * 60_000 * 2;
        const next = started != null ? started + l.minutes * 60_000 : null;
        const tone: Tone = !j ? "muted" : !j.ok ? "danger" : late ? "warn" : "ok";
        const value = !j
          ? "Never run"
          : late
            ? "Late"
            : l.minutes >= 31 * 24 * 60
              ? shortDate(new Date(next!))
              : l.minutes >= 24 * 60
                ? stampDate(new Date(next!)) === stampDate(new Date(now))
                  ? "Tonight"
                  : `Next ${clock(new Date(next!))}`
                : `Next ${clock(new Date(next!))}`;
        return (
          <div key={l.job} className="flex min-w-0 flex-col gap-1.5 rounded-card border border-line bg-surface px-4 py-3.5">
            <span className="text-xs font-medium text-muted">{l.label}</span>
            <span className="text-[18px] leading-6 font-bold text-ink">{value}</span>
            <span>
              <Pill tone={tone}>
                {!j ? "No run recorded" : !j.ok ? "Last run failed" : `Last ok ${when(j.startedAt, now)}`}
              </Pill>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function result(j: JobRow): { tone: Tone; text: string } {
  if (!j.finishedAt) return { tone: "info", text: "Running" };
  if (!j.ok) return { tone: "danger", text: "Failed" };
  return j.records > 0 ? { tone: "ok", text: `${j.records.toLocaleString("en-IN")} records` } : { tone: "muted", text: "No change" };
}

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requirePlatformAdmin();
  const { q = "" } = await searchParams;
  const [jobs, queues] = await Promise.all([jobHealth(), queueOwners(await today())]);
  const now = nowMs();
  const needle = q.trim().toLowerCase();
  const shown = jobs
    .filter((j) => !needle || j.job.toLowerCase().includes(needle))
    // Failures first — a red run is the row somebody opened this page for.
    .sort((a, b) => Number(a.ok) - Number(b.ok));

  return (
    <AdminPage
      title="Jobs & schedules"
      subtitle="Scheduled work and how it has gone, the one-off jobs somebody runs by hand, and rebuilding a Call Log that is older than the release."
      actions={
        <>
          <form method="get" role="search">
            <input
              name="q"
              defaultValue={q}
              placeholder="Find a job"
              aria-label="Find a job"
              className="h-[38px] w-[240px] rounded-control border border-line-strong bg-surface px-3 text-[13px] text-ink placeholder:text-faint focus:border-brand focus:outline-none"
            />
          </form>
          <a href="#run" className={`${btnClass("primary")} h-[38px]`}>
            Run a job
          </a>
        </>
      }
    >
      <CadenceLanes jobs={jobs} now={now} />

      <section className="min-w-0 overflow-hidden rounded-card border border-line bg-surface">
        <div className="flex items-center gap-2.5 px-[18px] py-4">
          <h2 className="m-0 text-[16px] font-bold text-ink">Runs</h2>
          <span className="flex-1" />
          <span className="text-[13px] text-muted">
            {needle ? `${shown.length} of ${jobs.length} jobs · ` : ""}Last 14 runs
          </span>
        </div>
        {shown.length === 0 ? (
          <div className="border-t border-divider px-[18px] py-10 text-center text-muted">
            {jobs.length === 0
              ? "No job has run on this database. Jobs are recorded when they run — from the console, the CLI, or the droplet's crontab."
              : `No job matches “${q}”.`}
          </div>
        ) : (
          <DataTable>
            <thead>
              <tr>
                <TH className="pl-[18px]">Job</TH>
                <TH>Cadence</TH>
                <TH>Last run</TH>
                <TH>Took</TH>
                <TH>Result</TH>
                <TH>History</TH>
                <TH className="w-14" />
              </tr>
            </thead>
            <tbody>
              {shown.map((j) => {
                const r = result(j);
                const failed = !j.ok && Boolean(j.finishedAt);
                return [
                  <tr key={j.job} className={failed ? "bg-danger-soft/40" : undefined}>
                    <TD className={cx("pl-[18px] font-mono text-[13px] font-semibold text-ink", failed && "border-b-0")}>{j.job}</TD>
                    <TD className={cx("text-body", failed && "border-b-0")}>{CADENCE[j.job] ?? "—"}</TD>
                    <TD className={cx("tabular-nums", failed && "border-b-0")} >
                      <span title={stamp(j.startedAt)}>{when(j.startedAt, now)}</span>
                    </TD>
                    <TD className={cx("tabular-nums", failed && "border-b-0")}>{took(j)}</TD>
                    <TD className={cx(failed && "border-b-0")}>
                      <Pill tone={r.tone} title={j.detail ?? undefined}>
                        {r.text}
                      </Pill>
                    </TD>
                    <TD className={cx(failed && "border-b-0")}>
                      <span
                        className="inline-flex items-center gap-[3px]"
                        role="img"
                        aria-label={`${j.runs} runs in 7 days${j.failures ? `, ${j.failures} failed` : ""}`}
                        title={`${j.runs} run${j.runs === 1 ? "" : "s"} in 7 days${j.failures ? `, ${j.failures} failed` : ""}`}
                      >
                        {j.recent.map((ok, k) => (
                          <span key={k} className={cx("block h-3.5 w-[7px] rounded-[2px]", ok ? "bg-success" : "bg-danger")} />
                        ))}
                      </span>
                    </TD>
                    <TD align="right" className={cx("pr-[18px]", failed && "border-b-0")}>
                      <RunJobButton job={j.job} />
                    </TD>
                  </tr>,
                  failed ? (
                    <tr key={`${j.job}:detail`} className="bg-danger-soft/40">
                      <TD colSpan={7} className="h-auto px-[18px] pt-0 pb-3">
                        <div className="rounded-control bg-ink px-3.5 py-3 font-mono text-xs leading-5 whitespace-pre-wrap text-white">
                          {j.detail ?? "The run failed and left no detail."}
                        </div>
                      </TD>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </DataTable>
        )}
      </section>

      {/* Both cards carry a top margin of their own; the page's gap spaces them. */}
      <div id="run" className="scroll-mt-6 [&>*]:mt-0">
        <RunByHand />
      </div>
      <div className="[&>*]:mt-0">
        <RebuildQueues queues={queues} />
      </div>
    </AdminPage>
  );
}
