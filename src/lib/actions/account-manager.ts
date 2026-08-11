"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  customerAmChanges,
  customers,
  notifications,
  users,
} from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { err, okVoid, fromThrown, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Changing who an account answers to.
 *
 * Every account has two account managers and they move independently: SALES is
 * who sells to them and whose book the account is in, BACK OFFICE is who does
 * the dispatch, billing and paperwork. A salesperson resigning says nothing
 * about who raises the invoices, so the two are asked separately and either or
 * both can be set in one action.
 *
 * WHY IT IS ACCOUNTS' AND ADMIN'S, AND NOT A MANAGER'S. Whose book an account
 * is in decides who is credited for its orders and whose targets it counts
 * toward, so a manager reassigning accounts is a manager moving numbers
 * between their own people, including themselves. That is the conflict
 * `order.approve` already exists to avoid, one level up — there the person
 * chasing the target must not sign off the orders that hit it; here they must
 * not choose which accounts feed it. Checked server-side in this file, not by
 * hiding the button, because a hidden control is not a permission.
 *
 * WHY A REASON IS MANDATORY. The question anybody asks weeks later is not
 * "who owns this account" — the row answers that — it is "why did it move, and
 * what else moved with it". When a salesperson leaves, whoever picks up the
 * book needs the list. So the reason is a coded column in
 * `customer_am_changes` rather than prose in an audit blob, and it can be
 * grouped by.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const schema = z.object({
  customerIds: z.array(z.string().min(1)).min(1),
  /**
   * `null` means UNASSIGN, and is different from omitting the key, which means
   * leave this manager alone. Collapsing the two would make "clear the back
   * office manager" unexpressible, and the sheet leaves plenty of accounts
   * with nobody in that seat.
   */
  salesAmId: z.string().min(1).nullable().optional(),
  backOfficeAmId: z.string().min(1).nullable().optional(),
  reasonCode: z.string().min(1),
  note: z.string().trim().max(500).optional(),
});

export type UpdateAccountManagersInput = z.input<typeof schema>;

export async function updateAccountManagers(
  raw: UpdateAccountManagersInput,
): Promise<Result> {
  try {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(issue.message, "validation", [
        { field: issue.path.join("."), message: issue.message },
      ]);
    }
    const input = parsed.data;

    const ctx = await requireCapability("customer.reassign");
    const config = await getConfig();

    const changingSales = input.salesAmId !== undefined;
    const changingBackOffice = input.backOfficeAmId !== undefined;
    if (!changingSales && !changingBackOffice) {
      return err("Pick at least one account manager to change.", "validation");
    }

    // The reason list is a manager's to edit, so it is validated against the
    // stored list rather than an enum. An unknown code is refused instead of
    // stored, or the history grows values nothing can label.
    const reasons = config["people.amChangeReasons"] as string[];
    if (!reasons.includes(input.reasonCode)) {
      return err("That is not a reason we record.", "validation", [
        { field: "reasonCode", message: "Pick one of the offered reasons." },
      ]);
    }
    if (/^other$/i.test(input.reasonCode) && !input.note?.trim()) {
      return err("Say what the reason is.", "validation", [
        { field: "note", message: "A note is required when the reason is Other." },
      ]);
    }

    // Both targets must be real accounts. `sales_am_id` can only hold a `users`
    // row — a name the sheet carries with no login cannot be given a book,
    // which is the whole reason `salesPersonName` exists beside it.
    const targetIds = [input.salesAmId, input.backOfficeAmId].filter(
      (v): v is string => typeof v === "string",
    );
    const targets = targetIds.length
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, targetIds))
      : [];
    const nameById = new Map(targets.map((u) => [u.id, u.name]));
    for (const wanted of targetIds) {
      if (!nameById.has(wanted)) {
        return err("That person no longer has an account.", "validation");
      }
    }

    const rows = await db
      .select({
        id: customers.id,
        name: customers.name,
        kind: customers.kind,
        ownerId: customers.ownerId,
        salesAmId: customers.salesAmId,
        salesPersonName: customers.salesPersonName,
        backOfficeAmId: customers.backOfficeAmId,
        backOfficeName: customers.backOfficeName,
      })
      .from(customers)
      .where(inArray(customers.id, input.customerIds));

    if (!rows.length) return err("Those customers no longer exist.", "not_found");

    /*
     * Who the account answers to TODAY, which is not one column.
     * `ASSIGNED_TO_SQL` reads `owner_id` for a lead and `sales_am_id` for a
     * customer, so the sales manager has to be read — and written — from the
     * matching one. Writing only `sales_am_id` leaves every lead exactly where
     * it was while the screen reports it moved.
     */
    const salesIdOf = (r: (typeof rows)[number]) =>
      r.kind === "lead" ? r.ownerId : (r.salesAmId ?? r.ownerId);

    const now = new Date();
    const history: (typeof customerAmChanges.$inferInsert)[] = [];
    const audits: (typeof auditLog.$inferInsert)[] = [];
    /** Per person, what moved to or from them — one notification, not forty. */
    const gained = new Map<string, number>();
    const lost = new Map<string, number>();
    let touched = 0;

    await db.transaction(async (tx) => {
      for (const row of rows) {
        const values: Partial<typeof customers.$inferInsert> = {};
        let changed = false;

        if (changingSales) {
          const from = salesIdOf(row);
          const to = input.salesAmId ?? null;
          if (from !== to) {
            changed = true;
            // A lead answers to its owner; a customer to its sales AM. Both
            // are written on a customer so the fallback in `ASSIGNED_TO_SQL`
            // can never resolve back to a stale owner.
            if (row.kind === "lead") values.ownerId = to;
            else values.salesAmId = to;
            // The mirror moves with the id, or the screens keep showing the
            // sheet's name and the reassignment looks like it failed.
            values.salesPersonName = to ? (nameById.get(to) ?? null) : null;
            history.push({
              id: id("amc"),
              customerId: row.id,
              role: "sales",
              fromUserId: from,
              fromName: row.salesPersonName,
              toUserId: to,
              toName: to ? (nameById.get(to) ?? null) : null,
              reasonCode: input.reasonCode,
              note: input.note?.trim() || null,
              changedById: ctx.user.id,
              changedAt: now,
            });
            if (to) gained.set(to, (gained.get(to) ?? 0) + 1);
            if (from) lost.set(from, (lost.get(from) ?? 0) + 1);
          }
        }

        if (changingBackOffice) {
          const from = row.backOfficeAmId;
          const to = input.backOfficeAmId ?? null;
          if (from !== to) {
            changed = true;
            values.backOfficeAmId = to;
            values.backOfficeName = to ? (nameById.get(to) ?? null) : null;
            history.push({
              id: id("amc"),
              customerId: row.id,
              role: "back_office",
              fromUserId: from,
              fromName: row.backOfficeName,
              toUserId: to,
              toName: to ? (nameById.get(to) ?? null) : null,
              reasonCode: input.reasonCode,
              note: input.note?.trim() || null,
              changedById: ctx.user.id,
              changedAt: now,
            });
            if (to) gained.set(to, (gained.get(to) ?? 0) + 1);
            if (from) lost.set(from, (lost.get(from) ?? 0) + 1);
          }
        }

        // A no-op writes nothing at all: no row, no history, no notification.
        // Selecting forty accounts to move the six that are not already on the
        // new manager must not tell them they gained forty.
        if (!changed) continue;
        touched++;

        /*
         * The mark that stops the sheet restating the old answer. Set on every
         * change and never by the projection — `recomputeSalesPeople()` skips
         * a decided account, name included, and `--reassign` leaves it alone.
         */
        values.amDecidedAt = now;
        values.updatedAt = now;
        await tx.update(customers).set(values).where(eq(customers.id, row.id));

        audits.push({
          id: id("aud"),
          actorId: ctx.user.id,
          action: "customer.reassign",
          entityType: "customer",
          entityId: row.id,
          beforeState: {
            salesAmId: salesIdOf(row),
            salesPersonName: row.salesPersonName,
            backOfficeAmId: row.backOfficeAmId,
            backOfficeName: row.backOfficeName,
          } as never,
          afterState: {
            ...values,
            reasonCode: input.reasonCode,
            note: input.note?.trim() || null,
          } as never,
        });
      }

      if (history.length) await tx.insert(customerAmChanges).values(history);
      if (audits.length) await tx.insert(auditLog).values(audits);
    });

    if (!touched) {
      return okVoid("Nothing to change — they are already assigned that way");
    }

    /*
     * Telling the new account manager is the point, not a courtesy: work has
     * moved onto their queue without them asking, and the first they would
     * otherwise know is a list that grew overnight. The person who lost the
     * accounts is told for the same reason in reverse — a book that shrinks
     * silently reads as a bug in the queue.
     */
    const notes: (typeof notifications.$inferInsert)[] = [];
    const plural = (n: number) => `${n} account${n === 1 ? "" : "s"}`;
    for (const [userId, count] of gained) {
      notes.push({
        id: id("ntf"),
        userId,
        title: "Accounts assigned to you",
        body: `${ctx.user.name} moved ${plural(count)} to you — ${input.reasonCode}${input.note?.trim() ? `: ${input.note.trim()}` : ""}`,
        kind: "info",
        href: "/crm/customers",
      });
    }
    for (const [userId, count] of lost) {
      if (gained.has(userId)) continue; // net-unchanged: do not tell them twice
      notes.push({
        id: id("ntf"),
        userId,
        title: "Accounts moved from you",
        body: `${ctx.user.name} moved ${plural(count)} to somebody else — ${input.reasonCode}`,
        kind: "info",
        href: "/crm/customers",
      });
    }
    if (notes.length) await db.insert(notifications).values(notes);

    try {
      revalidatePath("/crm/customers");
      revalidatePath("/accounts/customers");
      revalidatePath("/crm/customers/[id]", "page");
    } catch {
      /* no request context — nothing cached, nothing to invalidate */
    }

    return okVoid(`Account manager updated on ${plural(touched)}`);
  } catch (e) {
    return fromThrown(e);
  }
}
