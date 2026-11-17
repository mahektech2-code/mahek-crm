import { jobHealth, queueOwners } from "@/lib/services/admin-platform-service";
import { today } from "@/lib/queries";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { JobsTab } from "../platform-real";
import { nowMs, stamp } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import type { JobRow } from "@/lib/services/admin-platform-service";

/**
 * The droplet's crontab calls four cadences (deploy/sheet-sync.sh and the
 * monthly line); each lane is the job that cadence ends with, read off its
 * last run. A lane is LATE when its job has not started in twice its
 * interval — the commonest failure of a schedule is not a red run but no run.
 */
const LANES = [
  { label: "Every 30 min · sheets", job: "sheet-append", minutes: 30 },
  { label: "Hourly", job: "hourly", minutes: 60 },
  { label: "Nightly", job: "nightly", minutes: 24 * 60 },
  { label: "Monthly · 1st", job: "top-customers-report", minutes: 31 * 24 * 60 },
] as const;

function CadenceLanes({ jobs, now }: { jobs: JobRow[]; now: number }) {
  return (
    <CardGrid min={220} gap="gap-3" className="mb-4">
      {LANES.map((l) => {
        const j = jobs.find((x) => x.job === l.job);
        const age = j ? (now - new Date(j.startedAt).getTime()) / 60000 : Infinity;
        const late = age > l.minutes * 2;
        const tone = !j ? "muted" : !j.ok ? "danger" : late ? "warn" : "ok";
        return (
          <div key={l.job} className="flex flex-col gap-1.5 rounded-card border border-line bg-surface px-4 py-3.5">
            <span className="text-meta font-semibold text-muted">{l.label}</span>
            <span className="text-lg font-bold text-ink">{j ? stamp(j.startedAt) : "Never run"}</span>
            <span
              className={cx(
                "inline-flex h-6 w-fit items-center rounded-full px-2.5 text-xs font-semibold",
                tone === "ok" && "bg-success-soft text-success",
                tone === "danger" && "bg-danger-soft text-danger",
                tone === "warn" && "bg-warn-soft text-warn-ink",
                tone === "muted" && "bg-divider text-body",
              )}
            >
              {tone === "ok" ? "On time" : tone === "danger" ? "Last run failed" : tone === "warn" ? "Late" : "No run recorded"}
            </span>
          </div>
        );
      })}
    </CardGrid>
  );
}

export default async function JobsPage() {
  await requirePlatformAdmin();
  const [jobs, queues] = await Promise.all([jobHealth(), queueOwners(await today())]);
  const failing = jobs.filter((j) => !j.ok).length;
  return (
    <AdminPage
      title="Jobs & schedules"
      subtitle="Scheduled work and how it has gone, the one-off jobs somebody runs by hand, and rebuilding a Call Log that is older than the release."
      metrics={[
        { label: "Jobs", value: String(jobs.length) },
        { label: "Last run failed", value: String(failing), tone: failing ? "danger" : "success" },
        { label: "Runs · 7 days", value: String(jobs.reduce((n, j) => n + j.runs, 0)) },
        { label: "Failures · 7 days", value: String(jobs.reduce((n, j) => n + j.failures, 0)) },
      ]}
    >
      <CadenceLanes jobs={jobs} now={nowMs()} />
      <JobsTab data={{ jobs, queues }} />
    </AdminPage>
  );
}
