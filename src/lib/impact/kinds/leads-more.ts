import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, mbosSamples, mbosTasks } from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { openNurtureTaskIdsFor } from "@/lib/mbos-jobs";
import { today } from "@/lib/recompute";
import { assertLeadInScope } from "@/lib/services/lead-scope";
import { leadsInScope } from "@/lib/services/sales-service";
import type { ImpactBody, ImpactSource } from "../registry";
import { idList, many, phonesHolding, present, salesGate, word } from "./crm-common";
import { impactBatchIds } from "./crm-keys";

/* ---------------------------------------------------------------------------
 * A SAMPLE CALLED OFF AND LEADS FILED AWAY, said before they happen.
 *
 * Cancelling a sample does three things nobody sees from the button: it
 * refuses the approval still waiting on somebody's list (with the
 * cancellation as the note), it closes the review chase and the dispatch
 * chase raised for it, and it changes what the salesman's phone says about
 * the trial. Archiving a lead takes it off the working list and the phone's
 * Leads tab and tells its owner why — and leaves its open tasks, planned
 * stops and samples exactly where they were, which is the half that surprises.
 * ------------------------------------------------------------------------- */

type SampleState = "requested" | "approved" | "dispatched" | "received" | "trial_done" | "reviewed" | "rejected" | "cancelled";

/** `ALLOWED` in `actions/lead-samples.ts`: the states a sample may still be called off from. */
const CANCELLABLE: readonly SampleState[] = ["requested", "approved", "dispatched", "received", "trial_done"];

/** `STATE_WORDS` there, for the refusals said the same way. */
const STATE_WORDS: Record<SampleState, string> = {
  requested: "still waiting to be approved",
  approved: "approved and waiting to go out",
  rejected: "refused",
  dispatched: "on its way",
  received: "with the customer",
  trial_done: "tried, and waiting for the verdict",
  reviewed: "reviewed",
  cancelled: "cancelled",
};

export const sampleCancelImpact: ImpactSource = {
  /* `lead.work` and the lead in your scope — `cancelSample`'s two questions. */
  authorize: async (id) => {
    await requireCapability("lead.work");
    const [row] = await db
      .select({
        customerId: customers.id,
        kind: customers.kind,
        ownerId: customers.ownerId,
        salesAmId: customers.salesAmId,
        backOfficeAmId: customers.backOfficeAmId,
        salesManagerId: customers.salesManagerId,
      })
      .from(mbosSamples)
      .innerJoin(customers, eq(customers.id, mbosSamples.customerId))
      .where(eq(mbosSamples.id, id));
    if (row) await assertLeadInScope(row.customerId, row);
  },

  async report(id): Promise<ImpactBody | null> {
    const [s] = await db
      .select({ state: mbosSamples.state, customerId: mbosSamples.customerId, customer: customers.name })
      .from(mbosSamples)
      .innerJoin(customers, eq(customers.id, mbosSamples.customerId))
      .where(eq(mbosSamples.id, id));
    if (!s) return null;
    const state = s.state as SampleState;
    const blockers =
      state === "cancelled"
        ? ["This sample is already cancelled."]
        : CANCELLABLE.includes(state)
          ? []
          : [`This sample is ${STATE_WORDS[state]}, so it cannot be marked ${STATE_WORDS.cancelled}.`];

    const [approvals, sourceIds, phones] = await Promise.all([
      db.execute<{ who: string | null }>(sql`
        select u.name as who from mbos_approvals a left join users u on u.id = a.approver_user_id
         where a.type = 'sample' and a.subject_type = 'mbos_samples' and a.subject_id = ${id} and a.state = 'pending'`),
      openNurtureTaskIdsFor(db, id),
      phonesHolding([s.customerId]),
    ]);
    const tasks = sourceIds.length
      ? await db
          .select({ title: mbosTasks.title })
          .from(mbosTasks)
          .where(inArray(mbosTasks.sourceId, sourceIds))
      : [];

    return {
      title: `the sample for ${s.customer}`,
      verb: "Cancel the sample",
      confirmWord: word(s.customer, "cancel"),
      items: blockers.length
        ? []
        : present([
            {
              app: "Sales Dashboard",
              label: approvals.length === 1 ? "approval still waiting on it" : "approvals still waiting on it",
              effect: "changed",
              count: approvals.length,
              examples: approvals.slice(0, 5).map((a) => a.who ?? "Nobody named yet"),
              note: "Refused, with the cancellation as the note, so the approvals queue empties honestly.",
            },
            {
              app: "Sales Dashboard",
              label: `open ${many(tasks.length, "chase")} raised for it`,
              effect: "changed",
              count: tasks.length,
              examples: tasks.slice(0, 5).map((t) => t.title),
              note: "Closed — a chase against a sample nobody is sending is noise. They leave the salesmen's task lists.",
            },
            {
              app: "MBOS handsets",
              label: phones.length === 1 ? "salesman's phone showing the trial" : "salesmen's phones showing the trial",
              effect: "changed",
              count: phones.length,
              examples: phones.slice(0, 5),
              note: "The sample reads Cancelled there on the next sync.",
            },
            {
              app: "CRM",
              label: "sample on the lead's record",
              effect: "kept",
              count: 1,
              note: "It stays, marked cancelled with the reason, and the timeline says so.",
            },
          ]),
      blockers,
    };
  },
};

/* ===================================================== leads filed away */

/** The screens a lead is worked from — `LEAD_MODULES` in `actions/sales.ts`. */
const LEAD_MODULES = ["sales.leads", "sales.lead-pipeline"] as const;

/**
 * The id is `impactBatch(ids)` — one lead from its row, or a selection. Only
 * leads `leadsInScope` returns are described, the same narrowing the act
 * reads; one outside it is counted and never named.
 */
export const leadArchiveImpact: ImpactSource = {
  authorize: async () => {
    await salesGate(LEAD_MODULES);
  },

  async report(key): Promise<ImpactBody | null> {
    const ids = impactBatchIds(key);
    if (!ids.length) return null;
    const leads = await leadsInScope(ids);
    if (!leads.length) return null;
    const filing = leads.filter((l) => !l.leadArchived);
    const refused = ids.length - filing.length;
    const one = filing.length === 1;
    const title = one ? filing[0].name : filing.length ? `${filing.length} leads` : leads.length === 1 ? leads[0].name : `${ids.length} leads`;
    if (!filing.length) {
      return {
        title,
        verb: "Archive",
        confirmWord: word(title, "archive"),
        items: [],
        blockers: [leads.length === 1 ? `${leads[0].name} is already archived.` : "All of those are already archived."],
      };
    }

    const m = filing.map((l) => l.id);
    const day = await today();
    const [phones, counts, owners] = await Promise.all([
      phonesHolding(m),
      db.execute<{ tasks: number; stops: number; samples: number }>(sql`
        select
          (select count(*)::int from mbos_tasks where customer_id in (${idList(m)}) and status in ('open', 'in_progress')) as tasks,
          (select count(*)::int from mbos_journey_stops s join mbos_journey_plans p on p.id = s.plan_id
            where s.customer_id in (${idList(m)}) and s.status = 'planned' and p.plan_date >= ${day}::date) as stops,
          (select count(*)::int from mbos_samples where customer_id in (${idList(m)})
            and state in ('requested', 'approved', 'dispatched', 'received', 'trial_done')) as samples`),
      db.execute<{ name: string }>(sql`
        select distinct u.name from customers c join users u on u.id = c.owner_id
         where c.id in (${idList(m)}) order by u.name`),
    ]);
    const k = counts[0] ?? { tasks: 0, stops: 0, samples: 0 };

    return {
      title,
      verb: "Archive",
      confirmWord: word(title, "archive"),
      items: present([
        {
          app: "Sales Dashboard",
          label: one ? "lead leaves the working list" : "leads leave the working list",
          effect: "changed",
          count: filing.length,
          examples: filing.slice(0, 5).map((l) => l.name),
          note: "Filed under Archived. Restore brings it back as it was.",
        },
        {
          app: "MBOS handsets",
          label: phones.length === 1 ? "salesman's phone" : "salesmen's phones",
          effect: "changed",
          count: phones.length,
          examples: phones.slice(0, 5),
          note: `${one ? "It leaves" : "They leave"} the Leads tab on the next sync and stay${one ? "s" : ""} on the Customers list.`,
        },
        {
          app: "Sales Dashboard",
          label: owners.length === 1 ? "owner told why" : "owners told why",
          effect: "changed",
          count: owners.length,
          examples: owners.slice(0, 5).map((o) => o.name),
          note: "A bell with your reason, so a lead does not vanish from somebody's list unexplained.",
        },
        {
          app: "Sales Dashboard",
          label: `open field ${many(Number(k.tasks), "task")}`,
          effect: "kept",
          count: Number(k.tasks),
          note: "Archiving does not close them.",
        },
        {
          app: "Sales Dashboard",
          label: `${many(Number(k.stops), "stop")} planned on salesmen's days`,
          effect: "kept",
          count: Number(k.stops),
          note: "They stay on the planned days — take them off the day if nobody should go.",
        },
        {
          app: "Sales Dashboard",
          label: `${many(Number(k.samples), "sample")} still in progress`,
          effect: "kept",
          count: Number(k.samples),
        },
        {
          app: "Sales Dashboard",
          label: refused === 1 ? "lead that will not move" : "leads that will not move",
          effect: "kept",
          count: refused,
          note: "Already archived, or not yours to change — left where they are.",
        },
      ]),
      blockers: [],
    };
  },
};
