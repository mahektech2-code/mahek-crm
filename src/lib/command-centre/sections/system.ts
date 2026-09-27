import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { runJob, type JobResult } from "@/lib/jobs";
import {
  ageWords,
  clockOrDay,
  freshnessSources,
  istDay,
  NIGHTLY_STEPS,
  nightlyPass,
  shortStamp,
  stepWords,
  summarise,
  type FreshSource,
} from "../freshness";
import { num, plural } from "../format";
import {
  auditFor,
  emptyPage,
  notesFor,
  refusal,
  slice,
  stampIST,
  withPage,
  type Ctx,
  type SectionProvider,
  type TableQuery,
} from "../provider";
import type { Bar, Cell, FigureDrawer, Metric, RecordView, Result, Row, SectionPayload, TableDef, TablePage } from "../types";

/* ---------------------------------------------------------------------------
 * SYSTEM HEALTH (PRD §21) — every source behind the numbers, whether it is
 * current, and a door to run it.
 *
 * Freshness is judged once, in `../freshness.ts`, so the sidebar's line, this
 * list and Needs you cannot disagree. "Run now" and "Dry run" go through the
 * job runner every other door uses (`runJob`, behind `config.write` exactly as
 * the Admin Console's `triggerJob`), so a run here writes the same `job_runs`
 * and `sheet_sync_runs` records and is reopened from the same history.
 * ------------------------------------------------------------------------- */

const TITLE = "System health";
const NOTE_KIND = "system_source";

const SOURCES_DEF: TableDef = {
  key: "sources",
  title: "Every source behind the numbers",
  hint: "Run, dry-run or repair · each run is recorded",
  noun: "source",
  rec: "Sync",
  acts: [
    { key: "run", label: "Run now", confirm: "It runs against live data and writes a result record you can reopen.", done: "Run" },
    { key: "dry", label: "Dry run", confirm: "Nothing is written. You see what it would change.", done: "Dry-run" },
  ],
  actW: "180px",
  min: 880,
  cols: [
    ["Source", "1.5fr"],
    ["Last success", "1fr"],
    ["Expected", "0.9fr"],
    ["State", "0.9fr"],
    ["Detail", "1.8fr"],
  ],
};

function actsFor(s: FreshSource): string[] {
  if (!s.job) return [];
  return s.dryRun ? ["run", "dry"] : ["run"];
}

function rowOf(s: FreshSource): Row {
  const cells: Cell[] = [
    { t: s.label },
    { t: s.lastSuccessAt ? shortStamp(s.lastSuccessAt) : "—" },
    { t: s.expected },
    { t: s.stateWord, pill: s.tone },
    { t: s.detail },
  ];
  return { id: s.key, cells, acts: actsFor(s) };
}

function pageOfSources(all: FreshSource[], query: TableQuery): TablePage {
  const r = slice(all, query, (s, q) =>
    [s.label, s.stateWord, s.detail, s.readsFrom].some((x) => x.toLowerCase().includes(q)),
  );
  return { rows: r.rows.map(rowOf), count: r.count, total: r.total, page: r.page, size: query.size, q: query.q };
}

/* ---------------------------------------------------------------- metrics */

function metricsFrom(all: FreshSource[]): Metric[] {
  const sum = summarise(all);
  const by = new Map(all.map((s) => [s.key, s]));
  const stale = all.filter((s) => s.state === "behind" || s.state === "failing");

  const order = by.get("order_details")!;
  const nightly = by.get("nightly")!;
  const hr = by.get("employee_details")!;
  const ai = [by.get("openai")!, by.get("sarvam")!];
  const aiSet = ai.filter((s) => s.state === "current");

  const pass = nightly.lastAttemptAt;
  const nightlySteps = /^(\d+) of (\d+) steps/.exec(nightly.detail);

  return [
    {
      key: "sources",
      label: "Sources current",
      value: `${num(sum.currentCount)} of ${num(all.length)}`,
      sub: stale.length ? `Behind: ${stale.map((s) => s.label).join(", ")}` : "",
      kind: "Now",
      tone: sum.tone,
    },
    {
      key: "order-sheet",
      label: "Order sheet",
      value: order.lastSuccessAt ? clockOrDay(order.lastSuccessAt) : "Never",
      sub:
        order.state === "failing"
          ? `failing — ${order.detail}`
          : order.lastSuccessAt
            ? order.state === "behind"
              ? `last read ${ageWords(order.lastSuccessAt)} ago · expected every 30 minutes`
              : "synced every 30 minutes"
            : "no read recorded on this database",
      kind: "Now",
      tone: order.tone,
    },
    {
      key: "nightly",
      label: "Nightly jobs",
      value: nightlySteps ? `${nightlySteps[1]} of ${nightlySteps[2]}` : pass ? nightly.stateWord : "None yet",
      sub: pass
        ? istDay(pass) === istDay(new Date())
          ? `ran at ${clockOrDay(pass)}${nightly.state === "failing" ? ` · ${nightly.detail}` : ""}`
          : `last ran ${clockOrDay(pass)}${nightly.state === "failing" ? ` · ${nightly.detail}` : ""}`
        : "no nightly pass recorded on this database",
      kind: "Now",
      tone: nightly.tone,
    },
    {
      key: "hr-sheet",
      label: "HR sheet",
      value: hr.lastSuccessAt ? clockOrDay(hr.lastSuccessAt) : "Never",
      sub: hr.lastSuccessAt
        ? `${ageWords(hr.lastSuccessAt)} — only syncs when HRMS opens`
        : "never synced — it only syncs when HRMS opens",
      kind: "Now",
      tone: hr.tone,
    },
    {
      key: "ai-providers",
      label: "AI providers",
      value: `${aiSet.length} of ${ai.length}`,
      sub:
        aiSet.length === ai.length
          ? "OpenAI and Sarvam keys set"
          : aiSet.length
            ? `${aiSet[0]!.label} key set · ${ai.find((s) => s.state !== "current")!.label} not configured`
            : "no provider key set",
      kind: "Now",
      tone: aiSet.length === ai.length ? "good" : aiSet.length ? "warn" : "bad",
    },
  ];
}

/* ---------------------------------------------------------------- figures */

async function dailyRuns(kind: "sheet" | "jobs", key: string | string[]): Promise<Bar[]> {
  const days = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.now() - (11 - i) * 86_400_000);
    return istDay(d);
  });
  const rows = (await (kind === "sheet"
    ? db.execute(sql`
        select to_char(s.started_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as day, count(*)::int as n
          from sheet_sync_runs s
         where s.source = ${key as string} and s.status = 'ok'
           and s.started_at >= now() - interval '12 days'
         group by 1`)
    : db.execute(sql`
        select to_char(j.started_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as day, count(distinct j.job)::int as n
          from job_runs j
         where j.job in (${sql.join((key as string[]).map((k) => sql`${k}`), sql`, `)}) and j.ok and j.finished_at is not null
           and j.started_at >= now() - interval '12 days'
         group by 1`))) as unknown as { day: string; n: number }[];
  const by = new Map(rows.map((r) => [r.day, Number(r.n)]));
  return days.map((d, i) => ({
    h: by.get(d) ?? 0,
    tip: `${Number(d.slice(8))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(d.slice(5, 7)) - 1]} · ${by.get(d) ?? 0}`,
    ...(i === 11 ? { current: true } : {}),
  }));
}

async function recentSheetRuns(source: string, limit: number) {
  return (await db.execute(sql`
    select s.id, s.mode, s.status, s.started_at, s.finished_at, s.rows_read, s.rows_created, s.rows_updated,
           s.rows_unchanged, s.rows_with_issues, s.error, u.name as by
      from sheet_sync_runs s left join users u on u.id = s.triggered_by_id
     where s.source = ${source}
     order by s.started_at desc limit ${limit}`)) as unknown as {
    id: string;
    mode: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    rows_read: number;
    rows_created: number;
    rows_updated: number;
    rows_unchanged: number;
    rows_with_issues: number;
    error: string | null;
    by: string | null;
  }[];
}

async function recentJobRuns(jobs: string[], limit: number) {
  return (await db.execute(sql`
    select j.id, j.job, j.ok, j.started_at, j.finished_at, j.records_affected, j.detail, u.name as by
      from job_runs j left join users u on u.id = j.triggered_by_id
     where j.job in (${sql.join(jobs.map((k) => sql`${k}`), sql`, `)})
     order by j.started_at desc limit ${limit}`)) as unknown as {
    id: string;
    job: string;
    ok: boolean;
    started_at: string;
    finished_at: string | null;
    records_affected: number;
    detail: string | null;
    by: string | null;
  }[];
}

const MODE_WORD: Record<string, string> = { append: "New rows read", reconcile: "Full compare", reparse: "Stored rows re-read" };

function sheetRunLine(r: Awaited<ReturnType<typeof recentSheetRuns>>[number]): string {
  const what = MODE_WORD[r.mode] ?? "Read";
  if (r.status === "failed") return `${what} — failed: ${(r.error ?? "no reason recorded").split("\n")[0]}`;
  if (r.status === "running") return `${what} — ${r.finished_at ? "ended" : "still running or did not finish"}`;
  return `${what} — ${num(Number(r.rows_read))} read · ${num(Number(r.rows_created))} new · ${num(Number(r.rows_updated))} changed` +
    (Number(r.rows_with_issues) ? ` · ${num(Number(r.rows_with_issues))} with issues` : "");
}

function jobRunLine(r: Awaited<ReturnType<typeof recentJobRuns>>[number]): string {
  const state = !r.ok ? "failed" : r.finished_at ? "ran" : "still running or did not finish";
  const d = (r.detail ?? "").split("\n")[0]!.trim();
  return `${stepWords(r.job)} ${state}${d ? ` — ${d}` : ""}`;
}

function facts(kind: string, basis: string, source: string) {
  const asOf = stampIST(new Date());
  return [
    { label: "Kind", value: kind },
    { label: "As of", value: asOf },
    { label: "Basis", value: basis },
    { label: "Scope", value: "Company-wide · every source" },
    { label: "Source", value: source },
  ];
}

/* ---------------------------------------------------------------- provider */

export const provider: SectionProvider = {
  async section(): Promise<SectionPayload> {
    const all = await freshnessSources();
    return {
      metrics: metricsFrom(all),
      callouts: [],
      tables: [withPage(SOURCES_DEF, pageOfSources(all, { q: "", page: 1, size: 25 }))],
      foot: "Every stale or failing source here also appears in Needs you.",
    };
  },

  async tablePage(_ctx: Ctx, table: string, query: TableQuery): Promise<TablePage> {
    if (table !== "sources") return emptyPage(query);
    return pageOfSources(await freshnessSources(), query);
  },

  async figure(_ctx: Ctx, metric: string): Promise<FigureDrawer> {
    const all = await freshnessSources();
    const by = new Map(all.map((s) => [s.key, s]));
    const m = metricsFrom(all).find((x) => x.key === metric);
    if (!m) throw new Error("There is no such figure here.");
    const base = { kind: "Now figure · Data health", title: m.label, value: m.value };

    if (metric === "sources") {
      return {
        ...base,
        facts: facts("Now", "Each source judged against its own expected cadence", "Sync and job run records, the WhatsApp webhook, handsets, provider keys"),
        def: "Sources whose last successful run is inside their expected window, out of every source listed. A source is stale when its last success is older than its threshold (2 h for half-hourly reads, 2.5 h for the hourly cycle, 30 h for nightly work, 24 h for the HR sheet), and failing when its newest attempt failed. Sources run only by hand are not judged, and a source that has never run or has no key is counted apart from both.",
        bars: [],
        barsLabel: "No history is kept for this figure",
        rowsLabel: "Every source",
        rows: all.slice(0, 8).map((s) => ({ a: s.label, b: `${s.stateWord} · ${s.detail}`, c: s.lastSuccessAt ? shortStamp(s.lastSuccessAt) : "—" })),
      };
    }

    if (metric === "order-sheet") {
      const [bars, runs] = await Promise.all([dailyRuns("sheet", "order_details"), recentSheetRuns("order_details", 8)]);
      return {
        ...base,
        facts: facts("Now", "The newest successful read of the Order Details tab", "Sheet sync runs · Order Details"),
        def: "The time of the newest successful read of the order workbook's Order Details tab, new rows or full compare. It is expected every 30 minutes from the server's schedule and called stale after 2 hours.",
        bars,
        barsLabel: "Successful reads per day, last 12 days",
        rowsLabel: "Latest reads",
        rows: runs.map((r) => ({ a: shortStamp(r.started_at), b: sheetRunLine(r), c: r.by ?? "Schedule" })),
        noRowsLine: runs.length ? undefined : "No read of the Order Details tab is recorded on this database.",
      };
    }

    if (metric === "nightly") {
      const [bars, pass] = await Promise.all([dailyRuns("jobs", [...NIGHTLY_STEPS]), nightlyPass()]);
      return {
        ...base,
        facts: facts("Now", "The newest nightly pass, step by step", "Job runs"),
        def: `The steps of the newest nightly pass that finished successfully, out of the ${NIGHTLY_STEPS.length} a complete pass runs. A pass begins with the field app's tidy-up; a step that fails stops every step after it, so a partial pass leaves the later derived values from the night before.`,
        bars,
        barsLabel: "Nightly steps that ran each day, last 12 days",
        rowsLabel: "Steps of the newest pass",
        rows: pass.steps.slice(0, 8).map((s) => ({
          a: stepWords(s.job),
          b: s.failed ? `Failed — ${(s.detail ?? "").split("\n")[0]}` : s.ok ? (s.detail ?? "Ran").split("\n")[0]! : s.running ? "Running or did not finish" : "Did not run",
          c: s.ok ? num(s.records) : "—",
        })),
        noRowsLine: pass.startedAt ? undefined : "No nightly pass is recorded on this database.",
      };
    }

    if (metric === "hr-sheet") {
      const [bars, runs] = await Promise.all([dailyRuns("sheet", "employee_details"), recentSheetRuns("employee_details", 8)]);
      return {
        ...base,
        facts: facts("Now", "The newest successful read of the employee workbook", "Sheet sync runs · Employee Details"),
        def: "The date of the newest successful read of the HR sheet's Employee Details tab. Nothing schedules it: it is read only while somebody has HRMS open, so it goes stale over a weekend. Called stale after 24 hours.",
        bars,
        barsLabel: "Successful reads per day, last 12 days",
        rowsLabel: "Latest reads",
        rows: runs.map((r) => ({ a: shortStamp(r.started_at), b: sheetRunLine(r), c: r.by ?? "Schedule" })),
        noRowsLine: runs.length ? undefined : "No read of the HR sheet is recorded on this database.",
      };
    }

    // ai-providers
    const ai = [by.get("openai")!, by.get("sarvam")!];
    return {
      ...base,
      facts: facts("Now", "Whether a key is held for each provider", "Provider keys (presence only)"),
      def: "Of OpenAI and Sarvam, how many have a key set in the Admin Console or the server environment. Only whether a key is held is read — no provider is called to fill this in, and a key being set does not prove the provider is answering.",
      bars: [],
      barsLabel: "No history is kept for this figure",
      rowsLabel: "Providers",
      rows: ai.map((s) => ({ a: s.label, b: `${s.readsFrom} · ${s.detail}`, c: s.stateWord })),
    };
  },

  async record(_ctx: Ctx, table: string, id: string): Promise<RecordView> {
    if (table !== "sources") throw new Error("There is no such record here.");
    const all = await freshnessSources();
    const s = all.find((x) => x.key === id);
    if (!s) throw new Error("That source is no longer listed.");

    let runs: { what: string; when: string }[] = [];
    if (s.history.kind === "sheet") {
      runs = (await recentSheetRuns(s.history.source, 15)).map((r) => ({
        what: sheetRunLine(r),
        when: `${stampIST(r.started_at)} · ${r.by ?? "the schedule"}`,
      }));
    } else if (s.history.kind === "jobs") {
      runs = (await recentJobRuns(s.history.jobs, 15)).map((r) => ({
        what: jobRunLine(r),
        when: `${stampIST(r.started_at)} · ${r.by ?? "the schedule"}`,
      }));
    }

    const extra: { label: string; value: string }[] = [];
    if (s.key === "handsets") {
      const quiet = (await db.execute(sql`
        select u.name, d.last_seen_at from mbos_devices d
          join users u on u.id = d.user_id and u.active
          join mbos_attendance_days a on a.user_id = d.user_id
               and a.day = (now() at time zone 'Asia/Kolkata')::date
               and a.check_in_at is not null and a.check_out_at is null
         where d.active and (d.last_seen_at is null or d.last_seen_at < now() - interval '4 hours')
         order by d.last_seen_at asc nulls first limit 20`)) as unknown as { name: string; last_seen_at: string | null }[];
      extra.push({
        label: "Working but quiet",
        value: quiet.length
          ? quiet.map((q) => `${q.name} (${q.last_seen_at ? `${ageWords(q.last_seen_at)} ago` : "never"})`).join(", ")
          : "Nobody",
      });
    }

    const [notes, audit] = await Promise.all([notesFor(NOTE_KIND, s.key), auditFor(NOTE_KIND, s.key)]);
    return {
      kind: `${SOURCES_DEF.rec} · ${TITLE}`,
      title: s.label,
      sub: `${s.stateWord} · ${s.detail}`,
      fields: [
        { label: "Reads", value: s.readsFrom },
        { label: "Expected", value: s.expected },
        { label: "Called stale after", value: s.staleAfterHours == null ? "Not judged — run by hand or live" : `${s.staleAfterHours} hours` },
        { label: "State", value: s.stateWord },
        { label: "Last success", value: s.lastSuccessAt ? `${stampIST(s.lastSuccessAt)} · ${ageWords(s.lastSuccessAt)} ago` : "None recorded" },
        { label: "Last attempt", value: s.lastAttemptAt ? stampIST(s.lastAttemptAt) : "None recorded" },
        { label: "Last result", value: s.lastResult ?? "—" },
        {
          label: "Can be run from here",
          value: s.job ? (s.dryRun ? "Yes, and as a dry run first" : "Yes") : s.key === "publish" ? "No — the server's sync owner is not known to the app" : "No — it runs as part of another cycle, or is live",
        },
        ...extra,
      ],
      timeline: [...notes, ...runs],
      audit,
      acts: (SOURCES_DEF.acts ?? []).filter((a) => actsFor(s).includes(a.key)),
      href: s.href,
      noteTarget: { kind: NOTE_KIND, id: s.key },
    };
  },

  async act(ctx: Ctx, table: string, act: string, id: string): Promise<Result> {
    if (table !== "sources") return { ok: false, error: "There is nothing to do on that list." };
    const all = await freshnessSources();
    const s = all.find((x) => x.key === id);
    if (!s) return { ok: false, error: "That source is no longer listed." };
    if (!s.job) return { ok: false, error: `Nothing can be run from here for ${s.label}.` };
    if (act !== "run" && act !== "dry") return { ok: false, error: "That action is not offered here." };
    if (act === "dry" && !s.dryRun) return { ok: false, error: `${s.label} has no dry run — it writes whenever it runs.` };

    try {
      // The same gate the Admin Console's `triggerJob` applies before `runJob`.
      const cap = await requireCapability("config.write");
      const dry = act === "dry";
      const results: JobResult[] = await runJob(s.job, cap.user.id ?? ctx.userId, { ...(s.jobOptions ?? {}), dryRun: dry || undefined });
      const touched = results.reduce((a, r) => a + r.recordsAffected, 0);
      const said =
        results.length === 1
          ? (results[0]!.detail || `${plural(touched, "record")} touched`).split("\n")[0]!.slice(0, 300)
          : `${plural(results.length, "step")} ran · ${plural(touched, "record")} touched`;

      await db.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId: cap.user.id,
        actorRole: cap.authorisedBy,
        actorApp: cap.authorisedIn ?? "founder",
        action: dry ? "job.dry_run" : "job.run",
        entityType: NOTE_KIND,
        entityId: s.key,
        afterState: { job: s.job, dryRun: dry, results } as never,
      });

      return { ok: true, message: `${dry ? "Dry-run" : "Run"} · ${s.label} — ${said}` };
    } catch (e) {
      return refusal(e);
    }
  },
};
