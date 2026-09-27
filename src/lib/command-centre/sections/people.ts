import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { sheetSyncRuns } from "@/db/schema";
import { employeeMaster, type EmployeeRecord } from "@/lib/services/employee-service";
import { EMPLOYEE_SOURCE } from "@/lib/services/employee-sync-service";
import {
  auditFor,
  emptyPage,
  hoursSince,
  notesFor,
  slice,
  stampIST,
  withPage,
  type Ctx,
  type SectionProvider,
  type TableQuery,
} from "../provider";
import { fmtDate, fmtDay, monthLabel, num, plural } from "../format";
import type { Bar, Callout, Cell, FigureDrawer, RecordView, Row, TableDef, TablePage } from "../types";

/* ---------------------------------------------------------------------------
 * PEOPLE — the HR sheet's headcount and movement, and who holds which app
 * (PRD §19).
 *
 * Every employee figure is read off HRMS's own `employeeMaster()`, the mirror
 * of the Employee Details sheet, which never selects `raw` — so no full bank
 * or Aadhaar number can reach this section. Salary, bank and Aadhaar are
 * dropped here as well: salary is its own module. The sheet only syncs while
 * HRMS is open, so its age is read from the sync runs and said out loud when
 * it is more than a day old.
 * ------------------------------------------------------------------------- */

const STALE_HOURS = 24;

/** 1 April of the financial year `day` falls in. */
function fyStart(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return `${m >= 4 ? y : y - 1}-04-01`;
}

async function lastHrSync(): Promise<Date | null> {
  const [row] = await db
    .select({ finishedAt: sheetSyncRuns.finishedAt, startedAt: sheetSyncRuns.startedAt })
    .from(sheetSyncRuns)
    .where(and(eq(sheetSyncRuns.source, EMPLOYEE_SOURCE), eq(sheetSyncRuns.status, "ok")))
    .orderBy(desc(sheetSyncRuns.startedAt))
    .limit(1);
  return row ? (row.finishedAt ?? row.startedAt) : null;
}

/** Field salesmen and telecallers: people holding the app at the associate level. */
async function appHolders() {
  const [row] = await db.execute<{ salesmen: number; telecallers: number; states: number }>(sql`
    with holders as (
      select a.app::text as app, a.user_id
        from app_access a
        join users u on u.id = a.user_id
       where u.active and coalesce(a.role, u.role) = 'associate' and a.app in ('field', 'crm')
    )
    select
      (select count(*) from holders where app = 'field')::int as salesmen,
      (select count(*) from holders where app = 'crm')::int as telecallers,
      (select count(distinct lower(case when t.kind = 'state' then t.region
                                         when t.kind = 'city' then nullif(t.parent, '') end))
         from mbos_user_territories t
        where t.user_id in (select h.user_id from holders h where h.app = 'field'))::int as states`);
  return { salesmen: Number(row?.salesmen ?? 0), telecallers: Number(row?.telecallers ?? 0), states: Number(row?.states ?? 0) };
}

type Read = {
  list: EmployeeRecord[];
  headcount: number;
  since: string;
  joined: EmployeeRecord[];
  left: EmployeeRecord[];
  syncedAt: Date | null;
};

async function read(ctx: Ctx): Promise<Read> {
  const [master, syncedAt] = await Promise.all([employeeMaster(), lastHrSync()]);
  const since = fyStart(ctx.period.today);
  const to = ctx.period.today;
  const inFy = (d: string | null) => Boolean(d && d >= since && d <= to);
  return {
    list: master.employees,
    headcount: master.summary.active,
    since,
    joined: master.employees.filter((e) => inFy(e.dateOfJoining)),
    left: master.employees.filter((e) => inFy(e.dateOfLeaving)),
    syncedAt,
  };
}

function agoWords(at: Date): string {
  const h = hoursSince(at);
  if (h < 48) return `${plural(Math.max(1, Math.round(h)), "hour")} ago`;
  return `${plural(Math.floor(h / 24), "day")} ago`;
}

/** "20 Sep", as the IST calendar date the sheet was read on. */
function syncDay(at: Date): string {
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(at);
  return fmtDay(iso).replace(/^0/, "");
}

/* ----------------------------------------------------------------- table */

function tableDef(r: Read): TableDef {
  return {
    key: "employees",
    title: "Every employee",
    hint: `${r.syncedAt ? `HR sheet as of ${syncDay(r.syncedAt)}` : "HR sheet never synced"} · joiners and movement this FY`,
    cols: [
      ["Person", "1.5fr"],
      ["Role", "1.1fr"],
      ["Where", "1fr"],
      ["Date", "0.8fr"],
      ["Movement", "0.8fr"],
    ],
    noun: "employee",
    rec: "Employee",
  };
}

/** The latest movement on the record: leaving if there is one, else joining. */
function movementDate(e: EmployeeRecord): string | null {
  return e.dateOfLeaving ?? e.dateOfJoining;
}

function movementCell(e: EmployeeRecord, since: string): Cell {
  if (e.dateOfLeaving) return { t: "Left", pill: e.dateOfLeaving >= since ? "bad" : "muted" };
  if (e.status === "inactive") return { t: "Inactive", pill: "muted" };
  if (e.withdrawn) return { t: "Off the sheet", pill: "warn" };
  if (e.dateOfJoining) return { t: "Joined", pill: e.dateOfJoining >= since ? "good" : "muted" };
  return { t: "No dates", pill: "muted" };
}

function sorted(list: EmployeeRecord[]): EmployeeRecord[] {
  return [...list].sort((a, b) => {
    const da = movementDate(a) ?? "";
    const dbb = movementDate(b) ?? "";
    if (da !== dbb) return da < dbb ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

function toRow(e: EmployeeRecord, since: string): Row {
  const d = movementDate(e);
  return {
    id: e.id,
    cells: [
      { t: e.name, sub: e.employeeCode },
      { t: e.position || e.department || "Not recorded", sub: e.position && e.department ? e.department : undefined },
      { t: e.officeName || "Not recorded", sub: e.areaAllocated || undefined },
      { t: d ? (d >= since ? fmtDay(d) : fmtDate(d)) : "—" },
      movementCell(e, since),
    ],
  };
}

function page(r: Read, query: TableQuery): TablePage {
  if (!r.list.length) return emptyPage(query);
  const s = slice(sorted(r.list), query, (e, q) =>
    [e.name, e.employeeCode, e.position, e.department, e.officeName, e.areaAllocated]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q)),
  );
  return { rows: s.rows.map((e) => toRow(e, r.since)), count: s.count, total: s.total, page: s.page, size: query.size, q: query.q };
}

/* ---------------------------------------------------------------- figure */

/** The last 12 calendar months, oldest first, ending with the month `day` is in. */
function last12(day: string) {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 12 + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    // Day 0 of the next month is the last day of this one.
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const endIso = `${key}-${String(last).padStart(2, "0")}`;
    return { key, from: `${key}-01`, to: endIso < day ? endIso : day };
  });
}

function bars(months: ReturnType<typeof last12>, value: (m: { from: string; to: string }) => number): Bar[] {
  return months.map((m, i) => {
    const v = value(m);
    return { h: v, tip: `${monthLabel(m.key)} · ${num(v)}`, current: i === months.length - 1 || undefined };
  });
}

async function figure(ctx: Ctx, metric: string): Promise<FigureDrawer> {
  const r = await read(ctx);
  const asOf = stampIST(new Date());
  const sheetAsOf = r.syncedAt ? `HR sheet read ${stampIST(r.syncedAt)}` : "The HR sheet has never synced";
  const months = last12(ctx.period.today);
  const fyFacts = [
    { label: "Kind", value: "Financial year to date" },
    { label: "Period", value: `${fmtDate(r.since)} – ${fmtDate(ctx.period.today)}` },
    { label: "Scope", value: "Company-wide · every employee on the HR sheet" },
    { label: "Source", value: "HR sheet (Employee Details), mirrored in HRMS" },
    { label: "As of", value: sheetAsOf },
  ];
  const personRow = (e: EmployeeRecord, date: string | null) => ({
    a: e.name,
    b: [e.position, e.officeName].filter(Boolean).join(" · ") || e.employeeCode,
    c: date ? fmtDate(date) : "—",
  });

  if (metric === "headcount") {
    const active = r.list.filter((e) => !e.withdrawn && e.status === "active");
    return {
      kind: "Now figure · People",
      title: "Headcount",
      value: num(r.headcount),
      facts: [
        { label: "Kind", value: "As of now" },
        { label: "Basis", value: "Active and still on the sheet" },
        { label: "Scope", value: "Company-wide · every employee on the HR sheet" },
        { label: "Source", value: "HR sheet (Employee Details), mirrored in HRMS" },
        { label: "As of", value: sheetAsOf },
      ],
      def: "Active employees on the HR sheet at its last sync. The sheet syncs only when HRMS is opened, so its age is always stated. The monthly bars are rebuilt from joining and leaving dates, so anybody with no joining date on the sheet is left out of them.",
      bars: bars(months, (m) =>
        r.list.filter((e) => e.dateOfJoining && e.dateOfJoining <= m.to && (!e.dateOfLeaving || e.dateOfLeaving > m.to)).length,
      ),
      barsLabel: "On the books at the end of each month, from joining and leaving dates",
      rowsLabel: `Records behind it · every employee · ${num(active.length)} active`,
      rows: sorted(active).slice(0, 8).map((e) => personRow(e, e.dateOfJoining)),
      noRowsLine: active.length ? undefined : "Nobody active is on the HR sheet yet.",
    };
  }

  if (metric === "joined" || metric === "left") {
    const joined = metric === "joined";
    const set = joined ? r.joined : r.left;
    const dateOf = (e: EmployeeRecord) => (joined ? e.dateOfJoining : e.dateOfLeaving);
    return {
      kind: "Period figure · People",
      title: joined ? "Joined this FY" : "Left this FY",
      value: num(set.length),
      facts: [
        ...fyFacts,
        ...(joined
          ? []
          : [
              {
                label: "Attrition",
                value: r.headcount ? `${((set.length / r.headcount) * 100).toFixed(1)}% of ${num(r.headcount)} active` : "No active headcount",
              },
            ]),
      ],
      def: joined
        ? "Employees whose joining date on the HR sheet falls between 1 April and today."
        : "Employees whose leaving date on the HR sheet falls between 1 April and today. Attrition is that count as a share of today's headcount.",
      bars: bars(months, (m) => r.list.filter((e) => {
        const d = dateOf(e);
        return Boolean(d && d >= m.from && d <= m.to);
      }).length),
      barsLabel: joined ? "Joined in each month" : "Left in each month",
      rowsLabel: `Records behind it · ${joined ? "joiners" : "leavers"} this FY · ${num(set.length)} in all`,
      rows: [...set]
        .sort((a, b) => ((dateOf(a) ?? "") < (dateOf(b) ?? "") ? 1 : -1))
        .slice(0, 8)
        .map((e) => personRow(e, dateOf(e))),
      noRowsLine: set.length ? undefined : joined ? "Nobody has joined since 1 April." : "Nobody has left since 1 April.",
    };
  }

  if (metric === "salesmen" || metric === "telecallers") {
    const salesmen = metric === "salesmen";
    const app = salesmen ? "field" : "crm";
    const [h, people] = await Promise.all([
      appHolders(),
      db.execute<{ name: string; email: string | null; phone: string | null; since: string }>(sql`
        select u.name, u.email, u.phone, a.created_at as since
          from app_access a join users u on u.id = a.user_id
         where u.active and coalesce(a.role, u.role) = 'associate' and a.app = ${app}
         order by lower(u.name) limit 8`),
    ]);
    const count = salesmen ? h.salesmen : h.telecallers;
    return {
      kind: "Now figure · People",
      title: salesmen ? "Field salesmen" : "Telecallers",
      value: num(count),
      facts: [
        { label: "Kind", value: "As of now" },
        { label: "Basis", value: salesmen ? "Holding the Salesman App at the associate level" : "Holding the CRM at the associate level" },
        { label: "Scope", value: "Company-wide · every enabled sign-in" },
        { label: "Source", value: "MahekOne access grants" },
        { label: "As of", value: asOf },
      ],
      def: salesmen
        ? "Enabled MahekOne accounts granted the Salesman App as an ordinary worker rather than a manager. States are counted from the areas allocated to them."
        : "Enabled MahekOne accounts granted the CRM as an ordinary worker rather than a manager.",
      bars: [],
      barsLabel: "No history is kept for this figure",
      rowsLabel: `Records behind it · ${num(count)} in all`,
      rows: [...people].map((p) => ({
        a: p.name,
        b: p.email || p.phone || "No email or number",
        c: `since ${fmtDate(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(p.since)))}`,
      })),
      noRowsLine: count ? undefined : "Nobody holds this app yet.",
    };
  }

  throw new Error("No figure called that in People.");
}

/* ---------------------------------------------------------------- record */

async function record(ctx: Ctx, table: string, id: string): Promise<RecordView> {
  if (table !== "employees") throw new Error("No table called that in People.");
  const [master, notes, audit, accounts] = await Promise.all([
    employeeMaster(),
    notesFor("employee", id),
    auditFor("employee", id),
    db.execute<{ name: string; apps: string | null }>(sql`
      select u.name, string_agg(a.app::text, ',' order by a.app::text) as apps
        from users u left join app_access a on a.user_id = u.id
       where u.employee_id = ${id}
       group by u.id, u.name`),
  ]);
  const e = master.employees.find((x) => x.id === id);
  if (!e) throw new Error("That employee is no longer on the HR sheet.");
  const since = fyStart(ctx.period.today);
  const status = e.withdrawn
    ? "No longer on the sheet"
    : e.status === "active"
      ? "Active"
      : e.status === "inactive"
        ? "Inactive"
        : e.statusRaw || "Not stated";
  const APP_WORD: Record<string, string> = {
    crm: "CRM",
    accounts: "Accounts",
    sales: "Sales Dashboard",
    field: "Salesman App",
    hrms: "HRMS",
    admin: "Admin",
    reports: "Reports",
    people: "People",
    enquiries: "Enquiries",
    founder: "Founder",
  };
  const acct = accounts[0];
  const v = (s: string | null | undefined) => (s && s.trim() ? s : "Not recorded");

  const fields = [
    { label: "Employee id", value: e.employeeCode },
    { label: "Status", value: status },
    { label: "Position", value: v(e.position) },
    { label: "Department", value: v(e.department) },
    { label: "Office", value: v(e.officeName) },
    { label: "Area allocated", value: v(e.areaAllocated) },
    { label: "Reports to (as the sheet says)", value: v(e.reportsTo) },
    { label: "Joined", value: e.dateOfJoining ? fmtDate(e.dateOfJoining) : "Not recorded" },
    { label: "Left", value: e.dateOfLeaving ? fmtDate(e.dateOfLeaving) : "—" },
    { label: "Work email", value: v(e.email) },
    { label: "Company mobile", value: v(e.companyMobile) },
    { label: "Paid leave a month", value: e.monthlyPaidLeave == null ? "Not recorded" : num(e.monthlyPaidLeave) },
    { label: "Maximum leave a year", value: e.yearlyMaximumLeave == null ? "Not recorded" : num(e.yearlyMaximumLeave) },
    {
      label: "PF / ESIC",
      value: e.pfEsicApplicable == null ? "Not recorded" : e.pfEsicApplicable ? "Applicable" : "Not applicable",
    },
    {
      label: "MahekOne sign-in",
      value: acct
        ? `${acct.name}${acct.apps ? ` · ${acct.apps.split(",").map((a) => APP_WORD[a] ?? a).join(", ")}` : " · no apps"}`
        : "Not linked to a MahekOne account",
    },
    ...(e.issues.length ? [{ label: "Cells to check on the sheet", value: plural(e.issues.length, "cell") }] : []),
    { label: "Sheet row", value: num(e.rowNumber) },
    { label: "Salary, bank and identity numbers", value: "Not shown here — salary is its own module" },
  ];

  const timeline = [
    ...notes,
    { what: "HR sheet record last changed", when: stampIST(e.updatedAt) },
    ...(e.dateOfLeaving ? [{ what: `Left${e.dateOfLeaving >= since ? " this FY" : ""}`, when: fmtDate(e.dateOfLeaving) }] : []),
    ...(e.dateOfJoining ? [{ what: `Joined${e.dateOfJoining >= since ? " this FY" : ""}`, when: fmtDate(e.dateOfJoining) }] : []),
  ];

  return {
    kind: "Employee · People",
    title: e.name,
    sub: [e.position, e.department, e.officeName].filter(Boolean).join(" · ") || e.employeeCode,
    fields,
    timeline,
    audit,
    acts: [],
    href: { label: "Open in HRMS", url: "/hrms/employees" },
    noteTarget: { kind: "employee", id },
  };
}

/* -------------------------------------------------------------- provider */

export const provider: SectionProvider = {
  async section(ctx) {
    const [r, h] = await Promise.all([read(ctx), appHolders()]);
    const stale = !r.syncedAt || hoursSince(r.syncedAt) > STALE_HOURS;
    const callouts: Callout[] = stale
      ? [
          {
            tone: "warn",
            text: r.syncedAt
              ? `The HR sheet last synced ${agoWords(r.syncedAt)}. It only syncs when HRMS is opened, so joiners and leavers since ${syncDay(r.syncedAt)} are not counted here.`
              : "The HR sheet has never synced. It only syncs when HRMS is opened, so nobody on it is counted here yet.",
            act: "Open system health",
            go: "system",
          },
        ]
      : [];
    return {
      metrics: [
        {
          key: "headcount",
          label: "Headcount",
          value: num(r.headcount),
          sub: r.syncedAt ? `HR sheet as of ${syncDay(r.syncedAt)}` : "HR sheet never synced",
          kind: "Now",
          tone: stale ? "warn" : undefined,
        },
        {
          key: "joined",
          label: "Joined this FY",
          value: num(r.joined.length),
          sub: `since ${fmtDate(r.since)}`,
          kind: "Period",
        },
        {
          key: "left",
          label: "Left this FY",
          value: num(r.left.length),
          sub: r.headcount
            ? `attrition ${((r.left.length / r.headcount) * 100).toFixed(1)}% of ${num(r.headcount)}`
            : "no active headcount to measure against",
          kind: "Period",
        },
        {
          key: "salesmen",
          label: "Field salesmen",
          value: num(h.salesmen),
          sub: h.states ? `across ${plural(h.states, "state")}` : h.salesmen ? "no state allocated yet" : "",
          kind: "Now",
        },
        { key: "telecallers", label: "Telecallers", value: num(h.telecallers), sub: "", kind: "Now" },
      ],
      callouts,
      tables: [withPage(tableDef(r), page(r, { q: "", page: 1, size: 25 }))],
      foot: "Sign-ins are not attendance. Salary is a separate module, visible to the founder and to delegates granted it.",
    };
  },

  async tablePage(ctx, table, query) {
    if (table !== "employees") return emptyPage(query);
    return page(await read(ctx), query);
  },

  figure,
  record,

  async act() {
    return { ok: false, error: "Nothing on this list can be changed here. The HR sheet is the source." };
  },
};
