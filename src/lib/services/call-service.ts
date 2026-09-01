import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  calls,
  complaints,
  customers,
  reminders,
  waMessages,
} from "@/db/schema";
import { assertCustomerInScope } from "../access-control";


/* ---------------------------------------------------------------------------
 * Call logging.
 *
 * One transaction covers the call and everything it produced. Half-saved calls
 * are how telecaller data goes wrong.
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Reads over the interaction log.
 *
 * Writing lives in interaction-service.ts — one save operation for all
 * thirteen workflows, so there is no second path that can drift from it.
 * ------------------------------------------------------------------------- */

/* --------------------------------------------------------- merged history */

export type HistoryEntry = {
  id: string;
  kind: "call" | "whatsapp";
  at: string;
  actor: string;
  summary: string;
  detail: string | null;
};

/** Calls and WhatsApp messages as one stream, newest first. */
export async function customerHistory(
  customerId: string,
  limit = 100,
): Promise<HistoryEntry[]> {
  const rows = await db.execute<{
    id: string;
    kind: "call" | "whatsapp";
    at: Date;
    actor: string;
    summary: string;
    detail: string | null;
  }>(sql`
    select c.id, 'call' as kind, c.started_at as at, u.name as actor,
           concat_ws(' · ', c.connection_status, c.outcome) as summary,
           c.notes as detail
      from calls c join users u on u.id = c.user_id
     where c.customer_id = ${customerId}
    union all
    select m.id, 'whatsapp', coalesce(m.confirmed_sent_at, m.sent_at, m.prepared_at),
           u.name, coalesce(m.template_name, 'WhatsApp message'),
           concat_ws(' · ', m.resolved_destination, m.status)
      from wa_messages m join users u on u.id = m.user_id
     where m.customer_id = ${customerId}
       and m.status in ('sent_manually','sent','delivered','read')
    order by at desc
    limit ${limit}
  `);

  return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
}

/* ------------------------------------------------------- handover summary */

export type Handover = {
  customerName: string;
  lastThree: HistoryEntry[];
  lastPromise: string | null;
  openCommitments: Array<{ note: string; dueDate: string }>;
  openComplaint: string | null;
  followUpStage: number | null;
  /** Copyable, for pasting into a chat when passing a customer over. */
  text: string;
};

export async function handoverSummary(customerId: string): Promise<Handover | null> {
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!customer) return null;
  await assertCustomerInScope(customer);

  const history = await customerHistory(customerId, 3);

  const commitments = await db
    .select({ note: reminders.note, dueDate: reminders.dueDate })
    .from(reminders)
    .where(and(eq(reminders.customerId, customerId), eq(reminders.status, "pending")))
    .orderBy(reminders.dueDate);

  const [complaint] = await db
    .select({ description: complaints.description })
    .from(complaints)
    .where(
      and(
        eq(complaints.customerId, customerId),
        inArray(complaints.status, ["open", "in_progress", "awaiting_customer"]),
      ),
    )
    .limit(1);

  const [lastNote] = await db
    .select({ notes: calls.notes })
    .from(calls)
    .where(and(eq(calls.customerId, customerId), sql`${calls.notes} is not null`))
    .orderBy(desc(calls.startedAt))
    .limit(1);

  const text = [
    `*Handover - ${customer.name}*`,
    `${customer.contactPerson ?? "No contact person"} · ${customer.phone}`,
    "",
    "Last three interactions:",
    ...history.map((h) => `· ${h.at.slice(0, 10)} ${h.summary}: ${h.detail ?? "no note"}`),
    "",
    `Last thing promised: ${lastNote?.notes ?? "nothing recorded"}`,
    "",
    commitments.length
      ? `Open commitments:\n${commitments.map((c) => `· ${c.note} (due ${c.dueDate})`).join("\n")}`
      : "Open commitments: none",
    complaint ? `\nOpen complaint: ${complaint.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    customerName: customer.name,
    lastThree: history,
    lastPromise: lastNote?.notes ?? null,
    openCommitments: commitments,
    openComplaint: complaint?.description ?? null,
    followUpStage: null,
    text,
  };
}

export { waMessages };
