import "server-only";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  appSettings,
  auditLog,
  jobRuns,
  notifications,
  sessions,
  sheetSyncRuns,
  users,
} from "@/db/schema";
import { APPS, type AppId } from "@/lib/apps";
import { APP_TIMEZONE } from "@/lib/business-date";
import { SETTINGS } from "@/lib/config/registry";
import { getConfig, configWarnings } from "@/lib/config/store";
import { sheetsConfigured } from "@/lib/sheets";
import { mailConfigured } from "@/lib/mailer";

/* ---------------------------------------------------------------------------
 * The platform sections of the Admin Console, answered from the database.
 *
 * What replaced a file of fixtures. Every screen under Overview, Apps, Data,
 * Notifications and Audit rendered invented numbers — a failing integration
 * that does not exist, a nightly backup nobody runs, fourteen unassigned
 * customers that were a literal `14`. A console is where somebody goes to find
 * out whether the platform is all right; one that answers from a fixture file
 * is worse than one that does not answer at all, because it is believed.
 *
 * The rule applied throughout: where the database can answer, it answers, and
 * where nothing can answer, the screen is GONE rather than filled in. A tab
 * that cannot be honest is a tab that should not exist — access requests,
 * lockout counters, grant expiry, backup status and feature flags all left
 * with their fixtures, because none of them is a thing MahekOne records.
 * ------------------------------------------------------------------------- */

export type Tone = "danger" | "warn" | "neutral" | "success";

/* ------------------------------------------------------------- attention */

export type AttentionItem = {
  n: number;
  one: string;
  many: string;
  detail: string;
  tone: Tone;
  cta: string;
  /** Where the button goes: a console address, or an app route. */
  go: { section: string; tab: string } | { href: string };
};

/**
 * What needs somebody today.
 *
 * Only rows something can actually be done about, and every count is a query.
 * An item at zero is dropped rather than shown as a reassuring green line —
 * this list is a worklist, not a dashboard.
 */
export async function attentionItems(): Promise<AttentionItem[]> {
  const [
    unassigned,
    failedJobs,
    unreadFeedback,
    sheetIssues,
    unresolvedSkus,
    neverSignedIn,
    noApps,
    warnings,
  ] = await Promise.all([
    count(sql`select count(*)::int as n from customers
                where kind = 'customer' and status <> 'deactivated'
                  and owner_id is null and sales_am_id is null`),
    count(sql`select count(*)::int as n from job_runs
                where ok = false and started_at > now() - interval '7 days'`),
    count(sql`select count(*)::int as n from feedback where status = 'new'`),
    count(sql`select count(*)::int as n from sheet_order_rows
                where status = 'present' and jsonb_array_length(issues) > 0`),
    count(sql`select count(*)::int as n from products
                where status = 'needs_canonical_id'`),
    // Attendance is the fallback, because `last_login_at` only started being
    // written recently: an account with a day recorded HAS signed in, whatever
    // the column says, and accusing it would be a false alarm on this list.
    count(sql`select count(*)::int as n from users u
                where u.active = true and u.last_login_at is null
                  and not exists (select 1 from attendance a where a.user_id = u.id)`),
    count(sql`select count(*)::int as n from users u
                where u.active = true
                  and not exists (select 1 from app_access a where a.user_id = u.id)`),
    configWarnings(),
  ]);

  const items: AttentionItem[] = [
    {
      n: failedJobs,
      one: "scheduled job failed",
      many: "scheduled jobs failed",
      detail:
        "A job that did not finish leaves a derived figure stale — the queue, the stages or the outstanding are describing yesterday.",
      tone: "danger",
      cta: "Open job health",
      go: { section: "overview", tab: "jobs" },
    },
    {
      n: warnings.length,
      one: "setting contradicts another",
      many: "settings contradict each other",
      detail:
        "Two thresholds that disagree put two screens in conflict about the same account.",
      tone: "danger",
      cta: "Open configuration",
      go: { section: "overview", tab: "drift" },
    },
    {
      n: unassigned,
      one: "customer in nobody's book",
      many: "customers in nobody's book",
      detail: "No owner and no sales account manager, so they appear in no queue.",
      tone: "warn",
      cta: "Open in the CRM",
      go: { href: "/crm/customers" },
    },
    {
      n: unreadFeedback,
      one: "report nobody has read",
      many: "reports nobody has read",
      detail: "Sent from inside the apps by somebody waiting for an answer.",
      tone: "warn",
      cta: "Open feedback",
      go: { section: "feedback", tab: "new" },
    },
    {
      n: sheetIssues,
      one: "imported order row needs attention",
      many: "imported order rows need attention",
      detail: "Rows the sheet import could not read cleanly. Nothing is dropped silently.",
      tone: "warn",
      cta: "Open the order sheet",
      go: { section: "sheet", tab: "issues" },
    },
    {
      n: unresolvedSkus,
      one: "SKU cannot be ordered until somebody chooses",
      many: "SKUs cannot be ordered until somebody chooses",
      detail:
        "One name, two legacy product IDs. They stay unorderable until a person picks the canonical one.",
      tone: "warn",
      cta: "Open the catalogue",
      go: { section: "catalogue", tab: "duplicates" },
    },
    {
      n: noApps,
      one: "account can open nothing",
      many: "accounts can open nothing",
      detail: "An active account with no app is somebody who cannot start work.",
      tone: "neutral",
      cta: "Open app access",
      go: { section: "people", tab: "access" },
    },
    {
      n: neverSignedIn,
      one: "account has never signed in",
      many: "accounts have never signed in",
      detail: "Created, but nobody has used it — usually a password that never arrived.",
      tone: "neutral",
      cta: "Open onboarding",
      go: { section: "people", tab: "onboarding" },
    },
  ];

  return items.filter((i) => i.n > 0);
}

/* ---------------------------------------------------------------- health */

export type Fact = { label: string; value: string; sub: string };

export type AppHealth = {
  id: AppId;
  name: string;
  built: boolean;
  /** Accounts holding this app. */
  granted: number;
  /** Settings the app publishes, or null where it publishes no schema. */
  settings: number | null;
};

export async function platformHealth(): Promise<{ facts: Fact[]; apps: AppHealth[] }> {
  const [people, activeSessions, customerCount, lastSync, dbSize] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${users.active})::int`,
      })
      .from(users),
    count(sql`select count(*)::int as n from sessions where expires_at > now()`),
    count(sql`select count(*)::int as n from customers where status <> 'deactivated'`),
    db
      .select({ finishedAt: sheetSyncRuns.finishedAt, status: sheetSyncRuns.status })
      .from(sheetSyncRuns)
      .orderBy(desc(sheetSyncRuns.startedAt))
      .limit(1),
    one<{ size: string }>(sql`select pg_size_pretty(pg_database_size(current_database())) as size`),
  ]);

  const grants = await db
    .select({ app: appAccess.app, n: sql<number>`count(*)::int` })
    .from(appAccess)
    .groupBy(appAccess.app);
  const grantedBy = new Map(grants.map((g) => [g.app as AppId, g.n]));

  // Only the CRM publishes a schema today. Counting the registry rather than
  // stating a number keeps this true the day a second app publishes one.
  const crmSettings = SETTINGS.length;

  const facts: Fact[] = [
    {
      label: "Accounts",
      value: String(people[0]?.active ?? 0),
      sub: `${people[0]?.total ?? 0} in total, including deactivated`,
    },
    {
      label: "Signed in now",
      value: String(activeSessions),
      sub: "Sessions that have not expired",
    },
    {
      label: "Customers",
      value: String(customerCount),
      sub: "Excluding deactivated accounts",
    },
    {
      label: "Database",
      value: dbSize?.size ?? "—",
      sub: "Everything MahekOne stores, including attachment bytes",
    },
    {
      label: "Last sheet sync",
      value: lastSync[0]?.finishedAt ? stampOf(lastSync[0].finishedAt) : "Never",
      sub: lastSync[0] ? `Finished ${lastSync[0].status}` : "No sync has run on this database",
    },
  ];

  const apps: AppHealth[] = APPS.map((a) => ({
    id: a.id,
    name: a.name,
    built: a.built,
    granted: grantedBy.get(a.id) ?? 0,
    settings: a.id === "crm" ? crmSettings : null,
  }));

  return { facts, apps };
}

/* ---------------------------------------------------------- integrations */

export type Integration = {
  name: string;
  state: "Healthy" | "Failing" | "Not connected";
  last: string;
  note: string;
};

/**
 * What MahekOne actually talks to, and whether it is configured.
 *
 * "Configured" is the honest word: an API key present in the environment is
 * what can be checked without making a call, and making one on every console
 * load would bill somebody for a screen refresh. Where a subsystem records its
 * own last run — the sheets do — that run is what the row reports.
 */
export async function integrationStatus(): Promise<Integration[]> {
  const runs = await db
    .select({
      source: sheetSyncRuns.source,
      status: sheetSyncRuns.status,
      finishedAt: sheetSyncRuns.finishedAt,
      startedAt: sheetSyncRuns.startedAt,
      error: sheetSyncRuns.error,
    })
    .from(sheetSyncRuns)
    .orderBy(desc(sheetSyncRuns.startedAt))
    .limit(50);

  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latest.has(r.source)) latest.set(r.source, r);

  const sheets = sheetsConfigured();
  const sheetRows: Integration[] = [...latest.entries()].map(([source, run]) => ({
    name: `Google Sheet — ${source}`,
    state: run.status === "failed" ? "Failing" : "Healthy",
    last: stampOf(run.finishedAt ?? run.startedAt),
    note:
      run.status === "failed"
        ? (run.error ?? "The last run failed.")
        : "Read-only. MahekOne never writes to the workbook.",
  }));

  const list: Integration[] = [
    {
      name: "Google Sheets service account",
      state: sheets ? "Healthy" : "Not connected",
      last: "—",
      note: sheets
        ? "Credentials present. The order, payment, taken-order and party tabs are readable."
        : "No service-account credentials, so no sheet can be read on this deployment.",
    },
    ...sheetRows,
    {
      name: "Outbound mail (Resend)",
      state: mailConfigured() ? "Healthy" : "Not connected",
      last: "—",
      note: mailConfigured()
        ? "Password reset links are sent."
        : "No API key, so reset mail is written to the server log instead of sent — and the screen says so.",
    },
    {
      name: "Attachment storage",
      state: "Healthy",
      last: "—",
      note: process.env.BLOB_READ_WRITE_TOKEN
        ? "Vercel Blob. Bytes live outside the database."
        : "Postgres. Bytes live in the same backup and point-in-time restore as the rows that refer to them.",
    },
    {
      name: "WhatsApp",
      state: "Not connected",
      last: "—",
      note: "There is no provider. Messages are prepared and copied by a person, and only a confirmed send counts.",
    },
  ];

  return list;
}

/* ----------------------------------------------------------------- usage */

export type UsageRow = { label: string; value: string; sub: string };

export async function usageStats(): Promise<{
  facts: UsageRow[];
  perUser: Array<{ name: string; role: string; calls: number; lastSeen: string | null }>;
}> {
  const [callsToday, callsWeek, signedInToday] = await Promise.all([
    // Never a bare cast: Postgres casts a timestamptz in the SESSION zone, and
    // on Neon that is GMT, which puts a 1am IST call on the previous day.
    count(sql`select count(*)::int as n from calls
                where (started_at at time zone ${APP_TIMEZONE})::date
                    = (now() at time zone ${APP_TIMEZONE})::date`),
    count(sql`select count(*)::int as n from calls
                where started_at > now() - interval '7 days'`),
    count(sql`select count(distinct user_id)::int as n from attendance
                where day = (now() at time zone ${APP_TIMEZONE})::date`),
  ]);

  const perUser = await db
    .select({
      name: users.name,
      role: users.role,
      calls: sql<number>`(
        select count(*)::int from calls c
         where c.user_id = users.id and c.started_at > now() - interval '7 days'
      )`,
      // Falling back to attendance: `last_login_at` only started being written
      // recently, and somebody with a day recorded plainly has signed in.
      lastSeen: sql<Date | null>`coalesce(
        users.last_login_at,
        (select max(a.signed_in_at) from attendance a where a.user_id = users.id)
      )`,
    })
    .from(users)
    .where(eq(users.active, true))
    .orderBy(desc(sql`(
      select count(*) from calls c
       where c.user_id = users.id and c.started_at > now() - interval '7 days'
    )`));

  return {
    facts: [
      { label: "Signed in today", value: String(signedInToday), sub: "Attendance opened for the day" },
      { label: "Calls logged today", value: String(callsToday), sub: "Across every telecaller" },
      { label: "Calls this week", value: String(callsWeek), sub: "Rolling seven days" },
    ],
    perUser: perUser.map((u) => ({
      name: u.name,
      role: u.role,
      calls: u.calls,
      lastSeen: u.lastSeen ? new Date(u.lastSeen).toISOString() : null,
    })),
  };
}

/* ------------------------------------------------------ configuration drift */

export type DriftRow = {
  key: string;
  label: string;
  category: string;
  current: string;
  fallback: string;
  changedAt: string | null;
  changedBy: string | null;
};

/**
 * Every setting that no longer matches the code's default, and who moved it.
 *
 * This is the screen that answers "why is this behaving differently from the
 * documentation" — which is a real question here, because `seedConfig` inserts
 * only missing keys, so a database keeps whatever it was seeded with even
 * after a default changes in the registry.
 */
export async function configDrift(): Promise<{ rows: DriftRow[]; warnings: string[] }> {
  const [config, warnings, stored] = await Promise.all([
    getConfig(),
    configWarnings(),
    db
      .select({
        key: appSettings.key,
        updatedAt: appSettings.updatedAt,
        updatedBy: sql<string | null>`(
          select name from users u where u.id = app_settings.updated_by_id
        )`,
      })
      .from(appSettings),
  ]);

  const meta = new Map(stored.map((s) => [s.key, s]));
  const rows: DriftRow[] = [];

  for (const setting of SETTINGS) {
    const current = config[setting.key as keyof typeof config];
    const fallback = setting.default;
    if (readable(current) === readable(fallback)) continue;
    const m = meta.get(setting.key);
    rows.push({
      key: setting.key,
      label: setting.label,
      category: setting.category,
      current: readable(current),
      fallback: readable(fallback),
      changedAt: m?.updatedAt ? m.updatedAt.toISOString() : null,
      changedBy: m?.updatedBy ?? null,
    });
  }

  return { rows, warnings };
}

/* ------------------------------------------------------------ job health */

export type JobRow = {
  job: string;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  records: number;
  detail: string | null;
  runs: number;
  failures: number;
};

/** The last run of each job, with how often it has failed in the past week. */
export async function jobHealth(): Promise<JobRow[]> {
  const rows = await db
    .select({
      job: jobRuns.job,
      startedAt: jobRuns.startedAt,
      finishedAt: jobRuns.finishedAt,
      ok: jobRuns.ok,
      records: jobRuns.recordsAffected,
      detail: jobRuns.detail,
    })
    .from(jobRuns)
    .orderBy(desc(jobRuns.startedAt))
    .limit(400);

  const weekly = await db
    .select({
      job: jobRuns.job,
      runs: sql<number>`count(*)::int`,
      failures: sql<number>`count(*) filter (where not ${jobRuns.ok})::int`,
    })
    .from(jobRuns)
    .where(gte(jobRuns.startedAt, sql`now() - interval '7 days'`))
    .groupBy(jobRuns.job);
  const byJob = new Map(weekly.map((w) => [w.job, w]));

  const latest = new Map<string, JobRow>();
  for (const r of rows) {
    if (latest.has(r.job)) continue;
    const w = byJob.get(r.job);
    latest.set(r.job, {
      job: r.job,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      ok: r.ok,
      records: r.records,
      detail: r.detail,
      runs: w?.runs ?? 0,
      failures: w?.failures ?? 0,
    });
  }

  return [...latest.values()].sort((a, b) => Number(a.ok) - Number(b.ok));
}

/* ---------------------------------------------------------------- audit */

export type AuditKind = "config" | "access" | "signin" | "work";

export type AuditRow = {
  kind: AuditKind;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: string;
  actor: string | null;
  at: string;
};

/**
 * The audit log, sorted into the three kinds the console shows.
 *
 * The kind is derived from the action rather than stored, because the log is
 * written by a dozen call sites that should not have to know how a console
 * groups them.
 */
export async function auditRows(limit = 400): Promise<AuditRow[]> {
  const rows = await db
    .select({
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      before: auditLog.beforeState,
      after: auditLog.afterState,
      at: auditLog.at,
      actor: sql<string | null>`(select name from users u where u.id = audit_log.actor_id)`,
    })
    .from(auditLog)
    .orderBy(desc(auditLog.at))
    .limit(limit);

  return rows.map((r) => ({
    kind: auditKind(r.action, r.entityType),
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    detail: auditDetail(r.before, r.after),
    actor: r.actor,
    at: r.at.toISOString(),
  }));
}

/**
 * Four kinds, derived from the action.
 *
 * Signing in is not an access CHANGE and business work is not an admin
 * action; folding either into "admin" is how an audit tab becomes a list
 * nobody can read a question out of. The kinds are derived here rather than
 * stored, because the dozen call sites that write the log should not have to
 * know how a console groups them.
 */
function auditKind(action: string, entityType: string): AuditKind {
  if (action === "sign-in" || action === "sign-out") return "signin";
  if (entityType === "setting" || action.includes("config") || action.includes("setting")) {
    return "config";
  }
  if (
    entityType === "user" ||
    action.includes("access") ||
    action.includes("role") ||
    action.includes("password") ||
    action.includes("deactivate")
  ) {
    return "access";
  }
  return "work";
}

function auditDetail(before: unknown, after: unknown): string {
  const pick = (v: unknown): string => {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const d = o.detail ?? o.message ?? o.reason;
      if (typeof d === "string") return d;
      return JSON.stringify(v);
    }
    return String(v);
  };
  const b = pick(before);
  const a = pick(after);
  if (b && a) return `${b} → ${a}`;
  return a || b || "—";
}

/* ------------------------------------------------------------------ data */

export type ImportRow = {
  source: string;
  tab: string;
  mode: string;
  status: string;
  read: number;
  created: number;
  updated: number;
  unchanged: number;
  issues: number;
  startedAt: string;
  finishedAt: string | null;
  by: string | null;
  error: string | null;
};

export async function importHistory(limit = 50): Promise<ImportRow[]> {
  const rows = await db
    .select({
      source: sheetSyncRuns.source,
      tab: sheetSyncRuns.tabTitle,
      mode: sheetSyncRuns.mode,
      status: sheetSyncRuns.status,
      read: sheetSyncRuns.rowsRead,
      created: sheetSyncRuns.rowsCreated,
      updated: sheetSyncRuns.rowsUpdated,
      unchanged: sheetSyncRuns.rowsUnchanged,
      issues: sheetSyncRuns.rowsWithIssues,
      startedAt: sheetSyncRuns.startedAt,
      finishedAt: sheetSyncRuns.finishedAt,
      error: sheetSyncRuns.error,
      by: sql<
        string | null
      >`(select name from users u where u.id = sheet_sync_runs.triggered_by_id)`,
    })
    .from(sheetSyncRuns)
    .orderBy(desc(sheetSyncRuns.startedAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  }));
}

export type MigrationRow = { tag: string; appliedAt: string };

/**
 * What the database has actually been through.
 *
 * Read from Drizzle's own bookkeeping table rather than the migrations folder,
 * because the question this answers is "is this database up to date", and the
 * folder is what SHOULD have been applied.
 */
export async function migrationStatus(): Promise<{
  applied: MigrationRow[];
  pending: number;
}> {
  const rows = await db.execute<{ hash: string; created_at: string }>(sql`
    select hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 30
  `);

  // The journal is the list of what exists in the repository. Comparing counts
  // is enough to say "this database is behind" without shipping the folder.
  const [{ n }] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from drizzle.__drizzle_migrations
  `);

  const journalLength = MIGRATION_COUNT;

  return {
    applied: rows.map((r) => ({
      tag: r.hash.slice(0, 12),
      appliedAt: new Date(Number(r.created_at)).toISOString(),
    })),
    pending: Math.max(0, journalLength - n),
  };
}

/**
 * How many migrations the repository holds. A constant rather than a file read
 * because the server bundle has no filesystem access to `drizzle/` in
 * production — and it only ever moves when somebody adds one.
 */
const MIGRATION_COUNT = 28;

/* --------------------------------------------------------- notifications */

export type NotificationRow = {
  title: string;
  body: string;
  kind: string;
  to: string;
  read: boolean;
  at: string;
};

export async function notificationLog(limit = 100): Promise<NotificationRow[]> {
  const rows = await db
    .select({
      title: notifications.title,
      body: notifications.body,
      kind: notifications.kind,
      read: notifications.read,
      at: notifications.createdAt,
      to: users.name,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}

/* -------------------------------------------------------------- sessions */

export type SessionRow = {
  id: string;
  user: string;
  role: string;
  startedAt: string;
  expiresAt: string;
};

/** Live sessions. There is no device or IP here, because none is stored. */
export async function liveSessions(): Promise<SessionRow[]> {
  const rows = await db
    .select({
      id: sessions.id,
      user: users.name,
      role: users.role,
      startedAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(gte(sessions.expiresAt, sql`now()`))
    .orderBy(desc(sessions.createdAt));

  return rows.map((r) => ({
    ...r,
    startedAt: r.startedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

/** Accounts that exist but have never been used, and what is missing. */
export async function onboardingRows(): Promise<
  Array<{ name: string; email: string; createdAt: string; apps: number }>
> {
  const rows = await db
    .select({
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
      apps: sql<number>`(select count(*)::int from app_access a where a.user_id = users.id)`,
    })
    .from(users)
    .where(
      and(
        eq(users.active, true),
        isNull(users.lastLoginAt),
        sql`not exists (select 1 from attendance a where a.user_id = users.id)`,
      ),
    )
    .orderBy(desc(users.createdAt));

  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/* ----------------------------------------------------------------- utils */

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const rows = await db.execute<{ n: number }>(query);
  return rows[0]?.n ?? 0;
}

async function one<T extends Record<string, unknown>>(
  query: ReturnType<typeof sql>,
): Promise<T | null> {
  const rows = await db.execute<T>(query);
  return (rows[0] as T | undefined) ?? null;
}

function readable(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function stampOf(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}
