import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { resolveScope, scopedToUsers } from "@/lib/access-control";
import { canOpenModule } from "@/lib/access";
import { APP_TIMEZONE } from "@/lib/business-date";
import { HISTORY_PAGE, needsForwarded, parseKey, type HistoryFilters, type HistoryMode, type HistoryStatus } from "./domain/history";

/* ---------------------------------------------------------------------------
 * POSTER FORWARDING HISTORY — the reads behind My posters.
 *
 * One UNION ALL over records that already exist, never a copy of them:
 *   p:<poster id>     a made poster — ONE row however many shares it has (its
 *                     WhatsApp opens are folded in a lateral subquery, never
 *                     joined row by row, so three opens are not three rows);
 *   f:<recipient id>  a recipient of an uploaded poster in a STARTED list.
 * An uploaded picture has no studio_posters row and a made poster has no
 * recipient row, so the two kinds cannot overlap, and the keys are unique.
 *
 * Who sees what is decided HERE, in SQL, for the list, the count, the page and
 * the panel alike — the panel asks the same query by key, so it can never show
 * a row the list would not:
 *   - made posters: Mine = the viewer's own; My team's = the creators in scope
 *     (`resolveScope`), exactly as `listPosters` always did;
 *   - uploaded forwards: the uploader only, on Mine only, and only for someone
 *     who holds the Upload & Bulk Forward module;
 *   - a recipient who still has a CRM record must be in the viewer's record
 *     scope (`scopedToUsers`) — except the viewer's OWN made posters, which are
 *     listed as they always were. A record that was removed keeps its stored
 *     snapshot and is listed where the poster itself is visible.
 * ------------------------------------------------------------------------- */

export type HistoryRow = {
  key: string;
  kind: "poster" | "forward";
  refId: string;
  at: Date;
  actionAt: Date | null;
  createdAt: Date;
  createdById: string;
  createdByName: string;
  customerId: string | null;
  company: string;
  contact: string | null;
  place: string;
  title: string;
  templateId: string | null;
  templateVersion: string | null;
  language: string | null;
  mode: HistoryMode;
  status: HistoryStatus;
  opens: number;
  batchId: string | null;
  /** The recipient's CRM record is gone; what is shown is the snapshot stored with the poster or list. */
  recordRemoved: boolean;
};

type Viewer = { userId: string; ids: string[] | null; forwards: boolean };

async function viewer(): Promise<Viewer> {
  const { user, scope } = await resolveScope();
  return { userId: user.id, ids: scope.userIds, forwards: await canOpenModule(user.id, "studio.forward") };
}

const inList = (col: SQL, ids: string[]) => (ids.length ? sql`${col} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql`false`);
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Every visible row, before any filter. `team` is false on Mine and true on My team's. */
function visibleRows(v: Viewer, team: boolean): SQL {
  const creators = team ? (v.ids ? inList(sql`p.created_by_id`, v.ids) : sql`true`) : sql`p.created_by_id = ${v.userId}`;
  const inBook = sql`(select customers.id from customers where ${scopedToUsers(v.ids) ?? sql`true`})`;
  const posters = sql`
    select 'p:' || p.id as key, 'poster'::text as kind, p.id as ref_id, p.created_at,
           coalesce(wa.last_at, p.created_at) as sort_at, wa.last_at as action_at,
           p.created_by_id, u.name as by_name, p.customer_id,
           (p.recipient->>'company')::text as company, (p.recipient->>'contact')::text as contact, ''::text as place,
           p.template_name::text as title, p.template_id::text as template_id, p.template_version::text as template_version, p.language::text as language,
           (case when p.batch_id is null then 'individual' else 'bulk_run' end)::text as mode,
           (case when wa.n > 0 then 'opened' else 'not_forwarded' end)::text as status,
           p.batch_id::text as batch_id, wa.n::bigint as opens
      from studio_posters p
      join users u on u.id = p.created_by_id
      left join lateral (
        select count(*) as n, max(s.created_at) as last_at
          from studio_poster_shares s where s.poster_id = p.id and s.channel = 'whatsapp'
      ) wa on true
     where p.removed_at is null and ${creators}
       and (p.created_by_id = ${v.userId} or p.customer_id is null or p.customer_id in ${inBook})`;
  if (team || !v.forwards) return posters;
  const forwards = sql`
    select 'f:' || r.id, 'forward'::text, f.id, f.created_at,
           coalesce(r.decided_at, r.opened_at, f.started_at), coalesce(r.decided_at, r.opened_at),
           f.created_by_id, u.name, r.customer_id,
           r.company::text, null::text, r.place::text,
           f.title::text, null::text, null::text, null::text,
           'bulk_upload'::text, r.status::text, null::text, 0::bigint
      from studio_forward_recipients r
      join studio_forwards f on f.id = r.forward_id
      join users u on u.id = f.created_by_id
     where f.created_by_id = ${v.userId} and f.status = 'started'
       and (r.customer_id is null or r.customer_id in ${inBook})`;
  return sql`${posters} union all ${forwards}`;
}

const COLS = sql`key, kind, ref_id, created_at, sort_at, action_at, created_by_id, by_name, customer_id, company, contact, place, title, template_id, template_version, language, mode, status, batch_id, opens`;

function filterSql(f: HistoryFilters, team: boolean): SQL {
  const parts: SQL[] = [sql`true`];
  if (f.q) parts.push(sql`(company ilike ${like(f.q)} or title ilike ${like(f.q)})`);
  if (f.poster) parts.push(sql`title ilike ${like(f.poster)}`);
  if (f.recipient) parts.push(sql`company ilike ${like(f.recipient)}`);
  if (f.mode) parts.push(sql`mode = ${f.mode}`);
  if (f.status) parts.push(sql`status = ${f.status}`);
  if (needsForwarded(f)) parts.push(sql`status <> 'not_forwarded'`);
  if (f.from) parts.push(sql`(sort_at at time zone ${APP_TIMEZONE})::date >= ${f.from}::date`);
  if (f.to) parts.push(sql`(sort_at at time zone ${APP_TIMEZONE})::date <= ${f.to}::date`);
  if (f.user && team) parts.push(sql`created_by_id = ${f.user}`);
  return sql.join(parts, sql` and `);
}

type Raw = Record<string, unknown>;
const when = (x: unknown): Date | null => (x == null ? null : x instanceof Date ? x : new Date(String(x)));
function toRow(r: Raw): HistoryRow {
  const customerId = (r.customer_id as string | null) ?? null;
  return {
    key: String(r.key),
    kind: r.kind as "poster" | "forward",
    refId: String(r.ref_id),
    at: when(r.sort_at) ?? new Date(0),
    actionAt: when(r.action_at),
    createdAt: when(r.created_at) ?? new Date(0),
    createdById: String(r.created_by_id),
    createdByName: String(r.by_name ?? ""),
    customerId,
    company: String(r.company ?? ""),
    contact: (r.contact as string | null) ?? null,
    place: String(r.place ?? ""),
    title: String(r.title ?? ""),
    templateId: (r.template_id as string | null) ?? null,
    templateVersion: (r.template_version as string | null) ?? null,
    language: (r.language as string | null) ?? null,
    mode: r.mode as HistoryMode,
    status: r.status as HistoryStatus,
    opens: Number(r.opens ?? 0),
    batchId: (r.batch_id as string | null) ?? null,
    recordRemoved: customerId === null,
  };
}

export type HistoryPage = { rows: HistoryRow[]; total: number; page: number; pageCount: number; teamView: boolean; canTeam: boolean; people: { id: string; name: string }[] };

/** A page of the table, in this person's sight. Offset paging over a bounded, indexed result; the order has a tiebreaker. */
export async function historyPage(f: HistoryFilters, whose: "mine" | "team"): Promise<HistoryPage> {
  const v = await viewer();
  const team = whose === "team";
  const base = visibleRows(v, team);
  const where = filterSql(f, team);
  const [countRow] = (await db.execute(sql`with h as (${base}) select count(*)::int as n from h where ${where}`)) as unknown as { n: number }[];
  const total = Number(countRow?.n ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / HISTORY_PAGE));
  const page = Math.min(f.page, pageCount);
  const rows = (await db.execute(
    sql`with h as (${base}) select ${COLS} from h where ${where} order by sort_at desc, key desc limit ${HISTORY_PAGE} offset ${(page - 1) * HISTORY_PAGE}`,
  )) as unknown as Raw[];
  const canTeam = v.ids === null || v.ids.length > 1;
  let people: { id: string; name: string }[] = [];
  if (team && canTeam) {
    people = (await db.execute(sql`select distinct created_by_id as id, by_name as name from (${visibleRows(v, true)}) t order by 2 limit 200`)) as unknown as { id: string; name: string }[];
  }
  return { rows: rows.map(toRow), total, page, pageCount, teamView: team, canTeam, people };
}

/** ONE row by its key, through exactly the visibility the table uses. Null for anything not visible or not existing. */
export async function historyRow(key: string, whose: "mine" | "team"): Promise<HistoryRow | null> {
  const k = parseKey(key);
  if (!k) return null;
  const v = await viewer();
  const rows = (await db.execute(sql`with h as (${visibleRows(v, whose === "team")}) select ${COLS} from h where key = ${key} limit 1`)) as unknown as Raw[];
  return rows[0] ? toRow(rows[0]) : null;
}

export type PanelData = {
  row: HistoryRow;
  timeline: { at: Date | null; text: string }[];
  notes: { at: Date; text: string }[];
  run: { key: string; company: string; kind: string; status: HistoryStatus; current: boolean }[];
  runLabel: string;
  otherRuns: { id: string; title: string; at: Date | null; people: number }[];
};

const CHANNEL_NOTE: Record<string, string> = { whatsapp: "Opened WhatsApp", download: "Downloaded", device: "Shared from the phone" };

/** The panel for one visible row: its timeline, everybody in its run (in sight only), and other runs of the same picture. */
export async function historyPanel(key: string, whose: "mine" | "team"): Promise<PanelData | null> {
  const row = await historyRow(key, whose);
  if (!row) return null;
  const v = await viewer();
  const base = visibleRows(v, whose === "team");
  const timeline: PanelData["timeline"] = [];
  const notes: PanelData["notes"] = [];
  let run: Raw[] = [];
  let runLabel = "Recipient";
  let otherRuns: PanelData["otherRuns"] = [];

  if (row.kind === "forward") {
    const [t] = (await db.execute(sql`
      select f.started_at, r.opened_at, r.decided_at, r.status, d.name as decided_by
        from studio_forward_recipients r join studio_forwards f on f.id = r.forward_id left join users d on d.id = r.decided_by_id
       where r.id = ${row.key.slice(2)} and f.created_by_id = ${v.userId}`)) as unknown as Raw[];
    if (t) {
      timeline.push({ at: when(t.started_at), text: "Selected in the forwarding list" });
      if (t.opened_at) timeline.push({ at: when(t.opened_at), text: "Chat opened" });
      if (t.decided_at) timeline.push({ at: when(t.decided_at), text: `${t.status === "skipped" ? "Skipped" : t.status === "sent" ? "Marked sent" : "Moved back"}${t.decided_by ? ` by ${String(t.decided_by)}` : ""}` });
    }
    runLabel = "Everyone in this forwarding run";
    run = (await db.execute(sql`with h as (${base}) select key, company, kind, status from h where kind = 'forward' and ref_id = ${row.refId} order by company, key limit 500`)) as unknown as Raw[];
    const others = (await db.execute(sql`
      select f.id, f.title, f.started_at, (select count(*)::int from studio_forward_recipients x where x.forward_id = f.id) as people
        from studio_forwards f
       where f.created_by_id = ${v.userId} and f.status = 'started' and f.id <> ${row.refId}
         and f.sha256 = (select sha256 from studio_forwards where id = ${row.refId} and created_by_id = ${v.userId})
       order by f.started_at desc nulls last limit 20`)) as unknown as Raw[];
    otherRuns = others.map((o) => ({ id: String(o.id), title: String(o.title), at: when(o.started_at), people: Number(o.people) }));
  } else {
    const shares = (await db.execute(sql`
      select s.channel, s.created_at from studio_poster_shares s where s.poster_id = ${row.refId} order by s.created_at desc limit 50`)) as unknown as Raw[];
    for (const s of [...shares].reverse()) {
      const at = when(s.created_at);
      if (!at) continue;
      if (s.channel === "whatsapp") timeline.push({ at, text: CHANNEL_NOTE.whatsapp });
      else notes.push({ at, text: CHANNEL_NOTE[String(s.channel)] ?? String(s.channel) });
    }
    timeline.unshift({ at: row.createdAt, text: "Poster made (not a forwarding)" });
    if (row.batchId) {
      runLabel = "Everyone in this poster run";
      run = (await db.execute(sql`with h as (${base}) select key, company, kind, status from h where kind = 'poster' and batch_id = ${row.batchId} order by company, key limit 200`)) as unknown as Raw[];
    }
  }
  return {
    row,
    timeline,
    notes,
    run: run.map((r) => ({ key: String(r.key), company: String(r.company), kind: String(r.kind), status: r.status as HistoryStatus, current: String(r.key) === row.key })),
    runLabel,
    otherRuns,
  };
}
