/**
 * Manual job runner — §7 requires every scheduled task to be triggerable by
 * hand, both during migration and when a nightly run is missed.
 *
 *   npm run jobs -- nightly
 */
import { runJob, type JobName } from "../src/lib/jobs";

const job = process.argv[2] as JobName;
if (!job) {
  console.error("Usage: npm run jobs -- <nightly|hourly|day-boundary>");
  process.exit(1);
}

const results = await runJob(job);
for (const r of results) {
  console.log(`${r.job.padEnd(24)} ${String(r.recordsAffected).padStart(5)}  ${r.detail}`);
}
process.exit(0);
