import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { mbosCourses, mbosDocuments, mbosExpensePayouts, mbosTaskCampaigns, users } from "@/db/schema";
import { foldShopName } from "@/lib/field-activity-match";
import { longDate, money } from "@/lib/format";
import { scopeCovers } from "@/lib/sales-gate";
import { managerScope, onlyMine } from "@/lib/services/sales-service";
import type { ImpactBody, ImpactSource } from "../registry";
import { idList, many, present, salesGate, word } from "./crm-common";

/* ---------------------------------------------------------------------------
 * WHAT THE SALES DASHBOARD TAKES OFF THE FIELD, said before it happens.
 *
 * Most of these acts are felt on phones rather than on the screen they are
 * pressed on: a withdrawn document or course is tombstoned and leaves every
 * handset it was on, withdrawn tasks leave the salesmen's task lists. Each
 * report names whose phones, and what deliberately stays — the progress
 * somebody made on a course, the answers already given to a task, the
 * payment that stays struck through on a statement.
 *
 * Every source asks `requireSalesAccess`'s gate for the act's own module, and
 * where the act lands on a person, whether that person is in the manager's
 * team — the same narrowing the act reads.
 * ------------------------------------------------------------------------- */

/** Everybody with a handset bound, or only these people's. */
async function handsets(userIds: readonly string[] | null): Promise<string[]> {
  if (userIds && !userIds.length) return [];
  const rows = await db.execute<{ name: string }>(sql`
    select distinct u.name from mbos_devices d join users u on u.id = d.user_id
     where d.active ${userIds ? sql`and d.user_id in (${idList(userIds)})` : sql``}
     order by u.name`);
  return rows.map((r) => r.name);
}

/* ============================================== a document withdrawn */

export const documentWithdrawImpact: ImpactSource = {
  authorize: async () => {
    await salesGate(["sales.documents"], true);
  },

  async report(id): Promise<ImpactBody | null> {
    const [d] = await db
      .select({ title: mbosDocuments.title, active: mbosDocuments.active, tagged: mbosDocuments.visibleToUserIds })
      .from(mbosDocuments)
      .where(eq(mbosDocuments.id, id));
    if (!d) return null;
    const tagged = d.tagged ?? [];
    const phones = d.active ? await handsets(tagged.length ? tagged : null) : [];
    return {
      title: d.title,
      verb: "Withdraw",
      confirmWord: word(d.title, "withdraw"),
      items: present([
        {
          app: "MBOS handsets",
          label: phones.length === 1 ? "salesman's phone" : "salesmen's phones",
          effect: "phones",
          count: phones.length,
          examples: phones.slice(0, 5),
          note: tagged.length ? "The people it was tagged for — it leaves their document library on the next sync." : "It was for everybody, so it leaves every handset's document library on the next sync.",
        },
        {
          app: "Sales Dashboard",
          label: "document record",
          effect: "kept",
          count: 1,
          note: "It stays here as Withdrawn, with who it was for, and can be published again.",
        },
      ]),
      blockers: [],
    };
  },
};

/* ================================================= a course withdrawn */

export const courseWithdrawImpact: ImpactSource = {
  authorize: async () => {
    await salesGate(["sales.knowledge"], true);
  },

  async report(id): Promise<ImpactBody | null> {
    const [c] = await db.select({ title: mbosCourses.title, active: mbosCourses.active, mandatory: mbosCourses.mandatory }).from(mbosCourses).where(eq(mbosCourses.id, id));
    if (!c) return null;
    const [progress, phones] = await Promise.all([
      db.execute<{ done: number; partway: number }>(sql`
        select count(*) filter (where completed_at is not null)::int as done,
               count(*) filter (where completed_at is null and started_at is not null)::int as partway
          from mbos_course_progress where course_id = ${id}`),
      c.active ? handsets(null) : Promise.resolve([] as string[]),
    ]);
    const p = progress[0] ?? { done: 0, partway: 0 };
    return {
      title: c.title,
      verb: "Withdraw",
      confirmWord: word(c.title, "withdraw"),
      items: present([
        {
          app: "MBOS handsets",
          label: phones.length === 1 ? "salesman's phone" : "salesmen's phones",
          effect: "phones",
          count: phones.length,
          examples: phones.slice(0, 5),
          note: `The material leaves the training centre on the next sync${c.mandatory ? ", and it stops being asked of anybody as compulsory" : ""}.`,
        },
        {
          app: "Sales Dashboard",
          label: `${many(Number(p.done), "person", "people")} who finished it`,
          effect: "kept",
          count: Number(p.done),
          note: "Withdrawing the material does not unfinish it.",
        },
        {
          app: "Sales Dashboard",
          label: `${many(Number(p.partway), "person", "people")} part-way through`,
          effect: "kept",
          count: Number(p.partway),
          note: "They keep their record of how far they got.",
        },
      ]),
      blockers: [],
    };
  },
};

/* ======================================= an assignment's open tasks withdrawn */

const TASK_MODULE = "sales.tasks";

export const taskCampaignWithdrawImpact: ImpactSource = {
  authorize: async () => {
    await salesGate([TASK_MODULE], true);
  },

  async report(id): Promise<ImpactBody | null> {
    const [head] = await db.select({ title: mbosTaskCampaigns.title }).from(mbosTaskCampaigns).where(eq(mbosTaskCampaigns.id, id));
    if (!head) return null;
    const scope = await managerScope();
    /* The same rows `closeTaskCampaign` updates — open, and in this manager's team. */
    const [open, answered] = await Promise.all([
      db.execute<{ who: string; n: number }>(sql`
        select u.name as who, count(*)::int as n
          from mbos_tasks t join users u on u.id = t.assigned_to_user_id
         where t.campaign_id = ${id} and t.status in ('open', 'in_progress')
           ${onlyMine(scope, "t.assigned_to_user_id")}
         group by u.name order by u.name`),
      db.execute<{ n: number }>(sql`select count(*)::int as n from mbos_tasks where campaign_id = ${id} and status = 'done'`),
    ]);
    const tasks = open.reduce((s, o) => s + Number(o.n), 0);
    return {
      title: head.title,
      verb: "Withdraw",
      confirmWord: word(head.title, "withdraw"),
      items: present([
        {
          app: "MBOS handsets",
          label: `open ${many(tasks, "task")}`,
          effect: "phones",
          count: tasks,
          examples: open.slice(0, 5).map((o) => `${o.who}${Number(o.n) > 1 ? ` (${o.n})` : ""}`),
          note: "Marked withdrawn, so they leave the salesmen's task lists and phones on the next sync.",
        },
        {
          app: "Sales Dashboard",
          label: `${many(Number(answered[0]?.n ?? 0), "answer")} already given`,
          effect: "kept",
          count: Number(answered[0]?.n ?? 0),
          note: "Kept, and still in the export.",
        },
      ]),
      blockers: tasks ? [] : ["Nothing is still open."],
    };
  },
};

/* ============================================ a reimbursement payment voided */

export const expensePayoutVoidImpact: ImpactSource = {
  /* A manager on Expenses, and the salesman in their team — `voidExpensePayout`. */
  authorize: async (id) => {
    await salesGate(["sales.expenses"], true);
    const [row] = await db.select({ userId: mbosExpensePayouts.userId }).from(mbosExpensePayouts).where(eq(mbosExpensePayouts.id, id));
    if (row && !scopeCovers(await managerScope(), row.userId)) {
      throw Object.assign(new Error("That person is not in your team, so this is not yours to change."), { name: "NotPermittedError" });
    }
  },

  async report(id): Promise<ImpactBody | null> {
    const [p] = await db
      .select({ amount: mbosExpensePayouts.amountPaise, paidOn: mbosExpensePayouts.paidOn, voidedAt: mbosExpensePayouts.voidedAt, who: users.name })
      .from(mbosExpensePayouts)
      .innerJoin(users, eq(users.id, mbosExpensePayouts.userId))
      .where(eq(mbosExpensePayouts.id, id));
    if (!p) return null;
    const amount = money(Number(p.amount));
    return {
      title: `${amount} paid to ${p.who} on ${longDate(String(p.paidOn))}`,
      verb: "Void payment",
      confirmWord: "VOID",
      items: present([
        {
          app: "Sales Dashboard",
          label: `${p.who}'s reimbursement balance`,
          effect: "changed",
          count: p.voidedAt ? 0 : 1,
          note: `The ${amount} stops counting as paid to him, so what he is owed rises by ${amount}.`,
        },
        {
          app: "Sales Dashboard",
          label: "payment on his statement",
          effect: "kept",
          count: 1,
          note: "It stays, struck through, with your reason.",
        },
      ]),
      blockers: p.voidedAt ? ["That payment was already voided."] : [],
    };
  },
};

/* ============================== a shop decision on the old app's visits undone */

const ACTIVITY_MODULE = "sales.activity-history";

/** The id is one activity row; the decision it undoes is for every row typed under the same name. */
export const activityShopUndoImpact: ImpactSource = {
  authorize: async () => {
    await salesGate([ACTIVITY_MODULE], true);
  },

  async report(rowId): Promise<ImpactBody | null> {
    const [row] = await db.execute<{ name: string | null }>(sql`select customer_name as name from sheet_field_activity_rows where id = ${rowId}`);
    const shown = row?.name?.trim();
    if (!shown) return null;
    const nameKey = foldShopName(shown);
    const [decision] = await db.execute<{ customerId: string | null; customer: string | null }>(sql`
      select d.customer_id as "customerId", c.name as customer
        from field_activity_customer_decisions d left join customers c on c.id = d.customer_id
       where d.name_key = ${nameKey}`);
    if (!decision) {
      return { title: `"${shown}"`, verb: "Take back", confirmWord: "UNDO", items: [], blockers: ["Nobody had decided this name."] };
    }
    const folded = sql`btrim(regexp_replace(upper(coalesce(customer_name, '')), '[^A-Z0-9]+', ' ', 'g'))`;
    const [exact, visits] = await Promise.all([
      db.execute<{ id: string; name: string }>(sql`
        select id, name from customers where btrim(regexp_replace(upper(name), '[^A-Z0-9]+', ' ', 'g')) = ${nameKey}`),
      db.execute<{ n: number; written: number }>(sql`
        select count(*)::int as n,
               count(*) filter (where timeline_event_written and matched_customer_id is not distinct from ${decision.customerId})::int as written
          from sheet_field_activity_rows where ${folded} = ${nameKey}`),
    ]);
    /* The importer's own rule once nobody has decided: one account carrying
       exactly this name takes the visits; none or several leaves them unmatched. */
    const next = exact.length === 1 ? exact[0] : null;
    const moves = (next?.id ?? null) !== decision.customerId;
    const n = Number(visits[0]?.n ?? 0);
    const written = moves ? Number(visits[0]?.written ?? 0) : 0;
    return {
      title: `"${shown}" → ${decision.customer ?? "not on MahekOne"}`,
      verb: "Take back",
      confirmWord: "UNDO",
      items: present([
        {
          app: "CRM",
          label: `${many(written, "visit")} on ${decision.customer ?? "the customer"}'s timeline`,
          effect: "deleted",
          count: written,
          note: "Taken off its history, and off the salesmen's phones with it.",
        },
        {
          app: "Sales Dashboard",
          label: `old-app ${many(n, "visit")} typed as "${shown}"`,
          effect: "changed",
          count: moves ? n : 0,
          note: next
            ? `They go back to the importer's own rule and land on ${next.name}, the one account carrying exactly this name.`
            : exact.length > 1
              ? `They go back to the importer's own rule: ${exact.length} accounts carry this name, so they are left for a person to decide again.`
              : "They go back to the importer's own rule: no account carries exactly this name, so they are left unmatched.",
        },
      ]),
      blockers: [],
    };
  },
};
