import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, leadTrashEvents } from "@/db/schema";
import { assertCustomerInScope, requireCapability } from "../access-control";
import { APP_TIMEZONE, asDate } from "../business-date";
import { err, ok, type Result } from "../result";
import { leadsLeftHandsets, leadsReturnedToHandsets } from "./lead-trash-sync";

/* ---------------------------------------------------------------------------
 * THE LEAD TRASH.
 *
 * Deleting a lead moves it to the trash rather than removing it: the row stays
 * and so does everything pointing at it — calls, reminders, notes, field
 * visits, WhatsApp — so a lead deleted by mistake comes back whole. While it is
 * in the trash it is on no screen: every list, count, search, calling queue,
 * message rule and handset leaves it out (`deleted_at is not null`), and the
 * Admin Console's Trash is the one place it is listed.
 *
 * Who: a manager or admin deletes (`lead.trash`, beside deactivating), and only
 * an administrator lists the trash or restores from it (`lead.restore`).
 * Only a LEAD may be deleted. An account we have invoiced is history the
 * ledger needs; it is deactivated, never trashed.
 * ------------------------------------------------------------------------- */

/** The business zone as a SQL literal: a date filter is a day in Mumbai, whatever the session's zone. */
const ZONE = sql.raw(`'${APP_TIMEZONE}'`);
const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const iso = (v: unknown) => (v === null || v === undefined ? null : asDate(v)?.toISOString() ?? null);
/** How many leads one click may move — a page's worth, and a stop on accidents. */
export const TRASH_BATCH_LIMIT = 200;

/** One lead that was not moved, and why — named back so it can be dealt with. */
export type TrashRefusal = { id: string; name: string; why: string };

/**
 * Move leads to the trash, with a reason.
 *
 * What CAN move, moves; what cannot is named back with why — the house rule
 * for every bulk action on the leads list, which keeps exactly the refused
 * leads ticked. A lead is refused when it is not a lead (an account we have
 * billed is deactivated, never trashed), is already in the trash, or is not in
 * the caller's book.
 */
export async function trashLeads(input: {
  ids: string[];
  reason: string;
}): Promise<Result<{ moved: number; failed: TrashRefusal[] }>> {
  const ctx = await requireCapability("lead.trash");
  const ids = [...new Set(input.ids.map(String).filter(Boolean))];
  const reason = input.reason.trim();
  if (!ids.length) return err("Pick at least one lead.", "validation");
  if (ids.length > TRASH_BATCH_LIMIT) return err(`Delete at most ${TRASH_BATCH_LIMIT} leads at a time.`, "validation");
  if (reason.length < 3) return err("Say why — it is shown to whoever looks in the trash.", "validation");
  if (reason.length > 500) return err("Keep the reason under 500 characters.", "validation");

  const rows = await db.select().from(customers).where(inArray(customers.id, ids));
  const failed: TrashRefusal[] = ids
    .filter((x) => !rows.some((r) => r.id === x))
    .map((x) => ({ id: x, name: x, why: "no longer exists" }));
  const moving: typeof rows = [];
  for (const c of rows) {
    if (c.kind !== "lead") {
      failed.push({ id: c.id, name: c.name, why: "is a customer we have billed — deactivate it instead" });
    } else if (c.deletedAt) {
      failed.push({ id: c.id, name: c.name, why: "is already in the trash" });
    } else {
      try {
        await assertCustomerInScope(c);
        moving.push(c);
      } catch {
        failed.push({ id: c.id, name: c.name, why: "is not in your book" });
      }
    }
  }
  if (!moving.length) {
    return err(
      failed.length === 1 ? `${failed[0].name} ${failed[0].why}.` : `None of those could be deleted: ${failed[0].name} ${failed[0].why}.`,
      "rule_violation",
    );
  }

  const movingIds = moving.map((c) => c.id);
  const now = new Date();
  const name = ctx.user.name;
  await db.transaction(async (tx) => {
    await tx
      .update(customers)
      .set({ deletedAt: now, deletedById: ctx.user.id, deletedByName: name, deletedReason: reason, updatedAt: now })
      .where(and(inArray(customers.id, movingIds), isNull(customers.deletedAt)));
    await tx.insert(leadTrashEvents).values(
      movingIds.map((customerId) => ({
        id: id("ltr"), customerId, action: "trashed", reason, actorId: ctx.user.id, actorName: name, createdAt: now,
      })),
    );
    await tx.insert(auditLog).values(
      moving.map((c) => ({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        action: "lead.trashed",
        entityType: "customer",
        entityId: c.id,
        beforeState: { name: c.name, ownerId: c.ownerId, leadStage: c.leadStage } as never,
        afterState: { reason } as never,
      })),
    );
    // Off the salesmen's phones too — on the next pull, not the next sign-in.
    await leadsLeftHandsets(tx, movingIds);
  });

  const head =
    moving.length === 1 ? `${moving[0].name} moved to the trash` : `${moving.length} leads moved to the trash`;
  return ok(
    { moved: moving.length, failed },
    failed.length ? `${head}. ${failed.length} not moved — still ticked.` : head,
  );
}

/**
 * Bring leads back from the trash, exactly as they were — same owner, same
 * stage, same history. Admin only. A lead whose owner has left keeps that
 * owner; reassigning it is a separate decision with its own screen.
 */
export async function restoreLeads(input: { ids: string[] }): Promise<Result<{ restored: number }>> {
  const ctx = await requireCapability("lead.restore");
  const ids = [...new Set(input.ids.map(String).filter(Boolean))];
  if (!ids.length) return err("Pick at least one lead.", "validation");
  if (ids.length > TRASH_BATCH_LIMIT) return err(`Restore at most ${TRASH_BATCH_LIMIT} leads at a time.`, "validation");

  const rows = await db
    .select({ id: customers.id, name: customers.name, deletedAt: customers.deletedAt, deletedReason: customers.deletedReason })
    .from(customers)
    .where(inArray(customers.id, ids));
  const inTrash = rows.filter((r) => r.deletedAt);
  if (inTrash.length !== ids.length) {
    return err("One of those is no longer in the trash. Refresh and try again.", "conflict");
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    // `updated_at` moves so every handset's next pull sends the lead back.
    await tx
      .update(customers)
      .set({ deletedAt: null, deletedById: null, deletedByName: null, deletedReason: null, updatedAt: now })
      .where(and(inArray(customers.id, ids), isNotNull(customers.deletedAt)));
    await tx.insert(leadTrashEvents).values(
      ids.map((customerId) => ({
        id: id("ltr"), customerId, action: "restored", reason: null, actorId: ctx.user.id, actorName: ctx.user.name, createdAt: now,
      })),
    );
    await tx.insert(auditLog).values(
      inTrash.map((c) => ({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        action: "lead.restored",
        entityType: "customer",
        entityId: c.id,
        beforeState: { deletedAt: c.deletedAt, reason: c.deletedReason } as never,
      })),
    );
    await leadsReturnedToHandsets(tx, ids);
  });

  return ok(
    { restored: ids.length },
    ids.length === 1 ? `${inTrash[0].name} restored to the book` : `${ids.length} leads restored to the book`,
  );
}

/* ---------------------------------------------------------------- the list */

export type TrashSort = "deleted_desc" | "deleted_asc" | "name_asc" | "created_desc";

export type TrashFilters = {
  q?: string;
  /** Who deleted it — a user id. */
  deletedBy?: string;
  /** Deleted on or after / on or before, business dates (YYYY-MM-DD). */
  from?: string;
  to?: string;
  sort?: TrashSort;
  page?: number;
  perPage?: number;
};

export type TrashRow = {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  city: string | null;
  ownerName: string | null;
  leadStage: string | null;
  leadSalesType: string | null;
  createdAt: string;
  deletedAt: string;
  deletedByName: string | null;
  reason: string | null;
  /** How much history comes back with it — the reason restoring beats re-entering. */
  calls: number;
  /** Times it has been deleted before this one. */
  previousTrashings: number;
};

export const TRASH_PER_PAGE_OPTIONS = [25, 50, 100] as const;

/** The trash, newest first, filtered and paged in the database. Admin only. */
export async function listTrash(f: TrashFilters): Promise<{
  rows: TrashRow[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
  /** Everybody who has deleted something still in the trash, for the filter. */
  deleters: Array<{ id: string; name: string; count: number }>;
}> {
  await requireCapability("lead.restore");
  const perPage = (TRASH_PER_PAGE_OPTIONS as readonly number[]).includes(f.perPage ?? 0) ? f.perPage! : 25;
  const q = f.q?.trim().replace(/[%_]/g, "").slice(0, 100) ?? "";
  const like = `%${q}%`;
  const digits = q.replace(/\D/g, "");
  const date = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const from = date(f.from);
  const to = date(f.to);

  const where = sql`
    c.deleted_at is not null
    ${q
      ? sql`and (c.name ilike ${like} or c.contact_person ilike ${like} or c.city ilike ${like}
                 or c.deleted_reason ilike ${like}
                 ${digits.length >= 4 ? sql`or regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like ${"%" + digits + "%"}` : sql``})`
      : sql``}
    ${f.deletedBy ? sql`and c.deleted_by_id = ${f.deletedBy}` : sql``}
    ${from ? sql`and c.deleted_at >= (${from}::date)::timestamp at time zone ${ZONE}` : sql``}
    ${to ? sql`and c.deleted_at < (${to}::date + 1)::timestamp at time zone ${ZONE}` : sql``}
  `;
  const order =
    f.sort === "deleted_asc"
      ? sql`c.deleted_at asc, c.id`
      : f.sort === "name_asc"
        ? sql`lower(c.name) asc, c.id`
        : f.sort === "created_desc"
          ? sql`c.created_at desc, c.id`
          : sql`c.deleted_at desc, c.id`;

  const [[{ n }], deleters] = await Promise.all([
    db.execute<{ n: number }>(sql`select count(*)::int as n from customers c where ${where}`),
    db.execute<{ id: string; name: string; count: number }>(sql`
      select c.deleted_by_id as id, max(c.deleted_by_name) as name, count(*)::int as count
        from customers c where c.deleted_at is not null and c.deleted_by_id is not null
       group by c.deleted_by_id order by 3 desc
    `),
  ]);
  const total = Number(n);
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, Math.floor(f.page ?? 1)), pageCount);

  const rows = await db.execute<{
    id: string; name: string; contact_person: string | null; phone: string | null; city: string | null;
    owner_name: string | null; lead_stage: string | null; lead_sales_type: string | null;
    created_at: unknown; deleted_at: unknown; deleted_by_name: string | null; deleted_reason: string | null;
    calls: number; previous: number;
  }>(sql`
    select c.id, c.name, c.contact_person, c.phone, c.city,
           (select u.name from users u where u.id = c.owner_id) as owner_name,
           c.lead_stage::text as lead_stage, c.lead_sales_type::text as lead_sales_type,
           c.created_at, c.deleted_at, c.deleted_by_name, c.deleted_reason,
           (select count(*)::int from calls k where k.customer_id = c.id) as calls,
           (select count(*)::int from lead_trash_events e where e.customer_id = c.id and e.action = 'trashed') - 1 as previous
      from customers c
     where ${where}
     order by ${order}
     limit ${perPage} offset ${(page - 1) * perPage}
  `);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      contactPerson: r.contact_person,
      phone: r.phone,
      city: r.city,
      ownerName: r.owner_name,
      leadStage: r.lead_stage,
      leadSalesType: r.lead_sales_type,
      createdAt: iso(r.created_at)!,
      deletedAt: iso(r.deleted_at)!,
      deletedByName: r.deleted_by_name,
      reason: r.deleted_reason,
      calls: Number(r.calls),
      previousTrashings: Math.max(0, Number(r.previous)),
    })),
    total,
    page,
    perPage,
    pageCount,
    deleters: deleters.map((d) => ({ id: d.id, name: d.name ?? "—", count: Number(d.count) })),
  };
}

/** Every move of one lead in and out of the trash, newest first. Admin only. */
export async function trashHistory(customerId: string) {
  await requireCapability("lead.restore");
  return db
    .select()
    .from(leadTrashEvents)
    .where(eq(leadTrashEvents.customerId, customerId))
    .orderBy(sql`${leadTrashEvents.createdAt} desc`);
}
