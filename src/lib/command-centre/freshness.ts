import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import type { JobName, JobOptions } from "@/lib/jobs";
import { secretStatuses } from "@/lib/secrets";
import { num, plural } from "./format";
import type { Tone } from "./types";

/* ---------------------------------------------------------------------------
 * FRESHNESS OF EVERY SOURCE BEHIND THE NUMBERS (PRD §21.8).
 *
 * Staleness is decided HERE and nowhere else: the sidebar footer reads the
 * one line, the System section reads the list, and Needs you reads the same
 * list — so the headline and the list can never disagree about whether a
 * source is current.
 *
 * Everything is read from the records the jobs already keep: `sheet_sync_runs`
 * for every workbook tab, `job_runs` for the cycles and recomputes, the Wati
 * webhook's own writes for WhatsApp, `mbos_devices` for handsets, and
 * `secretStatuses()` (presence only, never a value) for the AI providers.
 * Nothing here calls an outside service — a check per page load would bill
 * somebody for a refresh (PRD §21.10).
 *
 * The stale-after thresholds are PRD §21.8's proposed `ops.staleAfter.*`
 * defaults. They live here as named constants until that configuration
 * exists, and they only decide what a screen CALLS stale — nothing runs, is
 * refused or is paid on them.
 * ------------------------------------------------------------------------- */

const H = 3_600_000;
export const STALE_AFTER_HOURS = {
  halfHourly: 2,
  hourly: 2.5,
  nightly: 30,
  hrSheet: 24,
  callAssistant: 72,
  handsetQuiet: 4,
  watiQuiet: 48,
} as const;

/** The steps a complete nightly pass writes, in order (jobs.ts `runNightly`). */
export const NIGHTLY_STEPS = [
  "mbos-nightly",
  "expense-month-snapshot",
  "link-delivery-parties",
  "recompute-cycles",
  "recompute-sales-managers",
  "recompute-inactivity",
  "recompute-followups",
  "sweep-orphan-attachments",
  "recompute-slow-payers",
  "snapshot-queue",
  "snapshot-customer-health",
  "recompute-performance",
  "auto-eod",
] as const;

const NIGHTLY_WORDS: Record<string, string> = {
  "mbos-nightly": "Field app tidy-up",
  "expense-month-snapshot": "Expense month snapshot",
  "link-delivery-parties": "Delivery parties linked",
  "recompute-cycles": "Buying cycles",
  "recompute-sales-managers": "Sales manager seats",
  "recompute-inactivity": "Inactive watch",
  "recompute-followups": "Bill statuses, outstanding and follow-up stages",
  "sweep-orphan-attachments": "Unattached files swept",
  "recompute-slow-payers": "Slow-payer flags",
  "snapshot-queue": "Today's call lists",
  "snapshot-customer-health": "Customer health snapshot",
  "recompute-performance": "Salesman scores",
  "auto-eod": "End-of-day reports",
  "call-intel-train": "Call assistant relearned",
};
export const stepWords = (job: string) => NIGHTLY_WORDS[job] ?? job.replace(/-/g, " ");

export type FreshState = "current" | "running" | "behind" | "failing" | "never" | "unconfigured" | "unjudged";

export type FreshSource = {
  key: string;
  label: string;
  /** Plain words for where it is read from. */
  readsFrom: string;
  expected: string;
  staleAfterHours: number | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  /** The last attempt's own result line, or its error. */
  lastResult: string | null;
  state: FreshState;
  stateWord: string;
  tone: Tone;
  detail: string;
  /** The job "Run now" runs; null where nothing can be run from here. */
  job: JobName | null;
  jobOptions?: JobOptions;
  /** Whether the job supports a dry run. */
  dryRun: boolean;
  /** Where its run history lives. */
  history: { kind: "sheet"; source: string } | { kind: "jobs"; jobs: string[] } | { kind: "none" };
  /** A MahekOne page that works this source. */
  href?: { label: string; url: string };
};

export type FreshnessSummary = {
  tone: Tone;
  line: string;
  staleCount: number;
  currentCount: number;
  sources: FreshSource[];
};

/* ------------------------------------------------------------- words */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false });
const YMD = new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** "2026-09-26" in IST. */
export function istDay(at: string | Date): string {
  return YMD.format(new Date(at));
}
/** "26 Sep" — IST. */
function dayMonth(d: Date): string {
  const [, m, day] = istDay(d).split("-");
  return `${Number(day)} ${MONTHS[Number(m) - 1]}`;
}
/** "26 Sep, 11:30" — IST. */
export function shortStamp(at: string | Date | null | undefined): string {
  if (!at) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  return `${dayMonth(d)}, ${CLOCK.format(d)}`;
}
/** "11:30" when today in IST, otherwise "26 Sep". */
export function clockOrDay(at: string | Date | null | undefined): string {
  if (!at) return "—";
  const d = new Date(at);
  return istDay(d) === istDay(new Date()) ? CLOCK.format(d) : dayMonth(d);
}
/** "8 min" · "3 h" · "6 days". */
export function ageWords(at: string | Date | null | undefined): string {
  if (!at) return "never";
  const ms = Math.max(0, Date.now() - new Date(at).getTime());
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  const h = ms / H;
  if (h < 48) return `${Math.round(h)} h`;
  return plural(Math.floor(h / 24), "day");
}
function firstLine(s: string | null | undefined, max = 110): string {
  const t = (s ?? "").split("\n")[0]!.trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

/* ------------------------------------------------------------- reads */

type SheetRow = {
  source: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  rows_read: number;
  rows_created: number;
  rows_updated: number;
  rows_with_issues: number;
  error: string | null;
};
type JobRow = { job: string; ok: boolean; started_at: string; finished_at: string | null; detail: string | null; records_affected: number };

const SHEET_SOURCES = ["order_details", "payment_status", "taken_order", "sales_party", "employee_details", "field_activity", "customer_master"];
const LATEST_JOBS = [
  "project-sheet",
  "customer-master-project",
  "escalate-complaint-sla",
  "mbos-hourly",
  "snapshot-customer-health",
  "recompute-performance",
  "call-intel-train",
];

async function readAll() {
  const inList = (xs: readonly string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
  const [sheetLatest, sheetOk, jobLatest, jobOk, nightly, wati, handsets, conflicts, secrets] = await Promise.all([
    db.execute<SheetRow>(sql`
      select distinct on (s.source) s.source, s.status, s.started_at, s.finished_at, s.rows_read, s.rows_created,
             s.rows_updated, s.rows_with_issues, s.error
        from sheet_sync_runs s where s.source in (${inList(SHEET_SOURCES)})
       order by s.source, s.started_at desc`),
    db.execute<SheetRow>(sql`
      select distinct on (s.source) s.source, s.status, s.started_at, s.finished_at, s.rows_read, s.rows_created,
             s.rows_updated, s.rows_with_issues, s.error
        from sheet_sync_runs s where s.source in (${inList(SHEET_SOURCES)}) and s.status = 'ok'
       order by s.source, s.started_at desc`),
    db.execute<JobRow>(sql`
      select distinct on (j.job) j.job, j.ok, j.started_at, j.finished_at, j.detail, j.records_affected
        from job_runs j where j.job in (${inList(LATEST_JOBS)})
       order by j.job, j.started_at desc`),
    db.execute<JobRow>(sql`
      select distinct on (j.job) j.job, j.ok, j.started_at, j.finished_at, j.detail, j.records_affected
        from job_runs j where j.job in (${inList(LATEST_JOBS)}) and j.ok and j.finished_at is not null
       order by j.job, j.started_at desc`),
    nightlyPass(),
    watiLastEventAt(),
    db.execute<{ working: number; quiet: number; devices: number; last: string | null }>(sql`
      select
        (select count(*)::int from mbos_devices d
           join users u on u.id = d.user_id and u.active
           join mbos_attendance_days a on a.user_id = d.user_id
                and a.day = (now() at time zone 'Asia/Kolkata')::date
                and a.check_in_at is not null and a.check_out_at is null
          where d.active) as working,
        (select count(*)::int from mbos_devices d
           join users u on u.id = d.user_id and u.active
           join mbos_attendance_days a on a.user_id = d.user_id
                and a.day = (now() at time zone 'Asia/Kolkata')::date
                and a.check_in_at is not null and a.check_out_at is null
          where d.active
            and (d.last_seen_at is null or d.last_seen_at < now() - make_interval(hours => ${STALE_AFTER_HOURS.handsetQuiet}::int))) as quiet,
        (select count(*)::int from mbos_devices d join users u on u.id = d.user_id and u.active where d.active) as devices,
        (select max(d.last_seen_at) from mbos_devices d where d.active) as last`),
    db.execute<{ entity_type: string; n: number }>(sql`
      select c.entity_type, count(*)::int as n from sync_conflicts c
       where c.resolved_at is null group by c.entity_type`),
    secretStatuses(),
  ]);
  const byKey = <T extends { source?: string; job?: string }>(rows: T[], k: "source" | "job") =>
    new Map(rows.map((r) => [String(r[k]), r]));
  return {
    sheetLatest: byKey(sheetLatest as unknown as SheetRow[], "source"),
    sheetOk: byKey(sheetOk as unknown as SheetRow[], "source"),
    jobLatest: byKey(jobLatest as unknown as JobRow[], "job"),
    jobOk: byKey(jobOk as unknown as JobRow[], "job"),
    nightly,
    watiAt: wati,
    handsets: (handsets as unknown as { working: number; quiet: number; devices: number; last: string | null }[])[0],
    conflicts: new Map((conflicts as unknown as { entity_type: string; n: number }[]).map((c) => [c.entity_type, Number(c.n)])),
    secrets,
  };
}

/**
 * The newest thing Wati's webhook wrote: a customer's reply, or a delivered,
 * read or failed receipt for a message the API sent. The webhook keeps no log
 * of its own, so these are the only evidence it is receiving.
 */
export async function watiLastEventAt(): Promise<string | null> {
  const rows = (await db.execute(sql`
    select greatest(
      (select max(r.received_at) from wa_replies r),
      (select max(m.delivered_at) from wa_messages m),
      (select max(m.read_at) from wa_messages m),
      (select max(m.updated_at) from wa_messages m where m.status = 'failed' and m.mode = 'automatic')
    ) as at`)) as unknown as { at: string | null }[];
  return iso(rows[0]?.at ?? null);
}

export type NightlyPass = {
  startedAt: string | null;
  finishedAt: string | null;
  steps: { job: string; ok: boolean; failed: boolean; running: boolean; detail: string | null; records: number }[];
  okCount: number;
  failedStep: { job: string; detail: string | null } | null;
};

/** The newest nightly pass: every step written since the newest field-app tidy-up began it. */
export async function nightlyPass(): Promise<NightlyPass> {
  const rows = (await db.execute<{
    job: string;
    ok: boolean;
    finished_at: string | null;
    started_at: string;
    detail: string | null;
    records_affected: number;
    pass_start: string;
  }>(sql`
    with s as (select max(j.started_at) as at from job_runs j where j.job = 'mbos-nightly')
    select distinct on (j.job) j.job, j.ok, j.finished_at, j.started_at, j.detail, j.records_affected, s.at as pass_start
      from job_runs j, s
     where s.at is not null and j.started_at >= s.at
       and j.job in (${sql.join(NIGHTLY_STEPS.map((x) => sql`${x}`), sql`, `)})
     order by j.job, j.started_at asc
  `)) as unknown as { job: string; ok: boolean; finished_at: string | null; started_at: string; detail: string | null; records_affected: number; pass_start: string }[];
  const by = new Map(rows.map((r) => [r.job, r]));
  const steps = NIGHTLY_STEPS.map((job) => {
    const r = by.get(job);
    return {
      job,
      ok: Boolean(r && r.ok && r.finished_at),
      failed: Boolean(r && !r.ok),
      running: Boolean(r && r.ok && !r.finished_at),
      detail: r?.detail ?? null,
      records: Number(r?.records_affected ?? 0),
    };
  });
  const failed = steps.find((s) => s.failed);
  const finishes = rows.map((r) => r.finished_at).filter(Boolean) as string[];
  return {
    startedAt: iso(rows[0]?.pass_start ?? null),
    finishedAt: finishes.length ? iso(finishes.sort().at(-1)!) : null,
    steps,
    okCount: steps.filter((s) => s.ok).length,
    failedStep: failed ? { job: failed.job, detail: failed.detail } : null,
  };
}

/* ------------------------------------------------------------- judging */

function judge(opts: {
  lastOk: string | null;
  lastAttempt: { at: string; failed: boolean; running: boolean; error: string | null } | null;
  staleAfter: number | null;
  currentWord: string;
}): { state: FreshState; stateWord: string; tone: Tone } {
  const { lastOk, lastAttempt, staleAfter } = opts;
  if (lastAttempt?.running && hoursSinceMs(lastAttempt.at) < 1 / 6) return { state: "running", stateWord: "Running", tone: "info" };
  if (lastAttempt?.failed && (!lastOk || new Date(lastAttempt.at) > new Date(lastOk)))
    return { state: "failing", stateWord: "Failing", tone: "bad" };
  if (!lastOk) return { state: "never", stateWord: "Never run", tone: "muted" };
  if (staleAfter == null) return { state: "unjudged", stateWord: "By hand", tone: "muted" };
  if (hoursSinceMs(lastOk) > staleAfter) return { state: "behind", stateWord: "Stale", tone: "bad" };
  return { state: "current", stateWord: opts.currentWord, tone: "good" };
}
const hoursSinceMs = (at: string) => (Date.now() - new Date(at).getTime()) / H;

/* ------------------------------------------------------------- the list */

type SheetDef = {
  key: string;
  source: string;
  label: string;
  readsFrom: string;
  expected: string;
  staleAfter: number | null;
  job: JobName;
  conflictsOn?: string;
  href?: { label: string; url: string };
  suffix?: (age: string) => string;
};

const ORDER_SHEET_HREF = { label: "Order sheet in the Admin Console", url: "/admin/order-sheet" };

const SHEETS: SheetDef[] = [
  {
    key: "order_details",
    source: "order_details",
    label: "Order sheet · Order Details",
    readsFrom: "The Order Details tab of the order workbook",
    expected: "30 min",
    staleAfter: STALE_AFTER_HOURS.halfHourly,
    job: "sheet-append",
    conflictsOn: "orders",
    href: ORDER_SHEET_HREF,
  },
  {
    key: "payment_status",
    source: "payment_status",
    label: "Order sheet · Payment Status",
    readsFrom: "The Payment Status tab of the order workbook",
    expected: "30 min",
    staleAfter: STALE_AFTER_HOURS.halfHourly,
    job: "sheet-payments",
    href: ORDER_SHEET_HREF,
  },
  {
    key: "taken_order",
    source: "taken_order",
    label: "Order sheet · Taken Order",
    readsFrom: "The Taken Order tab of the order workbook",
    expected: "30 min",
    staleAfter: STALE_AFTER_HOURS.halfHourly,
    job: "taken-order-sync",
    href: ORDER_SHEET_HREF,
  },
  {
    key: "sales_party",
    source: "sales_party",
    label: "Order sheet · Sales Party",
    readsFrom: "The Sales Party tab of the order workbook — the customer master",
    expected: "30 min",
    staleAfter: STALE_AFTER_HOURS.halfHourly,
    job: "party-sync",
    conflictsOn: "customers",
    href: ORDER_SHEET_HREF,
  },
  {
    key: "employee_details",
    source: "employee_details",
    label: "HR sheet",
    readsFrom: "The Employee Details tab of the employee workbook",
    expected: "On HRMS open",
    staleAfter: STALE_AFTER_HOURS.hrSheet,
    job: "hrms-sync",
    href: { label: "HRMS employees", url: "/hrms/employees" },
    suffix: (age) => `${age} old — only syncs when HRMS opens`,
  },
  {
    key: "field_activity",
    source: "field_activity",
    label: "EMP 2.0 · field activity",
    readsFrom: "The Activity tab of the Mahek EMP 2.0 workbook",
    expected: "30 min",
    staleAfter: STALE_AFTER_HOURS.halfHourly,
    job: "field-activity-append",
  },
  {
    key: "customer_master",
    source: "customer_master",
    label: "EMP 2.0 · shop master",
    readsFrom: "The Customer Details tab of the Mahek EMP 2.0 workbook, into staging",
    expected: "By hand",
    staleAfter: null,
    job: "customer-master-sync",
  },
];

function sheetSource(d: SheetDef, r: Awaited<ReturnType<typeof readAll>>): FreshSource {
  const latest = r.sheetLatest.get(d.source) as SheetRow | undefined;
  const ok = r.sheetOk.get(d.source) as SheetRow | undefined;
  const lastOk = iso(ok?.finished_at ?? ok?.started_at ?? null);
  const j = judge({
    lastOk,
    lastAttempt: latest
      ? { at: iso(latest.started_at)!, failed: latest.status === "failed", running: latest.status === "running", error: latest.error }
      : null,
    staleAfter: d.staleAfter,
    currentWord: "Current",
  });
  const conflicts = d.conflictsOn ? r.conflicts.get(d.conflictsOn) ?? 0 : null;
  let detail: string;
  if (j.state === "failing") detail = firstLine(latest?.error) || "The last read failed";
  else if (!ok) detail = "No read recorded on this database";
  else if (d.suffix && j.state === "behind") detail = d.suffix(ageWords(lastOk));
  else
    detail =
      `${num(Number(ok.rows_read))} rows read · ${num(Number(ok.rows_created))} new · ${num(Number(ok.rows_updated))} changed` +
      (Number(ok.rows_with_issues) ? ` · ${num(Number(ok.rows_with_issues))} with issues` : "");
  if (conflicts) detail += ` · ${plural(conflicts, "conflict")} waiting`;
  if (d.staleAfter == null && lastOk) j.stateWord = `By hand · ${ageWords(lastOk)} ago`;
  return {
    key: d.key,
    label: d.label,
    readsFrom: d.readsFrom,
    expected: d.expected,
    staleAfterHours: d.staleAfter,
    lastSuccessAt: lastOk,
    lastAttemptAt: iso(latest?.started_at ?? null),
    lastResult: latest
      ? latest.status === "failed"
        ? firstLine(latest.error, 300) || "Failed"
        : `${num(Number(latest.rows_read))} read · ${num(Number(latest.rows_created))} new · ${num(Number(latest.rows_updated))} changed`
      : null,
    ...j,
    detail,
    job: d.job,
    dryRun: false,
    history: { kind: "sheet", source: d.source },
    href: d.href,
  };
}

type JobDef = {
  key: string;
  label: string;
  readsFrom: string;
  expected: string;
  staleAfter: number | null;
  marker: string;
  job: JobName | null;
  jobOptions?: JobOptions;
  dryRun?: boolean;
  history: string[];
  currentWord?: string;
  detail?: (row: JobRow | undefined) => string;
};

function jobSource(d: JobDef, r: Awaited<ReturnType<typeof readAll>>): FreshSource {
  const latest = r.jobLatest.get(d.marker) as JobRow | undefined;
  const ok = r.jobOk.get(d.marker) as JobRow | undefined;
  const lastOk = iso(ok?.finished_at ?? null);
  const j = judge({
    lastOk,
    lastAttempt: latest
      ? { at: iso(latest.started_at)!, failed: !latest.ok, running: latest.ok && !latest.finished_at, error: latest.detail }
      : null,
    staleAfter: d.staleAfter,
    currentWord: d.currentWord ?? "Ran",
  });
  if (d.staleAfter == null && lastOk && j.state === "unjudged") j.stateWord = `By hand · ${ageWords(lastOk)} ago`;
  const detail =
    j.state === "failing"
      ? firstLine(latest?.detail) || "The last run failed"
      : !ok
        ? "No run recorded on this database"
        : d.detail
          ? d.detail(ok)
          : firstLine(ok.detail) || `${plural(Number(ok.records_affected), "record")} touched`;
  return {
    key: d.key,
    label: d.label,
    readsFrom: d.readsFrom,
    expected: d.expected,
    staleAfterHours: d.staleAfter,
    lastSuccessAt: lastOk,
    lastAttemptAt: iso(latest?.started_at ?? null),
    lastResult: latest ? firstLine(latest.detail, 300) || (latest.ok ? "Ran" : "Failed") : null,
    ...j,
    detail,
    job: d.job,
    jobOptions: d.jobOptions,
    dryRun: Boolean(d.dryRun),
    history: { kind: "jobs", jobs: d.history },
  };
}

function nightlySource(n: NightlyPass): FreshSource {
  const total = NIGHTLY_STEPS.length;
  const complete = n.okCount === total;
  const lastOk = complete ? n.finishedAt : null;
  let state: FreshState;
  let stateWord: string;
  let tone: Tone;
  if (!n.startedAt) [state, stateWord, tone] = ["never", "Never run", "muted"];
  else if (n.failedStep) [state, stateWord, tone] = ["failing", "Stopped part way", "bad"];
  else if (n.steps.some((s) => s.running) && hoursSinceMs(n.startedAt) < 1)
    [state, stateWord, tone] = ["running", "Running", "info"];
  else if (hoursSinceMs(n.startedAt) > STALE_AFTER_HOURS.nightly) [state, stateWord, tone] = ["behind", "Stale", "bad"];
  else if (!complete) [state, stateWord, tone] = ["failing", "Incomplete", "bad"];
  else [state, stateWord, tone] = ["current", "Ran", "good"];
  const took =
    n.startedAt && n.finishedAt
      ? (() => {
          const s = Math.round((new Date(n.finishedAt).getTime() - new Date(n.startedAt).getTime()) / 1000);
          return s >= 60 ? `${Math.floor(s / 60)} m ${s % 60} s` : `${s} s`;
        })()
      : null;
  const detail = !n.startedAt
    ? "No nightly pass recorded on this database"
    : n.failedStep
      ? `${stepWords(n.failedStep.job)} failed: ${firstLine(n.failedStep.detail, 80)}`
      : `${n.okCount} of ${total} steps${took ? ` · ${took}` : ""}`;
  return {
    key: "nightly",
    label: "Nightly recompute",
    readsFrom: "Every derived value — buying cycles, outstanding, follow-up stages, the inactive watch, scores, call lists",
    expected: "Nightly",
    staleAfterHours: STALE_AFTER_HOURS.nightly,
    lastSuccessAt: lastOk ?? null,
    lastAttemptAt: n.startedAt,
    lastResult: n.startedAt ? detail : null,
    state,
    stateWord,
    tone,
    detail,
    job: "nightly",
    dryRun: false,
    history: { kind: "jobs", jobs: [...NIGHTLY_STEPS] },
  };
}

/** Every source, judged once. */
export async function freshnessSources(): Promise<FreshSource[]> {
  const r = await readAll();
  const out: FreshSource[] = [];

  for (const d of SHEETS.slice(0, 4)) out.push(sheetSource(d, r));

  const owner = process.env.SYNC_OWNER_EMAIL?.trim() || null;
  out.push(
    jobSource(
      {
        key: "publish",
        label: "Published into the CRM",
        readsFrom: "Staged order-sheet rows turned into customers and orders",
        expected: "30 min",
        staleAfter: STALE_AFTER_HOURS.halfHourly,
        marker: "project-sheet",
        // The half-hourly cycle publishes as the server's sync owner. Where the
        // app itself does not know who that is, nothing can be run from here —
        // a publish with nobody named assigns new customers to nobody.
        job: owner ? "project-sheet" : null,
        jobOptions: owner ? { owner } : undefined,
        history: ["project-sheet"],
      },
      r,
    ),
  );

  out.push(nightlySource(r.nightly));

  out.push(
    jobSource(
      {
        key: "hourly",
        label: "Hourly cycle",
        readsFrom: "Escalations, WhatsApp rules, the complaint deadline and this month's scores",
        expected: "Hourly",
        staleAfter: STALE_AFTER_HOURS.hourly,
        marker: "escalate-complaint-sla",
        job: "hourly",
        history: ["mbos-hourly", "whatsapp-automation", "sweep-unconfirmed", "escalate-complaint-sla"],
      },
      r,
    ),
  );

  out.push(
    jobSource(
      {
        key: "health_snapshot",
        label: "Customer health snapshot",
        readsFrom: "Where each customer's buying stood at the end of the night",
        expected: "Nightly",
        staleAfter: STALE_AFTER_HOURS.nightly,
        marker: "snapshot-customer-health",
        job: null,
        history: ["snapshot-customer-health"],
      },
      r,
    ),
  );

  out.push(
    jobSource(
      {
        key: "performance",
        label: "Salesman scores",
        readsFrom: "This month's score for everybody holding a target",
        expected: "Hourly",
        staleAfter: STALE_AFTER_HOURS.hourly,
        marker: "recompute-performance",
        job: null,
        history: ["recompute-performance"],
      },
      r,
    ),
  );

  for (const d of SHEETS.slice(4)) out.push(sheetSource(d, r));

  out.push(
    jobSource(
      {
        key: "customer_master_publish",
        label: "EMP 2.0 · shop master into customers",
        readsFrom: "The staged shop master, published as customers",
        expected: "By hand",
        staleAfter: null,
        marker: "customer-master-project",
        job: "customer-master-project",
        dryRun: true,
        history: ["customer-master-project"],
      },
      r,
    ),
  );

  out.push(
    jobSource(
      {
        key: "call_intel",
        label: "Call assistant model",
        readsFrom: "Logged calls, relearned each night",
        expected: "Nightly",
        staleAfter: STALE_AFTER_HOURS.callAssistant,
        marker: "call-intel-train",
        job: "call-intel-train",
        history: ["call-intel-train"],
      },
      r,
    ),
  );

  /* Wati — the last thing its webhook wrote. */
  const wati = r.secrets.find((s) => s.name === "wati.apiToken");
  const watiAt = iso(r.watiAt);
  {
    const configured = wati && wati.source !== "unset";
    let state: FreshState, stateWord: string, tone: Tone, detail: string;
    if (!configured) {
      [state, stateWord, tone] = ["unconfigured", "Not configured", "muted"];
      detail = "No Wati key. Only a platform admin can set it.";
    } else if (!watiAt) {
      [state, stateWord, tone] = ["unjudged", "No events yet", "muted"];
      detail = "The webhook has not reported anything yet";
    } else if (hoursSinceMs(watiAt) <= STALE_AFTER_HOURS.watiQuiet) {
      [state, stateWord, tone] = ["current", "Connected", "good"];
      detail = `Last webhook ${ageWords(watiAt)} ago`;
    } else {
      [state, stateWord, tone] = ["unjudged", "Quiet", "warn"];
      detail = `Last webhook ${ageWords(watiAt)} ago`;
    }
    out.push({
      key: "wati",
      label: "Wati",
      readsFrom: "WhatsApp delivery receipts and customers' replies, reported by Wati's webhook",
      expected: "Live",
      staleAfterHours: null,
      lastSuccessAt: watiAt,
      lastAttemptAt: watiAt,
      lastResult: watiAt ? "Delivery receipt or reply received" : null,
      state,
      stateWord,
      tone,
      detail,
      job: null,
      dryRun: false,
      history: { kind: "none" },
      href: { label: "WhatsApp desk", url: "/founder/whatsapp" },
    });
  }

  /* Handsets — a salesman checked in and working whose phone has gone quiet. */
  {
    const h = r.handsets ?? { working: 0, quiet: 0, devices: 0, last: null };
    const quiet = Number(h.quiet);
    const working = Number(h.working);
    let state: FreshState, stateWord: string, tone: Tone, detail: string;
    if (!Number(h.devices)) {
      [state, stateWord, tone] = ["never", "No handsets", "muted"];
      detail = "No handset is bound to anybody";
    } else if (!working) {
      [state, stateWord, tone] = ["unjudged", "Nobody working", "muted"];
      detail = `${plural(Number(h.devices), "handset")} bound · nobody checked in right now`;
    } else if (quiet) {
      [state, stateWord, tone] = ["behind", `${num(quiet)} quiet`, "warn"];
      detail = `${plural(quiet, "handset")} of ${num(working)} working unsynced > ${STALE_AFTER_HOURS.handsetQuiet} h`;
    } else {
      [state, stateWord, tone] = ["current", "Syncing", "good"];
      detail = `All ${plural(working, "working handset")} heard within ${STALE_AFTER_HOURS.handsetQuiet} h`;
    }
    out.push({
      key: "handsets",
      label: "MBOS handsets",
      readsFrom: "Each salesman's phone, whenever it syncs",
      expected: "Continuous",
      staleAfterHours: STALE_AFTER_HOURS.handsetQuiet,
      lastSuccessAt: iso(h.last),
      lastAttemptAt: iso(h.last),
      lastResult: null,
      state,
      stateWord,
      tone,
      detail,
      job: null,
      dryRun: false,
      history: { kind: "none" },
      href: { label: "Sync health", url: "/sales/sync-health" },
    });
  }

  /* AI providers — whether a key is held, and nothing more (no call per page load). */
  for (const [name, key, label, what] of [
    ["openai.apiKey", "openai", "OpenAI", "the call assistant, dictation's writing and price-list reading"],
    ["sarvam.apiKey", "sarvam", "Sarvam", "dictation in Indian languages"],
  ] as const) {
    const s = r.secrets.find((x) => x.name === name);
    const set = s && s.source !== "unset";
    out.push({
      key,
      label,
      readsFrom: `Used for ${what}`,
      expected: "Live",
      staleAfterHours: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastResult: null,
      state: set ? "current" : "unconfigured",
      stateWord: set ? "Key set" : "Not configured",
      tone: set ? "good" : "muted",
      detail: set
        ? s!.source === "console"
          ? `Console key${s!.last4 ? ` ending ${s!.last4}` : ""}${s!.updatedAt ? ` · changed ${dayMonth(s!.updatedAt)}` : ""}`
          : "Key from the server environment"
        : `No key, so ${what} cannot run. Only a platform admin can set it.`,
      job: null,
      dryRun: false,
      history: { kind: "none" },
    });
  }

  return out;
}

export function summarise(sources: FreshSource[]): FreshnessSummary {
  const stale = sources.filter((s) => s.state === "behind" || s.state === "failing").length;
  const current = sources.filter((s) => s.state === "current" || s.state === "running").length;
  const unset = sources.filter((s) => s.state === "never" || s.state === "unconfigured").length;
  const failing = sources.some((s) => s.state === "failing");
  const parts = [
    stale ? `${plural(stale, "source")} stale` : null,
    stale ? `${num(current)} current` : `${current === 1 ? "1 source" : `${num(current)} sources`} current`,
    unset ? `${num(unset)} not set up` : null,
  ].filter(Boolean);
  return {
    tone: failing ? "bad" : stale ? "warn" : current ? "good" : "muted",
    line: parts.join(" · "),
    staleCount: stale,
    currentCount: current,
    sources,
  };
}

/** The sidebar footer's line, and the list the System section draws. */
export async function freshnessSummary(): Promise<FreshnessSummary> {
  return summarise(await freshnessSources());
}
