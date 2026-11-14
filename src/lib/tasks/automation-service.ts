import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { taskAutomations, taskEvents, tasks } from "@/db/schema";
import { APP_TIMEZONE } from "@/lib/business-date";
import { money } from "@/lib/format";
import { AUTOMATIONS, AUTOMATION_BY_ID, planAutoSync, type AutomationRule, type WantedTask } from "./automations";

/* ---------------------------------------------------------------------------
 * AUTOMATIC TASKS, wired to each app's records.
 *
 * Every rule is one read of the records that need somebody today, turned into
 * the tasks that should exist; `planAutoSync` (pure) says what to insert,
 * bring in step and close. Run hourly, nightly, when a rule is switched on, and
 * by hand from Set up → Automatic tasks. Idempotent: a second run the same
 * minute changes nothing.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const dayOf = (col: string) => sql.raw(`((${col}) at time zone '${APP_TIMEZONE}')::date::text`);

type Row = Record<string, unknown>;
/**
 * A dated record raises a task only inside this window: a month back (older is
 * a record nobody is going to act on, and a thousand of them on somebody's My
 * day helps nobody) and a month ahead (further is not work yet).
 */
const WINDOW_FROM = sql.raw(`((now() at time zone '${APP_TIMEZONE}')::date - 30)`);
const WINDOW_TO = sql.raw(`((now() at time zone '${APP_TIMEZONE}')::date + 30)`);
const str = (v: unknown) => (v == null ? "" : String(v));

/** The people who hold `app` at manager or admin level. */
async function managersOf(app: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select distinct u.id from users u join app_access a on a.user_id = u.id
     where u.active = true and a.app::text = ${app} and a.role in ('manager', 'admin')`);
  return rows.map((r) => r.id);
}

const READERS: Record<string, () => Promise<WantedTask[]>> = {
  async "crm.callback"() {
    const rows = await db.execute<Row>(sql`
      select r.id, coalesce(r.assigned_user_id, r.created_by_user_id) as who, r.due_date::text as due, r.note, c.id as customer_id, c.name as customer
        from reminders r join customers c on c.id = r.customer_id
        join users u on u.id = coalesce(r.assigned_user_id, r.created_by_user_id) and u.active = true
       where r.status = 'pending'
         and r.due_date between ${WINDOW_FROM} and ${WINDOW_TO}`);
    return rows.map((r) => ({
      key: str(r.id),
      assigneeId: str(r.who),
      title: `Call back ${str(r.customer)}`,
      note: r.note ? str(r.note) : null,
      customerId: str(r.customer_id),
      dueDate: str(r.due),
      priority: "high",
    }));
  },

  async "crm.lead-next-action"() {
    const rows = await db.execute<Row>(sql`
      select c.id, c.name, c.lead_next_action as action, c.lead_next_action_date::text as due, c.lead_next_action_owner_id as who
        from customers c join users u on u.id = c.lead_next_action_owner_id and u.active = true
       where c.kind = 'lead' and c.lead_next_action is not null
         and c.lead_next_action_date between ${WINDOW_FROM} and ${WINDOW_TO}`);
    return rows.map((r) => ({
      // The day is part of the key: a next action moved to another day is a new piece of work.
      key: `${str(r.id)}:${str(r.due)}`,
      assigneeId: str(r.who),
      title: `${str(r.action).slice(0, 140)} — ${str(r.name)}`,
      note: null,
      customerId: str(r.id),
      dueDate: str(r.due),
      priority: "normal",
    }));
  },

  async "crm.complaint-sla"() {
    const rows = await db.execute<Row>(sql`
      select k.id, k.logged_by_user_id as who, ${dayOf("k.sla_due_at")} as due, k.category::text as category, k.description, c.id as customer_id, c.name as customer
        from complaints k join customers c on c.id = k.customer_id
        join users u on u.id = k.logged_by_user_id and u.active = true
       where k.status in ('open', 'in_progress', 'awaiting_customer') and k.sla_due_at < now()`);
    return rows.map((r) => ({
      key: str(r.id),
      assigneeId: str(r.who),
      title: `Complaint past its SLA — ${str(r.customer)}`,
      note: `${str(r.category).replace(/_/g, " ")}: ${str(r.description).slice(0, 400)}`,
      customerId: str(r.customer_id),
      dueDate: str(r.due),
      priority: "urgent",
    }));
  },

  async "accounts.reported-payment"() {
    const [people, rows] = await Promise.all([
      managersOf("accounts"),
      db.execute<Row>(sql`
        select p.id, p.amount, p.received_at::text as due, p.reference, p.mode, c.id as customer_id, c.name as customer
          from payment_receipts p join customers c on c.id = p.customer_id
         where p.status = 'reported'`),
    ]);
    return rows.flatMap((r) =>
      people.map((who) => ({
        key: `${str(r.id)}:${who}`,
        assigneeId: who,
        title: `Confirm ${money(Number(r.amount))} reported — ${str(r.customer)}`,
        note: [str(r.mode), r.reference ? `Ref ${str(r.reference)}` : ""].filter(Boolean).join(" · ") || null,
        customerId: str(r.customer_id),
        dueDate: str(r.due),
        priority: "high" as const,
      })),
    );
  },

  async "accounts.order-approval"() {
    const [people, rows] = await Promise.all([
      managersOf("accounts"),
      db.execute<Row>(sql`
        select o.id, o.order_no, o.total_amount, ${dayOf("o.created_at")} as due, c.id as customer_id, c.name as customer
          from orders o join customers c on c.id = o.customer_id
         where o.status = 'pending_approval'`),
    ]);
    return rows.flatMap((r) =>
      people.map((who) => ({
        key: `${str(r.id)}:${who}`,
        assigneeId: who,
        title: `Approve ${r.order_no ? `order ${str(r.order_no)}` : "an order"} — ${str(r.customer)}, ${money(Number(r.total_amount))}`,
        note: null,
        customerId: str(r.customer_id),
        dueDate: str(r.due),
        priority: "high" as const,
      })),
    );
  },

  async "erp.po-approval"() {
    const [approvers, rows] = await Promise.all([
      db.execute<{ id: string }>(sql`
        select distinct u.id from users u join app_access a on a.user_id = u.id and a.app::text = 'erp'
         where u.active = true
           and (a.role = 'admin' or exists (select 1 from erp_user_powers p where p.user_id = u.id and p.power = 'approvePurchaseOrder'))`),
      db.execute<Row>(sql`
        select o.id, o.po_number, o.po_date::text as due, o.created_by_id, s.name as supplier
          from erp_purchase_orders o left join erp_suppliers s on s.id = o.supplier_id
         where o.status = 'Pending approval'`),
    ]);
    return rows.flatMap((r) =>
      approvers
        .filter((a) => a.id !== r.created_by_id)
        .map((a) => ({
          key: `${str(r.id)}:${a.id}`,
          assigneeId: a.id,
          title: `Approve PO-${str(r.po_number)}${r.supplier ? ` — ${str(r.supplier)}` : ""}`,
          note: null,
          customerId: null,
          dueDate: str(r.due),
          priority: "high" as const,
        })),
    );
  },

  async "hrms.leave"() {
    const rows = await db.execute<Row>(sql`
      select l.id, l.type, l.start_date::text as from_day, l.end_date::text as to_day, l.applied_on::text as due, e.name as person, m.id as who
        from hrms_leave_requests l
        join employees e on e.id = l.employee_id
        join employee_reporting rep on rep.employee_id = l.employee_id
        join users m on m.employee_id = rep.manager_id and m.active = true
       where l.status = 'Waiting'`);
    return rows.map((r) => ({
      key: str(r.id),
      assigneeId: str(r.who),
      title: `Decide ${str(r.person)}'s leave — ${str(r.from_day) === str(r.to_day) ? str(r.from_day) : `${str(r.from_day)} to ${str(r.to_day)}`}`,
      note: r.type ? `${str(r.type)} leave` : null,
      customerId: null,
      dueDate: str(r.due),
      priority: "high",
    }));
  },
};

/** Whether each rule is on: its row, else its default. */
export async function automationStates(): Promise<Map<string, boolean>> {
  const rows = await db.select().from(taskAutomations);
  const stored = new Map(rows.map((r) => [r.rule, r.enabled]));
  return new Map(AUTOMATIONS.map((r) => [r.id, stored.get(r.id) ?? r.defaultOn]));
}

/** Open tasks per rule, for the Set up screen. */
export async function automationOpenCounts(): Promise<Map<string, number>> {
  const rows = await db.execute<{ rule: string; n: number }>(sql`
    select auto_rule as rule, count(*)::int as n from tasks where auto_rule is not null and status <> 'done' and status <> 'missed' group by auto_rule`);
  return new Map(rows.map((r) => [r.rule, Number(r.n)]));
}

async function closeAll(rule: AutomationRule, ids: string[], remark: string) {
  if (!ids.length) return 0;
  const closed = await db
    .update(tasks)
    .set({ status: "done", closedAt: new Date(), closedById: null, closeRemark: remark, updatedAt: new Date() })
    .where(and(inArray(tasks.id, ids), sql`${tasks.status} <> 'done' and ${tasks.status} <> 'missed'`))
    .returning({ id: tasks.id });
  if (closed.length) await db.insert(taskEvents).values(closed.map((t) => ({ id: newId("tev"), taskId: t.id, actorId: null, kind: "closed", body: remark })));
  return closed.length;
}

export type SyncResult = { rule: string; raised: number; updated: number; closed: number; error?: string };

/** Bring one rule's tasks in step with its records. A rule that is off closes what it raised. */
export async function syncAutomation(rule: AutomationRule, on: boolean): Promise<SyncResult> {
  const existing = (
    await db.execute<{ id: string; key: string; assignee_id: string; title: string; due: string; status: string }>(sql`
      select id, auto_key as key, assignee_id, title, due_date::text as due, status from tasks where auto_rule = ${rule.id}`)
  ).map((e) => ({ id: e.id, key: e.key, assigneeId: e.assignee_id, title: e.title, dueDate: e.due, status: e.status }));

  if (!on) {
    const closed = await closeAll(rule, existing.filter((e) => e.status !== "done" && e.status !== "missed").map((e) => e.id), "This automatic task was switched off.");
    return { rule: rule.id, raised: 0, updated: 0, closed };
  }
  const wanted = (await READERS[rule.id]()).filter((w) => w.assigneeId && w.dueDate);
  const plan = planAutoSync(wanted, existing);

  let raised = 0;
  for (let i = 0; i < plan.insert.length; i += 200) {
    const rows = plan.insert.slice(i, i + 200).map((w) => ({
      id: newId("tsk"),
      title: w.title.slice(0, 200),
      note: w.note,
      app: rule.app,
      customerId: w.customerId,
      assigneeId: w.assigneeId,
      createdById: w.assigneeId,
      priority: w.priority,
      dueDate: w.dueDate,
      autoRule: rule.id,
      autoKey: w.key,
    }));
    const landed = await db.insert(tasks).values(rows).onConflictDoNothing().returning({ id: tasks.id });
    raised += landed.length;
    if (landed.length) {
      await db.insert(taskEvents).values(landed.map((t) => ({ id: newId("tev"), taskId: t.id, actorId: null, kind: "created", body: `Raised automatically: ${rule.when.toLowerCase()}.` })));
    }
  }
  for (const u of plan.update) {
    await db
      .update(tasks)
      .set({ ...u.set, ...(u.set.title ? { title: u.set.title.slice(0, 200) } : {}), updatedAt: new Date() })
      .where(eq(tasks.id, u.id));
  }
  const closed = await closeAll(rule, plan.close, rule.closedRemark);
  return { rule: rule.id, raised, updated: plan.update.length, closed };
}

/** Every rule, each on its own so one failing read never stops the others. */
export async function syncAutomations(only?: string): Promise<SyncResult[]> {
  const states = await automationStates();
  const out: SyncResult[] = [];
  for (const rule of AUTOMATIONS) {
    if (only && rule.id !== only) continue;
    try {
      out.push(await syncAutomation(rule, states.get(rule.id) ?? rule.defaultOn));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`Automatic tasks (${rule.id}) failed:`, error);
      out.push({ rule: rule.id, raised: 0, updated: 0, closed: 0, error });
    }
  }
  return out;
}

export function ruleFor(id: string | null | undefined): AutomationRule | null {
  return id ? (AUTOMATION_BY_ID.get(id) ?? null) : null;
}
