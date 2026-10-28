import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, waMessages, waRuns, waTemplates } from "@/db/schema";
import { whatsappLevel } from "@/lib/access";
import { assertCustomerInScope, canFor, requireCapability } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import type { ImpactSource } from "../registry";
import { many, present, word } from "./crm-common";

/* ---------------------------------------------------------------------------
 * WHATSAPP'S CANCELS, said before they happen.
 *
 * A message is not just a row on the WhatsApp screen: a COPIED one is a
 * customer who may already have it in their chat, and only a confirmed send
 * tells the Call Log they were contacted — so discarding one is a statement
 * about whether a customer heard from us. A template is offered by three
 * screens and named by the automation rules. A run is a list of customers
 * still waiting to be messaged.
 *
 * Every source asks what `whatsappRefusal("send")` asks — read-only access
 * may read the chats and change nothing — before saying anything.
 * ------------------------------------------------------------------------- */

async function mayChange() {
  const user = await requireUser();
  if ((await whatsappLevel(user.id)) === "read") {
    throw Object.assign(
      new Error("Your WhatsApp access is read only — you can read the chats but not reply or send. Ask for Write on the Access screen."),
      { name: "NotPermittedError" },
    );
  }
  return user;
}

/* ===================================================== a message discarded */

export const waMessageImpact: ImpactSource = {
  /* The write level, and the customer in your book — a message names one. */
  authorize: async (id) => {
    await mayChange();
    const [row] = await db
      .select({
        kind: customers.kind,
        ownerId: customers.ownerId,
        salesAmId: customers.salesAmId,
        backOfficeAmId: customers.backOfficeAmId,
        leadManagerId: customers.leadManagerId,
        relationshipOwnerId: customers.relationshipOwnerId,
        deletedAt: customers.deletedAt,
      })
      .from(waMessages)
      .innerJoin(customers, eq(customers.id, waMessages.customerId))
      .where(eq(waMessages.id, id));
    if (row) await assertCustomerInScope(row);
  },

  async report(id) {
    const [m] = await db
      .select({
        status: waMessages.status,
        destKind: waMessages.destKind,
        customerId: waMessages.customerId,
        templateId: waMessages.templateId,
        templateName: waMessages.templateName,
        customer: customers.name,
      })
      .from(waMessages)
      .innerJoin(customers, eq(customers.id, waMessages.customerId))
      .where(eq(waMessages.id, id));
    if (!m) return null;
    if (["sent_manually", "sent", "delivered", "read"].includes(m.status)) {
      return { title: m.customer, verb: "Discard", confirmWord: word(m.customer, "discard"), items: [], blockers: ["A sent message cannot be cancelled."] };
    }
    /* The other leg of a both-ways customer is its own piece of work and is not discarded with this one. */
    const [other] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from wa_messages
       where customer_id = ${m.customerId} and id <> ${id}
         and template_id is not distinct from ${m.templateId}
         and dest_kind <> ${m.destKind}
         and status in ('prepared', 'copied')`);
    const copied = m.status === "copied";
    return {
      title: `${m.templateName ?? "Message"} to ${m.customer}`,
      verb: "Discard",
      confirmWord: word(m.customer, "discard"),
      items: present([
        {
          app: "CRM",
          label: "copied message, never confirmed as sent",
          effect: "changed",
          count: copied ? 1 : 0,
          note: `If you did paste and send it, press Confirm sent instead: discarded, ${m.customer} is not recorded as messaged, and the Call Log and the reminders go on treating them as not contacted.`,
        },
        {
          app: "CRM",
          label: m.destKind === "group" ? "personal message to them" : "group post for them",
          effect: "kept",
          count: Number(other?.n ?? 0),
          note: "The other leg is its own piece of work — it stays waiting.",
        },
      ]),
      blockers: [],
    };
  },
};

/* ===================================================== a template archived */

export const waTemplateArchiveImpact: ImpactSource = {
  authorize: async () => {
    await mayChange();
    await requireCapability("whatsapp.template.write");
  },

  async report(id) {
    const [t] = await db.select({ name: waTemplates.name, active: waTemplates.active, used: waTemplates.usageCount }).from(waTemplates).where(eq(waTemplates.id, id));
    if (!t) return null;
    const [rules, runs, waiting] = await Promise.all([
      db.execute<{ status: string }>(sql`select status from wa_triggers where template_id = ${id} and status <> 'off'`),
      db.execute<{ n: number }>(sql`select count(*)::int as n from wa_runs where template_id = ${id} and status in ('active', 'paused')`),
      db.execute<{ n: number }>(sql`select count(*)::int as n from wa_messages where template_id = ${id} and status in ('prepared', 'copied')`),
    ]);
    const live = rules.filter((r) => r.status === "live").length;
    return {
      title: t.name,
      verb: "Archive",
      confirmWord: word(t.name, "archive"),
      items: present([
        {
          app: "CRM",
          label: "template offered on WhatsApp, in runs and on the collections follow-up",
          effect: "changed",
          count: t.active ? 1 : 0,
          note: "It leaves all three pickers. Restore brings it back.",
        },
        {
          app: "Founder",
          label: `automation ${many(rules.length, "rule")} sending on it`,
          effect: "kept",
          count: rules.length,
          note: live
            ? `${live} ${live === 1 ? "is" : "are"} live and archiving does not switch ${live === 1 ? "it" : "them"} off — do that on the WhatsApp automation screen.`
            : "Archiving does not switch them off.",
        },
        {
          app: "CRM",
          label: `${many(Number(runs[0]?.n ?? 0), "run")} already started on it`,
          effect: "kept",
          count: Number(runs[0]?.n ?? 0),
          note: "They carry on with the messages they prepared.",
        },
        {
          app: "CRM",
          label: `prepared ${many(Number(waiting[0]?.n ?? 0), "message")} not yet sent`,
          effect: "kept",
          count: Number(waiting[0]?.n ?? 0),
        },
        {
          app: "CRM",
          label: `${many(Number(t.used), "message")} already sent from it`,
          effect: "kept",
          count: Number(t.used),
          note: "History keeps the words they were sent in.",
        },
      ]),
      blockers: [],
    };
  },
};

/* ========================================================== a run ended */

/** Whoever drives the run, or anybody holding `whatsapp.bulk` — `requireRunDriver`. */
export const waRunEndImpact: ImpactSource = {
  authorize: async (id) => {
    const user = await mayChange();
    const [run] = await db.select({ userId: waRuns.userId }).from(waRuns).where(eq(waRuns.id, id));
    if (run && run.userId !== user.id && !(await canFor(user, "whatsapp.bulk"))) {
      throw Object.assign(new Error("That run is somebody else's."), { name: "NotPermittedError" });
    }
  },

  async report(id) {
    const [run] = await db
      .select({ status: waRuns.status, template: waTemplates.name, sent: waRuns.sentCount, skipped: waRuns.skippedCount })
      .from(waRuns)
      .leftJoin(waTemplates, eq(waTemplates.id, waRuns.templateId))
      .where(eq(waRuns.id, id));
    if (!run) return null;
    const waiting = await db.execute<{ name: string; status: string }>(sql`
      select c.name, m.status::text as status
        from wa_messages m join customers c on c.id = m.customer_id
       where m.run_id = ${id} and m.status in ('prepared', 'copied')
       order by c.name`);
    const copied = waiting.filter((w) => w.status === "copied").length;
    return {
      title: `the ${run.template ?? "WhatsApp"} run`,
      verb: "End run",
      confirmWord: "END",
      items: present([
        {
          app: "CRM",
          label: `${many(waiting.length, "customer")} still waiting in the run`,
          effect: "changed",
          count: waiting.length,
          examples: waiting.slice(0, 5).map((w) => w.name),
          note: `This run will not message them. ${
            copied ? `${copied} ${copied === 1 ? "was" : "were"} copied and never confirmed — confirm or discard ${copied === 1 ? "it" : "them"} on WhatsApp.` : ""
          }`.trim(),
        },
        {
          app: "CRM",
          label: `${many(Number(run.sent), "message")} sent and ${Number(run.skipped)} skipped`,
          effect: "kept",
          count: Number(run.sent) + Number(run.skipped),
        },
      ]),
      blockers: [],
    };
  },
};
