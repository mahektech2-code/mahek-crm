import "server-only";
import { randomUUID } from "node:crypto";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, whatsappDndEvents } from "@/db/schema";
import { err, okVoid, type Result } from "../result";
import { requireFounderDesk } from "./whatsapp-switch-service";

/* ---------------------------------------------------------------------------
 * WhatsApp DND — the Founder desk's contact list, and who gets no messages.
 *
 * A customer on DND receives no WhatsApp message by any path: the automation
 * rules leave them out of the audience, and prepare, preview and send all
 * refuse them with the remark said back. Calls are untouched — that is what
 * `do_not_contact` is for, and a shop asking us to stop messaging it has not
 * asked us to stop ringing.
 *
 * Putting somebody on DND and taking them off both demand a remark, written to
 * `whatsapp_dnd_events` beside who did it. The customer row carries the
 * current answer so every send check reads one column.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export type ContactFilter = "all" | "dnd" | "open";

export type ContactRow = {
  id: string;
  name: string;
  kind: string;
  phone: string;
  whatsappPhone: string | null;
  city: string;
  status: string;
  doNotContact: boolean;
  dnd: boolean;
  dndReason: string | null;
  dndAt: string | null;
  dndByName: string | null;
  lastMessageAt: string | null;
  lastMessageStatus: string | null;
};

export const CONTACTS_PAGE = 50;

export async function listContacts(input: { q?: string; filter?: ContactFilter; page?: number }) {
  await requireFounderDesk();
  const q = input.q?.trim() ?? "";
  const filter = input.filter ?? "all";
  const page = Math.max(1, input.page ?? 1);
  const like = `%${q}%`;
  const digits = q.replace(/\D/g, "");

  const where = sql`
    c.status <> 'deactivated' and c.deleted_at is null
    ${filter === "dnd" ? sql`and c.whatsapp_dnd` : filter === "open" ? sql`and not c.whatsapp_dnd and not c.do_not_contact` : sql``}
    ${
      q
        ? sql`and (c.name ilike ${like} or c.city ilike ${like} or c.contact_person ilike ${like}
              ${digits.length >= 3 ? sql`or regexp_replace(coalesce(c.whatsapp_phone, c.phone), '\\D', '', 'g') like ${`%${digits}%`}` : sql``})`
        : sql``
    }`;

  const [rows, totals] = await Promise.all([
    db.execute<{
      id: string;
      name: string;
      kind: string;
      phone: string;
      whatsapp_phone: string | null;
      city: string;
      status: string;
      do_not_contact: boolean;
      whatsapp_dnd: boolean;
      whatsapp_dnd_reason: string | null;
      whatsapp_dnd_at: string | null;
      whatsapp_dnd_by_name: string | null;
      last_at: string | null;
      last_status: string | null;
    }>(sql`
      select c.id, c.name, c.kind::text as kind, c.phone, c.whatsapp_phone, c.city, c.status::text as status,
             c.do_not_contact, c.whatsapp_dnd, c.whatsapp_dnd_reason, to_json(c.whatsapp_dnd_at) #>> '{}' as whatsapp_dnd_at,
             c.whatsapp_dnd_by_name, to_json(m.at) #>> '{}' as last_at, m.status as last_status
        from customers c
        left join lateral (
          select coalesce(w.sent_at, w.prepared_at) as at, w.status::text as status
            from wa_messages w
           where w.customer_id = c.id
           order by coalesce(w.sent_at, w.prepared_at) desc nulls last
           limit 1
        ) m on true
       where ${where}
       order by c.whatsapp_dnd desc, c.whatsapp_dnd_at desc nulls last, c.name, c.id
       limit ${CONTACTS_PAGE} offset ${(page - 1) * CONTACTS_PAGE}
    `),
    db.execute<{ total: string; dnd: string; dnc: string; matched: string }>(sql`
      select count(*) filter (where c.status <> 'deactivated')::text as total,
             count(*) filter (where c.status <> 'deactivated' and c.whatsapp_dnd)::text as dnd,
             count(*) filter (where c.status <> 'deactivated' and c.do_not_contact and not c.whatsapp_dnd)::text as dnc,
             (select count(*) from customers c where ${where})::text as matched
        from customers c
    `),
  ]);

  const t = totals[0];
  return {
    rows: rows.map(
      (r): ContactRow => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        phone: r.phone,
        whatsappPhone: r.whatsapp_phone,
        city: r.city,
        status: r.status,
        doNotContact: r.do_not_contact,
        dnd: r.whatsapp_dnd,
        dndReason: r.whatsapp_dnd_reason,
        dndAt: r.whatsapp_dnd_at,
        dndByName: r.whatsapp_dnd_by_name,
        lastMessageAt: r.last_at,
        lastMessageStatus: r.last_status,
      }),
    ),
    total: Number(t?.total ?? 0),
    dnd: Number(t?.dnd ?? 0),
    /** Marked do not contact (which also stops messages) but not on DND itself. */
    dnc: Number(t?.dnc ?? 0),
    matched: Number(t?.matched ?? 0),
    page,
  };
}

/** One customer's DND history, newest first. */
export async function dndHistory(customerId: string) {
  await requireFounderDesk();
  return db
    .select()
    .from(whatsappDndEvents)
    .where(eq(whatsappDndEvents.customerId, customerId))
    .orderBy(desc(whatsappDndEvents.at))
    .limit(50);
}

/**
 * Put customers on WhatsApp DND, or take them off — one or many, one remark.
 * Customers already in the asked-for state are left alone and counted, so a
 * second click writes no second history row.
 */
export async function setWhatsappDnd(input: { customerIds: string[]; dnd: boolean; reason: string }): Promise<Result> {
  const ctx = await requireFounderDesk();
  const reason = input.reason.trim();
  if (reason.length < 3) {
    return err("Write a remark — why this customer should or should not get messages.", "validation", [
      { field: "reason", message: "A remark is required" },
    ]);
  }
  const ids = Array.from(new Set(input.customerIds)).slice(0, 500);
  if (!ids.length) return err("Choose at least one customer.", "validation");

  const found = await db
    .select({ id: customers.id, name: customers.name, dnd: customers.whatsappDnd })
    .from(customers)
    .where(inArray(customers.id, ids));
  const change = found.filter((c) => c.dnd !== input.dnd);
  if (!change.length) {
    return okVoid(input.dnd ? "Already on WhatsApp DND" : "Already receiving messages");
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(customers)
      .set(
        input.dnd
          ? { whatsappDnd: true, whatsappDndReason: reason, whatsappDndAt: now, whatsappDndByName: ctx.user.name }
          : { whatsappDnd: false, whatsappDndReason: null, whatsappDndAt: null, whatsappDndByName: null },
      )
      .where(
        inArray(
          customers.id,
          change.map((c) => c.id),
        ),
      );
    await tx.insert(whatsappDndEvents).values(
      change.map((c) => ({
        id: newId("wdnd"),
        customerId: c.id,
        dnd: input.dnd,
        reason,
        changedById: ctx.user.id,
        changedByName: ctx.user.name,
        at: now,
      })),
    );
    await tx.insert(auditLog).values(
      change.map((c) => ({
        id: newId("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        action: input.dnd ? "whatsapp.dnd_on" : "whatsapp.dnd_off",
        entityType: "customer",
        entityId: c.id,
        afterState: { whatsappDnd: input.dnd, reason } as never,
      })),
    );
  });

  const who = change.length === 1 ? change[0].name : `${change.length} customers`;
  const skipped = found.length - change.length;
  return okVoid(
    `${who} ${input.dnd ? "put on WhatsApp DND — no messages will go to them" : "taken off WhatsApp DND — messages can go again"}${
      skipped ? ` · ${skipped} already ${input.dnd ? "on DND" : "off DND"}` : ""
    }`,
  );
}
