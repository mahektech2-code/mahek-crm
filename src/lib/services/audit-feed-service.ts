import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE, asDate } from "@/lib/business-date";
import { definition } from "@/lib/config/registry";
import {
  AUDIT_GROUP_LABEL,
  AUDIT_PAGE_SIZES,
  type AuditPageSize,
  GROUP_RULES,
  auditGroup,
  describeAudit,
  idsToResolve,
  piecesText,
  type AuditGroup,
  type AuditNames,
  type Change,
  type Piece,
} from "@/lib/audit-labels";

/* ---------------------------------------------------------------------------
 * The audit log as the Admin Console reads it: filtered, counted and paged in
 * the database, then put into words by `lib/audit-labels.ts`.
 *
 * Every filter runs in SQL. A list that fetched four hundred rows and filtered
 * them in the browser — which is what this replaced — answers "the payments
 * among the newest four hundred things that happened" and calls it the payment
 * history, and its count says 400 on a log of fourteen thousand.
 * ------------------------------------------------------------------------- */


export type AuditFilters = {
  group: AuditGroup | "all";
  /** A user id, or "system" for rows nobody signed in wrote. */
  person: string | null;
  /** One exact code. */
  event: string | null;
  /** Matched against the customer's name, the person's name and the account acted on. */
  q: string | null;
  /** Inclusive calendar dates, in Asia/Kolkata. */
  from: string | null;
  to: string | null;
  page: number;
  size: AuditPageSize;
  /** Fold a burst of the same thing by the same person into one line. */
  combine: boolean;
  /** Only rows by or about this account — the person screen's narrowing. */
  about?: string | null;
};

export type AuditEntry = {
  id: string;
  at: string;
  /** The Asia/Kolkata calendar date, from SQL, for the day headings. */
  day: string;
  group: AuditGroup;
  groupLabel: string;
  actor: { id: string; name: string } | null;
  /** "manager in Accounts" — which hat allowed it, where it was recorded. */
  hat: string | null;
  says: Piece[];
  note: string | null;
  changes: Change[];
  /** How many identical rows this line stands for; 1 unless combined. */
  count: number;
  /** For a combined line, when the burst began. */
  firstAt: string | null;
  raw: { action: string; entityType: string; entityId: string | null; before: unknown; after: unknown };
};

export type AuditFeed = {
  entries: AuditEntry[];
  /** Rows matching every filter — from SQL, never from the page's length. */
  total: number;
  page: number;
  pages: number;
  size: AuditPageSize;
  /** Rows per group under every OTHER filter, so each tab can say what it holds. */
  groupCounts: Record<AuditGroup | "all", number>;
  people: Array<{ id: string; name: string; n: number }>;
  systemCount: number;
  events: Array<{ action: string; label: string; n: number }>;
};

const DEFAULTS: AuditFilters = {
  group: "all",
  person: null,
  event: null,
  q: null,
  from: null,
  to: null,
  page: 1,
  size: 50,
  combine: true,
};

/** Reads the filters out of a URL, refusing anything malformed rather than guessing. */
export function parseAuditFilters(
  params: Record<string, string | string[] | undefined>,
  group: string,
): AuditFilters {
  const one = (k: string) => {
    const v = params[k];
    const s = (Array.isArray(v) ? v[0] : v)?.trim();
    return s ? s : null;
  };
  const date = (k: string) => {
    const v = one(k);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  };
  const size = Number(one("size"));
  const page = Number(one("page"));
  const groups = new Set<string>(["all", "other", ...GROUP_RULES.map((r) => r.group)]);
  return {
    group: (groups.has(group) ? group : "all") as AuditFilters["group"],
    person: one("person"),
    event: one("event"),
    q: one("q")?.slice(0, 80) ?? null,
    from: date("from"),
    to: date("to"),
    page: Number.isInteger(page) && page > 0 ? page : 1,
    size: (AUDIT_PAGE_SIZES as readonly number[]).includes(size) ? (size as AuditPageSize) : DEFAULTS.size,
    combine: one("combine") !== "0",
  };
}

/* ------------------------------------------------------------------- SQL */

/**
 * The group of a row, in SQL, generated from the same rules `auditGroup` reads
 * — longest prefix first — so the tab and the label can never disagree. The
 * prefixes are constants in this repository, never input, which is why
 * `sql.raw` is safe here; `_` and `%` are escaped because a LIKE reads them.
 */
const GROUP_SQL = sql.raw(
  `(case ${GROUP_RULES.map(
    (r) => `when a.action like '${r.prefix.replace(/'/g, "''").replace(/[_%\\]/g, "\\$&")}%' then '${r.group}'`,
  ).join(" ")} else 'other' end)`,
);

/**
 * The customer a row is about. Some rows name the customer directly; most name
 * a payment, an order, a bill or a call, and the customer is one join away. A
 * screen that said "reversed a payment" without saying whose would still be
 * the developer's log.
 */
const SUBJECT_SQL = sql`coalesce(
  case when a.entity_id like 'cus\\_%' then a.entity_id end,
  case a.entity_type
    when 'payment_receipt' then (select r.customer_id from payment_receipts r where r.id = a.entity_id)
    when 'order' then (select o.customer_id from orders o where o.id = a.entity_id)
    when 'bill' then (select b.customer_id from bills b where b.id = a.entity_id)
    when 'complaint' then (select x.customer_id from complaints x where x.id = a.entity_id)
    when 'reminder' then (select x.customer_id from reminders x where x.id = a.entity_id)
    when 'interaction' then (select x.customer_id from calls x where x.id = a.entity_id)
    when 'mbos_samples' then (select x.customer_id from mbos_samples x where x.id = a.entity_id)
    when 'wa_message' then (select x.customer_id from wa_messages x where x.id = a.entity_id)
  end,
  a.after_state->>'customerId'
)`;

/** Every filter except the group and the event, which the facets are counted across. */
function baseWhere(f: AuditFilters): SQL {
  const parts: SQL[] = [sql`true`];
  if (f.about) parts.push(sql`(a.actor_id = ${f.about} or a.entity_id = ${f.about})`);
  if (f.person === "system") parts.push(sql`a.actor_id is null`);
  else if (f.person) parts.push(sql`a.actor_id = ${f.person}`);
  /* A stored DATE becomes an instant only once a midnight is named. */
  if (f.from) parts.push(sql`a.at >= ${f.from}::timestamp at time zone ${APP_TIMEZONE}`);
  if (f.to) parts.push(sql`a.at < (${f.to}::date + 1)::timestamp at time zone ${APP_TIMEZONE}`);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
    parts.push(sql`(
      exists (select 1 from customers c where c.id = ${SUBJECT_SQL} and c.name ilike ${like})
      or exists (select 1 from users u where u.id = a.actor_id and u.name ilike ${like})
      or exists (select 1 from users u where u.id = a.entity_id and u.name ilike ${like})
      or a.after_state->>'name' ilike ${like}
    )`);
  }
  return sql.join(parts, sql` and `);
}

/* ------------------------------------------------------------------ read */

export async function auditFeed(input: Partial<AuditFilters> = {}): Promise<AuditFeed> {
  const f: AuditFilters = { ...DEFAULTS, ...input };
  const base = baseWhere(f);
  const groupClause = f.group === "all" ? sql`true` : sql`${GROUP_SQL} = ${f.group}`;
  const eventClause = f.event ? sql`a.action = ${f.event}` : sql`true`;

  const [countRow] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log a where ${base} and ${groupClause} and ${eventClause}
  `);
  const total = Number(countRow?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / f.size));
  const page = Math.min(f.page, pages);

  const [rows, groupRows, peopleRows, eventRows] = await Promise.all([
    db.execute<{
      id: string;
      at: unknown;
      day: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      actor_id: string | null;
      actor_role: string | null;
      actor_app: string | null;
      before_state: unknown;
      after_state: unknown;
      subject_id: string | null;
    }>(sql`
      select a.id, a.at, (a.at at time zone ${APP_TIMEZONE})::date::text as day,
             a.action, a.entity_type, a.entity_id, a.actor_id,
             a.actor_role::text as actor_role, a.actor_app::text as actor_app,
             a.before_state, a.after_state,
             ${SUBJECT_SQL} as subject_id
        from audit_log a
       where ${base} and ${groupClause} and ${eventClause}
       order by a.at desc, a.id desc
       limit ${f.size} offset ${(page - 1) * f.size}
    `),
    db.execute<{ g: string; n: number }>(sql`
      select ${GROUP_SQL} as g, count(*)::int as n from audit_log a where ${base} and ${eventClause} group by 1
    `),
    db.execute<{ id: string | null; name: string | null; n: number }>(sql`
      select a.actor_id as id, u.name, count(*)::int as n
        from audit_log a left join users u on u.id = a.actor_id
       where ${f.about ? sql`(a.actor_id = ${f.about} or a.entity_id = ${f.about})` : sql`true`}
       group by 1, 2 order by 3 desc
    `),
    db.execute<{ action: string; n: number }>(sql`
      select a.action, count(*)::int as n from audit_log a
       where ${base} and ${groupClause} group by 1 order by 2 desc limit 200
    `),
  ]);

  const shaped = rows.map((r) => ({
    id: r.id,
    at: (asDate(r.at) ?? new Date(0)).toISOString(),
    day: r.day,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    actorId: r.actor_id,
    hatRole: r.actor_role,
    hatApp: r.actor_app,
    before: r.before_state,
    after: r.after_state,
    subjectId: r.subject_id,
  }));

  const names = await resolveNames(shaped);
  const groupCounts = Object.fromEntries(
    [...Object.keys(AUDIT_GROUP_LABEL), "all"].map((k) => [k, 0]),
  ) as Record<AuditGroup | "all", number>;
  for (const g of groupRows) {
    groupCounts[g.g as AuditGroup] = Number(g.n);
    groupCounts.all += Number(g.n);
  }

  const entries: AuditEntry[] = shaped.map((r) => {
    const d = describeAudit(r, names);
    const group = auditGroup(r.action);
    return {
      id: r.id,
      at: r.at,
      day: r.day,
      group,
      groupLabel: AUDIT_GROUP_LABEL[group],
      actor: r.actorId ? { id: r.actorId, name: names.users[r.actorId] ?? "A former account" } : null,
      hat: hatWords(r.hatRole, r.hatApp),
      says: d.says,
      note: d.note,
      changes: d.changes,
      count: 1,
      firstAt: null,
      raw: { action: r.action, entityType: r.entityType, entityId: r.entityId, before: r.before, after: r.after },
    };
  });

  return {
    entries: f.combine ? combineRuns(entries) : entries,
    total,
    page,
    pages,
    size: f.size,
    groupCounts,
    people: peopleRows
      .filter((p) => p.id)
      .map((p) => ({ id: p.id!, name: p.name ?? "A former account", n: Number(p.n) })),
    systemCount: Number(peopleRows.find((p) => !p.id)?.n ?? 0),
    events: eventRows.map((e) => ({ action: e.action, label: eventLabel(e.action), n: Number(e.n) })),
  };
}

/* --------------------------------------------------------------- helpers */

type Resolvable = Parameters<typeof idsToResolve>[0][number] & { entityType: string };

async function resolveNames(rows: Resolvable[]): Promise<AuditNames> {
  const ids = idsToResolve(rows);
  const list = (xs: string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
  const [users, customers, employees] = await Promise.all([
    ids.users.length
      ? db.execute<{ id: string; name: string }>(sql`select id, name from users where id in (${list(ids.users)})`)
      : [],
    ids.customers.length
      ? db.execute<{ id: string; name: string }>(sql`select id, name from customers where id in (${list(ids.customers)})`)
      : [],
    ids.employees.length
      ? db.execute<{ id: string; name: string }>(sql`select id, name from employees where id in (${list(ids.employees)})`)
      : [],
  ]);
  const settings: Record<string, string> = {};
  for (const r of rows) {
    if (r.entityType === "app_setting" && r.entityId) {
      const label = definition(r.entityId)?.label;
      if (label) settings[r.entityId] = label;
    }
  }
  const map = (xs: Array<{ id: string; name: string }>) => Object.fromEntries(xs.map((x) => [x.id, x.name]));
  return { users: map(users), customers: map(customers), employees: map(employees), settings };
}

const APP_WORD: Record<string, string> = {
  crm: "the CRM",
  accounts: "Accounts",
  sales: "the Sales Dashboard",
  field: "the field app",
  hrms: "HRMS",
  admin: "Admin",
  founder: "the Founder desk",
  erp: "the Factory app",
};

function hatWords(role: string | null, app: string | null): string | null {
  if (!role && !app) return null;
  const where = app ? (APP_WORD[app] ?? app) : null;
  return [role, where ? `in ${where}` : null].filter(Boolean).join(" ");
}

/** The event filter's own words: the sentence with nobody in it. */
function eventLabel(action: string): string {
  const d = describeAudit(
    { action, entityType: "", entityId: null, before: null, after: null, subjectId: null },
    { users: {}, customers: {}, employees: {}, settings: {} },
  );
  const text = piecesText(d.says)
    .replace(/\b(a customer|somebody|nobody|an amount)\b/g, "…")
    .replace(/ from … to …/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text[0].toUpperCase() + text.slice(1) : action;
}

/**
 * A BURST IS ONE THING THAT HAPPENED, NOT FOUR HUNDRED.
 *
 * One night in August a job reversed 9,468 payments in under three hours, and a
 * page of fifty rows of "reversed a payment" tells an owner nothing a single
 * line saying "reversed 967 payments in 4 minutes" does not tell better.
 * Consecutive rows (the page is newest-first) of the same code by the same
 * person, each within two minutes of the last, fold into one line once there
 * are three; two is ordinary and stays two. Two minutes because a telecaller
 * logs a call every few minutes and each of those is its own piece of work,
 * while a job writes hundreds a minute. It folds within a page only, so
 * the pager's arithmetic stays exact.
 */
const BURST_GAP_MS = 2 * 60_000;

function combineRuns(entries: AuditEntry[]): AuditEntry[] {
  const out: AuditEntry[] = [];
  let i = 0;
  while (i < entries.length) {
    let j = i + 1;
    while (
      j < entries.length &&
      entries[j].raw.action === entries[i].raw.action &&
      entries[j].actor?.id === entries[i].actor?.id &&
      Date.parse(entries[j - 1].at) - Date.parse(entries[j].at) <= BURST_GAP_MS
    ) {
      j++;
    }
    if (j - i >= 3) out.push({ ...entries[i], count: j - i, firstAt: entries[j - 1].at });
    else out.push(...entries.slice(i, j));
    i = j;
  }
  return out;
}
