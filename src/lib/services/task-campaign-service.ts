import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { managerScope, onlyMine } from "@/lib/services/sales-service";
import { placeFilterOptions, placeFilterSql, placeNameSql } from "@/lib/services/place-filter-service";
import type { PlaceFilterOptions, PlaceFilterValues } from "@/lib/place-filters";
import { MAX_TASKS_PER_ASSIGNMENT, type TaskShopTarget } from "@/lib/task-audience";
import { parseTaskForm, type TaskAnswers, type TaskField } from "@/lib/task-form";

/* ---------------------------------------------------------------------------
 * The reads behind assigning a task with a form, and reading back what the
 * field said. Writes are in `lib/actions/sales.ts`, beside the rest of the
 * Sales Dashboard's.
 *
 * EVERY READ IS NARROWED BY `managerScope`, the same narrowing the Tasks list
 * already runs: a regional manager picks shops from, and reads answers from,
 * his own team's book and nobody else's.
 * ------------------------------------------------------------------------- */

const CARRIER = "coalesce(c.sales_am_id, c.owner_id)";

/** The fixed narrowing of every shop a task may be about. */
function shopBase(scope: Awaited<ReturnType<typeof managerScope>>): SQL {
  return sql`c.status = 'active' and c.deleted_at is null and c.kind in ('customer', 'lead')
             ${onlyMine(scope, CARRIER)}`;
}

export type AudienceShopRow = {
  id: string;
  name: string;
  carrierId: string | null;
  carrierName: string | null;
  place: string | null;
};

/**
 * The shops a target reaches, with who carries each. Capped one past the most
 * an assignment may write, so the caller can say "too many" rather than
 * silently writing the first three thousand.
 */
export async function shopsForTarget(target: TaskShopTarget): Promise<AudienceShopRow[] | null> {
  if (target.kind === "none") return null;
  const scope = await managerScope();
  const conditions: SQL[] = [shopBase(scope)];

  if (target.kind === "list") {
    const ids = [...new Set(target.customerIds)].slice(0, MAX_TASKS_PER_ASSIGNMENT + 1);
    if (!ids.length) return [];
    conditions.push(sql`c.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  } else {
    const place = placeFilterSql(target.places, "c");
    if (place) conditions.push(place);
    if (target.carriedBy.length) {
      conditions.push(
        sql`${sql.raw(CARRIER)} in (${sql.join(target.carriedBy.map((i) => sql`${i}`), sql`, `)})`,
      );
    }
    if (target.accountKinds.length === 1) conditions.push(sql`c.kind = ${target.accountKinds[0]}`);
    if (target.missingGpsOnly) conditions.push(sql`(c.gps_lat is null or c.gps_lng is null)`);
    const q = target.search?.trim();
    if (q) {
      conditions.push(sql`(c.name ilike ${"%" + q + "%"} or c.phone like ${"%" + q + "%"}
                           or c.city ilike ${"%" + q + "%"} or coalesce(c.area, '') ilike ${"%" + q + "%"})`);
    }
  }

  return (await db.execute<AudienceShopRow>(sql`
    select c.id, c.name,
           ${sql.raw(CARRIER)} as "carrierId",
           u.name as "carrierName",
           nullif(concat_ws(', ', ${placeNameSql("c", "area", "area")}, ${placeNameSql("c", "city", "city")}), '') as place
      from customers c
      left join users u on u.id = ${sql.raw(CARRIER)}
     where ${sql.join(conditions, sql` and `)}
     order by c.name asc
     limit ${MAX_TASKS_PER_ASSIGNMENT + 1}
  `)) as unknown as AudienceShopRow[];
}

/** A shop search for the picker — name, phone, town — inside the team's book. */
export async function searchShopsForTask(query: string): Promise<AudienceShopRow[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const scope = await managerScope();
  return (await db.execute<AudienceShopRow>(sql`
    select c.id, c.name,
           ${sql.raw(CARRIER)} as "carrierId",
           u.name as "carrierName",
           nullif(concat_ws(', ', ${placeNameSql("c", "area", "area")}, ${placeNameSql("c", "city", "city")}), '') as place
      from customers c
      left join users u on u.id = ${sql.raw(CARRIER)}
     where ${shopBase(scope)}
       and (c.name ilike ${"%" + q + "%"} or c.phone like ${"%" + q + "%"}
            or c.city ilike ${"%" + q + "%"} or coalesce(c.area, '') ilike ${"%" + q + "%"})
     order by (c.name ilike ${q + "%"}) desc, c.name asc
     limit 30
  `)) as unknown as AudienceShopRow[];
}

/** The four place dropdowns, counted over the team's book, cascading on picks. */
export async function taskPlaceOptions(picks: PlaceFilterValues): Promise<PlaceFilterOptions> {
  const scope = await managerScope();
  return placeFilterOptions({ from: sql`customers c`, alias: "c", where: shopBase(scope), picks });
}

/** A place id as its name, for the sentence an assignment keeps. */
export async function placeNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = (await db.execute<{ id: string; name: string }>(sql`
    select id, name from places where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
  `)) as unknown as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Earlier assignments' forms, newest first, so one can be asked again. */
export async function recentTaskForms(): Promise<{ id: string; title: string; description: string | null; form: TaskField[] }[]> {
  const rows = (await db.execute<{ id: string; title: string; description: string | null; form: unknown }>(sql`
    select id, title, description, form
      from mbos_task_campaigns
     where jsonb_array_length(form) > 0
     order by created_at desc
     limit 15
  `)) as unknown as { id: string; title: string; description: string | null; form: unknown }[];
  return rows.map((r) => ({ ...r, form: parseTaskForm(r.form) }));
}

/* ------------------------------------------------------------- reading back */

export type CampaignSummary = {
  id: string;
  title: string;
  audienceSentence: string | null;
  dueDate: string | null;
  priority: string;
  createdAt: Date;
  createdBy: string | null;
  closedAt: Date | null;
  questions: number;
  total: number;
  done: number;
  open: number;
  overdue: number;
  cancelled: number;
  salesmen: number;
  lastAnswerAt: Date | null;
};

/**
 * Every assignment with at least one task inside this manager's team, and how
 * far through it the field is — counted over HIS team's tasks only, so a
 * regional manager's progress bar is his region's.
 */
export async function taskCampaigns(day: string): Promise<CampaignSummary[]> {
  const scope = await managerScope();
  const rows = (await db.execute<CampaignSummary>(sql`
    select k.id, k.title, k.audience_sentence as "audienceSentence",
           k.due_date::text as "dueDate", k.priority::text as priority,
           k.created_at as "createdAt", b.name as "createdBy", k.closed_at as "closedAt",
           jsonb_array_length(k.form)::int as questions,
           count(t.id)::int as total,
           count(t.id) filter (where t.status = 'done')::int as done,
           count(t.id) filter (where t.status in ('open', 'in_progress'))::int as open,
           count(t.id) filter (where t.status in ('open', 'in_progress')
                                 and t.due_date < ${day}::date)::int as overdue,
           count(t.id) filter (where t.status = 'cancelled')::int as cancelled,
           count(distinct t.assigned_to_user_id)::int as salesmen,
           max(t.completed_at) as "lastAnswerAt"
      from mbos_task_campaigns k
      join mbos_tasks t on t.campaign_id = k.id
      left join users b on b.id = k.created_by_id
     where true ${onlyMine(scope, "t.assigned_to_user_id")}
     group by k.id, b.name
     order by k.created_at desc
     limit 200
  `)) as unknown as CampaignSummary[];
  return rows;
}

export type CampaignTaskRow = {
  id: string;
  salesmanId: string;
  salesmanName: string;
  customerId: string | null;
  customerName: string | null;
  place: string | null;
  status: string;
  dueDate: string | null;
  completedAt: Date | null;
  respondedAt: Date | null;
  completionNote: string | null;
  completionPhotoId: string | null;
  snoozedTo: string | null;
  snoozeReason: string | null;
  overdueDays: number;
  responses: TaskAnswers | null;
};

export type CampaignDetail = {
  id: string;
  title: string;
  description: string | null;
  form: TaskField[];
  audienceSentence: string | null;
  priority: string;
  dueDate: string | null;
  createdAt: Date;
  createdBy: string | null;
  closedAt: Date | null;
  tasks: CampaignTaskRow[];
};

/** One assignment and every task in it this manager may see, answers and all. */
export async function taskCampaign(id: string, day: string): Promise<CampaignDetail | null> {
  const scope = await managerScope();
  const [head] = (await db.execute<Omit<CampaignDetail, "tasks" | "form"> & { form: unknown }>(sql`
    select k.id, k.title, k.description, k.form, k.audience_sentence as "audienceSentence",
           k.priority::text as priority, k.due_date::text as "dueDate",
           k.created_at as "createdAt", b.name as "createdBy", k.closed_at as "closedAt"
      from mbos_task_campaigns k
      left join users b on b.id = k.created_by_id
     where k.id = ${id}
  `)) as unknown as (Omit<CampaignDetail, "tasks" | "form"> & { form: unknown })[];
  if (!head) return null;

  const tasks = (await db.execute<CampaignTaskRow>(sql`
    select t.id, t.assigned_to_user_id as "salesmanId", u.name as "salesmanName",
           t.customer_id as "customerId", c.name as "customerName",
           case when c.id is null then null else
             nullif(concat_ws(', ', ${placeNameSql("c", "area", "area")}, ${placeNameSql("c", "city", "city")}), '')
           end as place,
           t.status::text as status, t.due_date::text as "dueDate",
           t.completed_at as "completedAt", t.responded_at as "respondedAt",
           t.completion_note as "completionNote", t.completion_photo_id as "completionPhotoId",
           t.snoozed_to::text as "snoozedTo", t.snooze_reason as "snoozeReason",
           greatest(0, ${day}::date - t.due_date)::int as "overdueDays",
           t.responses
      from mbos_tasks t
      join users u on u.id = t.assigned_to_user_id
      left join customers c on c.id = t.customer_id
     where t.campaign_id = ${id} ${onlyMine(scope, "t.assigned_to_user_id")}
     order by u.name asc, c.name asc nulls first
  `)) as unknown as CampaignTaskRow[];

  /* A campaign with nothing of this manager's team in it is somebody else's
     assignment, and is absent to him rather than an empty page. */
  if (!tasks.length) return null;
  return { ...head, form: parseTaskForm(head.form), tasks };
}
