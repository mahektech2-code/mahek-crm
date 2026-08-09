import type { JobOptions } from "./jobs";

/* ---------------------------------------------------------------------------
 * The manual job runner's arguments.
 *
 * Pure, and here rather than in the script, so the parsing has a test. The bug
 * this exists to prevent is not a crash: `npm run jobs -- project-sheet
 * --bills` used to run the projection with no options at all, write no bills,
 * and report "bills skipped" in the same breath. A flag that is silently
 * discarded is worse than one that is rejected, because the person reads the
 * output as an answer about their data.
 * ------------------------------------------------------------------------- */

/** Options that are switches: present means true, and they take no value. */
const FLAGS = ["bills", "leads", "reassign"] as const;

/** Options that carry a value, as --name=value. */
const VALUES = ["owner", "password"] as const;

export type ParsedJobArgs =
  | { ok: true; job: string; options: JobOptions }
  | { ok: false; problem: string | null };

export function parseJobArgs(argv: string[]): ParsedJobArgs {
  const job = argv[0];
  if (!job || job.startsWith("-")) return { ok: false, problem: null };

  const options: JobOptions = {};

  for (const arg of argv.slice(1)) {
    const [name, value] = arg.replace(/^--/, "").split("=", 2);

    if ((FLAGS as readonly string[]).includes(name)) {
      if (value !== undefined) {
        return { ok: false, problem: `--${name} is a switch and takes no value.` };
      }
      options[name as (typeof FLAGS)[number]] = true;
      continue;
    }

    if ((VALUES as readonly string[]).includes(name)) {
      // `--owner` with nothing after it would otherwise read as "assign to
      // nobody", which is the mistake that leaves an imported book in no
      // telecaller's scope and every screen empty.
      if (!value) {
        return { ok: false, problem: `--${name} needs a value, as --${name}=something.` };
      }
      options[name as (typeof VALUES)[number]] = value;
      continue;
    }

    // Never ignored. A misspelt flag that runs the job anyway is how somebody
    // concludes the import cannot write bills.
    return { ok: false, problem: `Unknown option "${arg}".` };
  }

  return { ok: true, job, options };
}

export const JOB_USAGE = [
  "Usage: npm run jobs -- <job> [options]",
  "",
  "  --owner=<email>   whose book imported customers answer to (project-sheet)",
  "  --bills           write bills and payments from the Payment Status tab",
  "  --leads           create never-ordered parties as leads",
  "  --reassign        move customers that already exist to --owner",
  "  --password=<pw>   for accounts provision-team creates",
  "",
  "  npm run jobs -- nightly",
  "  npm run jobs -- sheet-payments",
  "  npm run jobs -- project-sheet --owner=vikram@mahek.in --bills",
].join("\n");
