import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { assertCustomerInScope, requireCapability } from "@/lib/access-control";
import { today } from "@/lib/recompute";
import { TRASH_BATCH_LIMIT } from "@/lib/services/lead-trash-service";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { leadTrashIds } from "./lead-key";

/* ---------------------------------------------------------------------------
 * MOVING LEADS TO THE TRASH, said before it happens.
 *
 * The trash is a soft delete: the row stays and so does everything pointing
 * at it, and an administrator restores it whole. So most of this report is
 * what STAYS — the calls, visits, samples and timeline a person might fear
 * the delete takes — and the few things that genuinely move: the lead leaves
 * every salesman's handset, and the open field tasks about it are closed so
 * they leave the salesmen's lists too (a restore reopens exactly those).
 *
 * Two things the trash does NOT resolve, and says so rather than hiding:
 * approvals still waiting on somebody's list, and stops already planned on a
 * salesman's day. Both are decisions about work in flight, for a person.
 *
 * The id is the batch (`lead-key.ts`). Only leads in the caller's book are
 * described; one outside it is counted and never named, so the modal is not
 * a way to read a record somebody could not open.
 * ------------------------------------------------------------------------- */

type Refused = { id: string; name: string | null; why: string };

/** The same refusals, in the same words, as `trashLeads`. */
async function sort(ids: string[]) {
  const rows = await db.select().from(customers).where(inArray(customers.id, ids));
  const moving: typeof rows = [];
  const refused: Refused[] = ids.filter((x) => !rows.some((r) => r.id === x)).map((x) => ({ id: x, name: null, why: "no longer exists" }));
  for (const c of rows) {
    let mine = true;
    try {
      await assertCustomerInScope(c);
    } catch {
      mine = false;
    }
    if (!mine) refused.push({ id: c.id, name: null, why: "is not in your book" });
    else if (c.kind !== "lead") refused.push({ id: c.id, name: c.name, why: "is a customer we have billed — deactivate it instead" });
    else if (c.deletedAt) refused.push({ id: c.id, name: c.name, why: "is already in the trash" });
    else moving.push(c);
  }
  return { moving, refused };
}

const said = (r: Refused) => `${r.name ?? "One of them"} ${r.why}`;

export const leadTrashImpact: ImpactSource = {
  /* The capability the act asks for. Which leads are the caller's is decided
     lead by lead in the report, exactly as the act decides it. */
  authorize: async () => {
    await requireCapability("lead.trash");
  },

  async report(key) {
    const ids = leadTrashIds(key);
    if (!ids.length) return null;
    /* The act refuses a bigger batch before it asks; the report does not read one either. */
    if (ids.length > TRASH_BATCH_LIMIT) {
      return { title: `${ids.length} leads`, verb: "Move to trash", confirmWord: `${ids.length} leads`, items: [], blockers: [`Delete at most ${TRASH_BATCH_LIMIT} leads at a time.`] };
    }
    const { moving, refused } = await sort(ids);
    if (!moving.length && refused.every((r) => r.why === "no longer exists")) return null;

    const blockers: string[] = [];
    if (!moving.length) {
      blockers.push(refused.length === 1 ? `${said(refused[0])}.` : `None of those can be moved to the trash: ${said(refused[0])}.`);
    }
    const m = moving.map((c) => c.id);
    const day = await today();
    const none = [{ n: 0 }];
    const count = (q: ReturnType<typeof sql>) => (m.length ? db.execute<{ n: number }>(q) : Promise.resolve(none));

    const [calls, reminders, visits, samples, timeline, tasks, approvals, stops, phones, twins, links] = await Promise.all([
      count(sql`select count(*)::int as n from calls where customer_id in ${m}`),
      count(sql`select count(*)::int as n from reminders where customer_id in ${m} and status = 'pending'`),
      count(sql`select count(*)::int as n from mbos_visits where customer_id in ${m}`),
      m.length
        ? db.execute<{ n: number; open: number }>(sql`
            select count(*)::int as n,
                   count(*) filter (where state in ('requested', 'approved', 'dispatched', 'received', 'trial_done'))::int as open
              from mbos_samples where customer_id in ${m}`)
        : Promise.resolve([{ n: 0, open: 0 }]),
      count(sql`select count(*)::int as n from timeline_events where customer_id in ${m}`),
      m.length
        ? db.execute<{ title: string; who: string | null }>(sql`
            select t.title, u.name as who
              from mbos_tasks t left join users u on u.id = t.assigned_to_user_id
             where t.customer_id in ${m} and t.status in ('open', 'in_progress')
             order by t.due_date asc nulls last, t.id`)
        : Promise.resolve([]),
      m.length
        ? db.execute<{ type: string; who: string | null }>(sql`
            select a.type::text as type, u.name as who
              from mbos_approvals a left join users u on u.id = a.approver_user_id
             where a.state = 'pending'
               and ((a.subject_type = 'customers' and a.subject_id in ${m})
                 or (a.subject_type = 'mbos_samples' and a.subject_id in (select s.id from mbos_samples s where s.customer_id in ${m})))
             order by a.requested_at`)
        : Promise.resolve([]),
      m.length
        ? db.execute<{ day: string; who: string | null; shop: string }>(sql`
            select p.plan_date::text as day, u.name as who, c.name as shop
              from mbos_journey_stops s
              join mbos_journey_plans p on p.id = s.plan_id
              join customers c on c.id = s.customer_id
              left join users u on u.id = p.user_id
             where s.customer_id in ${m} and s.status = 'planned' and p.plan_date >= ${day}::date
             order by p.plan_date, s.sequence`)
        : Promise.resolve([]),
      /* Whose phone holds it: anybody in one of its seats with a handset bound. */
      m.length
        ? db.execute<{ name: string }>(sql`
            select distinct u.name
              from customers c
              join users u on u.id in (c.owner_id, c.sales_am_id, c.lead_manager_id, c.back_office_am_id, c.relationship_owner_id)
             where c.id in ${m}
               and exists (select 1 from mbos_devices d where d.user_id = u.id and d.active)
             order by u.name`)
        : Promise.resolve([]),
      /* A customer carrying the same name: the shop this lead duplicates (`lead-twin-service.ts`). */
      m.length
        ? db.execute<{ name: string }>(sql`
            select distinct k.name
              from customers l
              join customers k on k.kind = 'customer' and k.deleted_at is null and k.id <> l.id
                and upper(btrim(regexp_replace(k.name, '\\s+', ' ', 'g'))) = upper(btrim(regexp_replace(l.name, '\\s+', ' ', 'g')))
             where l.id in ${m}
             order by k.name`)
        : Promise.resolve([]),
      count(sql`select count(*)::int as n from customer_distributors where customer_id in ${m} or distributor_customer_id in ${m}`),
    ]);
    const n = (r: { n: number }[]) => Number(r[0]?.n ?? 0);
    const one = moving.length === 1;

    const items: ImpactItem[] = [
      {
        app: "MBOS handsets",
        label: phones.length === 1 ? "salesman's phone" : "salesmen's phones",
        effect: "phones",
        count: phones.length,
        examples: phones.slice(0, 5).map((p) => p.name),
        note: `${one ? "It leaves" : "They leave"} the Customers list and ${one ? "is" : "are"} archived under Leads on the next sync.`,
      },
      {
        app: "Sales Dashboard",
        label: tasks.length === 1 ? "open field task about it" : "open field tasks about them",
        effect: "changed",
        count: tasks.length,
        examples: tasks.slice(0, 5).map((t) => (t.who ? `${t.title} · ${t.who}` : t.title)),
        note: "Closed, so they leave the salesmen's task lists and phones. Restoring reopens exactly these.",
      },
      {
        app: "Sales Dashboard",
        label: approvals.length === 1 ? "approval still waiting" : "approvals still waiting",
        effect: "kept",
        count: approvals.length,
        examples: approvals.slice(0, 5).map((a) => `${a.type.replace(/_/g, " ")}${a.who ? ` · ${a.who}` : ""}`),
        note: "The trash does not decide them — they stay on the approver's list until somebody does.",
      },
      {
        app: "Sales Dashboard",
        label: stops.length === 1 ? "stop planned on a salesman's day" : "stops planned on salesmen's days",
        effect: "kept",
        count: stops.length,
        examples: stops.slice(0, 5).map((s) => `${s.day} · ${s.shop}${s.who ? ` · ${s.who}` : ""}`),
        note: "They stay on the planned days, for a shop the phone no longer lists — take them off the day.",
      },
      { app: "CRM", label: "calls logged", effect: "kept", count: n(calls), note: "Calls, notes and messages stay with it in the trash and come back whole on a restore." },
      { app: "CRM", label: "pending reminders", effect: "kept", count: n(reminders) },
      { app: "CRM", label: "timeline entries", effect: "kept", count: n(timeline) },
      { app: "Sales Dashboard", label: "field visits", effect: "kept", count: n(visits) },
      {
        app: "Sales Dashboard",
        label: "samples",
        effect: "kept",
        count: Number(samples[0]?.n ?? 0),
        note: Number(samples[0]?.open ?? 0) ? `${samples[0].open} still in progress — dispatched, on trial or waiting for review.` : undefined,
      },
      {
        app: "CRM",
        label: twins.length === 1 ? "customer with the same name" : "customers with the same name",
        effect: "kept",
        count: twins.length,
        examples: twins.slice(0, 5).map((t) => t.name),
        note: "Nothing moves to it: MahekOne cannot merge two records, so the lead's history stays on the lead.",
      },
      { app: "CRM", label: "distributor links", effect: "kept", count: n(links) },
      {
        app: "Admin Console",
        label: one ? "lead restorable from Deleted leads" : "leads restorable from Deleted leads",
        effect: "kept",
        count: moving.length,
        note: "An administrator brings it back with its owner, stage and every call and note.",
      },
    ];
    if (moving.length && refused.length) {
      items.push({
        app: "CRM",
        label: refused.length === 1 ? "lead that will not move" : "leads that will not move",
        effect: "kept",
        count: refused.length,
        examples: refused.slice(0, 5).map(said),
        note: "Left where they are, and kept ticked.",
      });
    }

    const title =
      moving.length === 1
        ? moving[0].name
        : moving.length
          ? `${moving.length} leads`
          : ids.length === 1
            ? (refused[0]?.name ?? "this lead")
            : `${ids.length} leads`;
    return {
      title,
      verb: "Move to trash",
      confirmWord: title,
      items: items.filter((i) => i.count > 0),
      blockers,
    };
  },
};
