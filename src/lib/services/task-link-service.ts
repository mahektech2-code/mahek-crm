import "server-only";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import {
  reconcileContacts,
  updateContact,
} from "@/lib/services/customer-contact-service";
import {
  expandTaskForm,
  formHasLinks,
  linkedTaskComplete,
  parseTaskForm,
  taskAnswerText,
  type BirthdayAnswer,
  type ExpandedLink,
  type LocationAnswer,
  type TaskAnswer,
  type TaskAnswers,
  type TaskField,
  type TaskLinkContext,
} from "@/lib/task-form";

/* ---------------------------------------------------------------------------
 * WHERE A TASK MEETS THE CUSTOMER RECORD.
 *
 * Three jobs, all reading one shape (`TaskLinkContext`, built by ONE fragment
 * of SQL so the handset's prefill, the audience's "already complete" and the
 * write-back can never disagree about what the record says):
 *
 *   - write a linked answer back to the record, through the same service the
 *     CRM's contact panel uses, so mirrors, duplicate checks and the audit
 *     trail all behave exactly as for a person typing it;
 *   - complete a FILL task by itself the moment its shop's record holds
 *     everything it asked — however that came about;
 *   - nudge open linked tasks so the handset's next pull carries a fresh view
 *     of the record.
 * ------------------------------------------------------------------------- */

/**
 * The record as a task sees it, for the shop named by `customerIdExpr`. Shops
 * whose people were never split into contacts get one stand-in contact built
 * from the shop row's own phone and contact person, with a null id — the
 * write-back reconciles the shop first and then finds the real row.
 */
export function taskContextSql(customerIdExpr: string): SQL {
  const id = sql.raw(customerIdExpr);
  return sql`(select json_build_object(
      'contacts', coalesce(
        (select json_agg(json_build_object(
            'id', cc.id, 'name', cc.name, 'role', cc.role, 'phone', cc.phone,
            'email', cc.email, 'birthDay', cc.birth_day, 'birthMonth', cc.birth_month,
            'isPrimary', cc.is_primary)
           order by cc.is_primary desc, cc.sort_order asc, cc.created_at asc)
           from customer_contacts cc where cc.customer_id = ctx_c.id),
        case when nullif(trim(ctx_c.phone), '') is null then '[]'::json
             else json_build_array(json_build_object(
               'id', null, 'name', nullif(trim(ctx_c.contact_person), ''), 'role', null,
               'phone', ctx_c.phone, 'email', null, 'birthDay', null, 'birthMonth', null,
               'isPrimary', true)) end),
      'shop', json_build_object(
        'email', ctx_c.email, 'address', ctx_c.address, 'lat', ctx_c.gps_lat, 'lng', ctx_c.gps_lng))
     from customers ctx_c where ctx_c.id = ${id})`;
}

/** The record for several shops at once. */
export async function linkContexts(customerIds: string[]): Promise<Map<string, TaskLinkContext>> {
  const out = new Map<string, TaskLinkContext>();
  const ids = [...new Set(customerIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = (await db.execute<{ id: string; context: TaskLinkContext | null }>(sql`
      select c.id, ${taskContextSql("c.id")} as context
        from customers c
       where c.id in (${sql.join(chunk.map((x) => sql`${x}`), sql`, `)})
    `)) as unknown as { id: string; context: TaskLinkContext | null }[];
    for (const r of rows) if (r.context) out.set(r.id, r.context);
  }
  return out;
}

/** Same day-and-month, same digits, same words — "nothing to write". */
function sameValue(a: TaskAnswer | undefined, b: TaskAnswer | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const x = a as Partial<BirthdayAnswer & LocationAnswer>;
    const y = b as Partial<BirthdayAnswer & LocationAnswer>;
    if ("day" in x || "day" in y) return x.day === y.day && x.month === y.month;
    return Math.abs((x.lat ?? 0) - (y.lat ?? 0)) < 1e-6 && Math.abs((x.lng ?? 0) - (y.lng ?? 0)) < 1e-6;
  }
  const text = (v: TaskAnswer) => String(v).trim().toLowerCase();
  const digits = (v: TaskAnswer) => String(v).replace(/\D/g, "").slice(-10);
  if (/\d{6,}/.test(String(a).replace(/\D/g, ""))) return digits(a) === digits(b);
  return text(a) === text(b);
}

/**
 * Write each linked answer to the record. Never throws: an answer the record
 * refuses (a number already on another contact, say) is reported in the
 * results and the task still lands — the salesman did the work.
 */
export async function applyLinkedAnswers(args: {
  taskId: string;
  customerId: string;
  links: Record<string, ExpandedLink>;
  fields: TaskField[];
  answers: TaskAnswers;
  actorId: string;
}): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  const config = await getConfig();
  let reconciled = false;

  for (const [key, link] of Object.entries(args.links)) {
    const answer = args.answers[key];
    if (answer === undefined) continue;
    if (sameValue(answer, link.recordValue)) {
      results[key] = "same";
      continue;
    }
    if (link.mode === "fill" && link.recordValue !== undefined) {
      results[key] = "kept";
      continue;
    }
    try {
      if (link.target.startsWith("contact.")) {
        let contactId = link.contactId;
        if (!contactId) {
          const contacts = reconciled ? null : await reconcileContacts(args.customerId, args.actorId);
          reconciled = true;
          const primary = (contacts ?? []).find((c) => c.isPrimary) ?? contacts?.[0];
          contactId = primary?.id ?? null;
        }
        if (!contactId) {
          results[key] = "No contact on this shop to save it to.";
          continue;
        }
        const [c] = (await db.execute<{
          name: string | null; role: string; phone: string; email: string | null; note: string | null;
          birthDay: number | null; birthMonth: number | null;
        }>(sql`select name, role, phone, email, note, birth_day as "birthDay", birth_month as "birthMonth"
                 from customer_contacts where id = ${contactId}`)) as unknown as {
          name: string | null; role: string; phone: string; email: string | null; note: string | null;
          birthDay: number | null; birthMonth: number | null;
        }[];
        if (!c) {
          results[key] = "That contact is no longer on the shop.";
          continue;
        }
        const next = { name: c.name, role: c.role, phone: c.phone, email: c.email, note: c.note, birthDay: c.birthDay, birthMonth: c.birthMonth };
        if (link.target === "contact.birthday") {
          const b = answer as BirthdayAnswer;
          next.birthDay = b.day;
          next.birthMonth = b.month;
        } else if (link.target === "contact.mobile") next.phone = String(answer);
        else if (link.target === "contact.email") next.email = String(answer);
        else if (link.target === "contact.name") next.name = String(answer);
        const r = await updateContact(contactId, next, args.actorId);
        results[key] = r.ok ? "saved" : r.error;
      } else if (link.target === "shop.location") {
        const l = answer as LocationAnswer;
        /* A pin every later check-in is measured against: a coarse fix never
           becomes one, the rule the visit check-in already keeps. */
        const limit = Number(config["mbos.location.gpsAccuracyThresholdM"] ?? 50);
        if (l.accuracyM != null && l.accuracyM > limit) {
          results[key] = `The reading was only good to ${l.accuracyM} m, so the pin was not moved.`;
          continue;
        }
        await db.execute(sql`
          update customers set gps_lat = ${l.lat}, gps_lng = ${l.lng}, gps_accuracy_m = ${l.accuracyM ?? null},
                 updated_at = now()
           where id = ${args.customerId}
             ${link.mode === "fill" ? sql`and gps_lat is null` : sql``}
        `);
        await audit(args.actorId, "customer.task.linkSaved", args.customerId, link.recordValue, answer, key);
        results[key] = "saved";
      } else if (link.target === "shop.email" || link.target === "shop.address") {
        const column = sql.raw(link.target === "shop.email" ? "email" : "address");
        await db.execute(sql`update customers set ${column} = ${String(answer)}, updated_at = now() where id = ${args.customerId}`);
        await audit(args.actorId, "customer.task.linkSaved", args.customerId, link.recordValue, answer, key);
        results[key] = "saved";
      }
    } catch (e) {
      results[key] = e instanceof Error ? e.message.slice(0, 200) : "Could not save it to the record.";
    }
  }
  return results;
}

async function audit(actorId: string, action: string, customerId: string, before: unknown, after: unknown, field: string) {
  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId,
    action,
    entityType: "customer",
    entityId: customerId,
    beforeState: { field, value: before ?? null } as never,
    afterState: { field, value: after } as never,
  });
}

/**
 * Complete every open FILL task whose shop's record now holds everything it
 * asks, and touch the rest of the open linked tasks on those shops so the
 * handset's next pull shows the record as it now stands. Optionally narrowed
 * to some shops; the hourly sweep passes none.
 */
export async function settleLinkedTasks(customerIds?: string[]): Promise<{ completed: number }> {
  const narrow = customerIds?.length
    ? sql`and t.customer_id in (${sql.join(customerIds.map((x) => sql`${x}`), sql`, `)})`
    : sql``;
  const open = (await db.execute<{ id: string; customerId: string; form: unknown }>(sql`
    select t.id, t.customer_id as "customerId", k.form
      from mbos_tasks t
      join mbos_task_campaigns k on k.id = t.campaign_id
     where t.status in ('open', 'in_progress') and t.customer_id is not null
       and jsonb_path_exists(k.form, '$[*].link')
       ${narrow}
     limit 5000
  `)) as unknown as { id: string; customerId: string; form: unknown }[];
  if (!open.length) return { completed: 0 };

  const contexts = await linkContexts(open.map((t) => t.customerId));
  let completed = 0;
  for (const t of open) {
    const form = parseTaskForm(t.form);
    const ctx = contexts.get(t.customerId) ?? null;
    if (!formHasLinks(form) || !linkedTaskComplete(form, ctx)) continue;
    const { prefill, fields } = expandTaskForm(form, ctx);
    const note = fields
      .filter((f) => prefill[f.id] !== undefined)
      .map((f) => `${f.label}: ${taskAnswerText(f, prefill[f.id])}`)
      .join("\n");
    const rows = (await db.execute<{ id: string }>(sql`
      update mbos_tasks
         set status = 'done', completed_via = 'record', completed_at = now(), responded_at = now(),
             responses = ${JSON.stringify(prefill)}::jsonb,
             completion_note = ${`Already on the customer record — completed automatically.\n${note}`.slice(0, 2000)},
             updated_at = now()
       where id = ${t.id} and status in ('open', 'in_progress')
      returning id
    `)) as unknown as { id: string }[];
    completed += rows.length;
  }
  if (customerIds?.length) {
    /* A newer view of the record for the phones still holding these tasks. */
    await db.execute(sql`
      update mbos_tasks t set updated_at = now()
        from mbos_task_campaigns k
       where k.id = t.campaign_id and t.status in ('open', 'in_progress')
         and jsonb_path_exists(k.form, '$[*].link') ${narrow}
    `);
  }
  return { completed };
}
