/**
 * Manual job runner — §7 requires every scheduled task to be triggerable by
 * hand, both during migration and when a nightly run is missed.
 *
 *   npm run jobs -- nightly
 *   npm run jobs -- sheet-payments
 *   npm run jobs -- project-sheet --owner=vikram@mahek.in --bills
 *
 * The parsing lives in lib/job-args so it can be tested; this file is the
 * argv, the exit codes and the printing.
 */
import { runJob, type JobName } from "../src/lib/jobs";
import { parseJobArgs, JOB_USAGE } from "../src/lib/job-args";

const parsed = parseJobArgs(process.argv.slice(2));
if (!parsed.ok) {
  if (parsed.problem) console.error(`\n${parsed.problem}\n`);
  console.error(JOB_USAGE);
  process.exit(1);
}

// Wrapped rather than top-level await: tsx transforms this file to CJS under
// --conditions=react-server, where top-level await is a syntax error.
async function main() {
  if (!parsed.ok) return;
  const results = await runJob(parsed.job as JobName, undefined, parsed.options);
  for (const r of results) {
    console.log(`${r.job.padEnd(24)} ${String(r.recordsAffected).padStart(5)}  ${r.detail}`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
