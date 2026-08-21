"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  customerAmChanges,
  customers,
  employees,
  notifications,
  users,
} from "@/db/schema";
import { requireCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { customerFilterClause } from "@/lib/queries";
import { err, okVoid, fromThrown, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Who the salesperson answers to.
 *
 * A THIRD SEAT, and its own action rather than a third branch of
 * `updateAccountManagers`, because the two are not the same decision and are
 * not held by the same people. Sales and back office are `customer.reassign`,
 * which is deliberately the narrowest capability in the app: whose book an
 * account is in decides who is credited for its orders and whose targets it
 * counts toward, so a manager moving it is a manager moving numbers between
 * their own people. The sales MANAGER seat drives nothing — no queue, no
 * scope, no target, no collections list — so that conflict does not exist, and
 * `customer.assignSalesManager` is a manager's and an admin's.
 *
 * Folding it into the other action would have meant one function guarded by
 * one capability doing two jobs with two answers about who may do them, and
 * the generous answer always wins in the end.
 *
 * WHY IT TAKES FILTERS AS WELL AS IDS. The question this seat exists to answer
 * is asked hardest on the day somebody leaves, and the answer is "everything
 * Rahul had" — a hundred and forty-seven accounts here, which is not a thing
 * anybody tickets one page of twenty-five at a time. A filtered transfer runs
 * `customerFilterClause`, the SAME clause the list ran to draw the screen the
 * person is looking at, so what moves is what they were shown. Re-deriving the
 * filters here would be a second reading of "which customers", and a bulk
 * action that moves a set nobody reviewed is the worst thing on this screen.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * How many rows go into one statement.
 *
 * A whole-book transfer is eleven hundred accounts and a single `in (...)` of
 * that many parameters is a query nobody wants to read in a slow log. The
 * whole thing is still ONE transaction — chunking is about statement size, not
 * about doing half a transfer.
 */
const CHUNK = 500;

const chunked = <T,>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

/**
 * What was left alone, said in the same breath as what moved.
 *
 * A count smaller than the one on the screen, with nothing explaining the
 * difference, reads as a transfer that half failed.
 */
const leadNote = (leads: number) =>
  leads
    ? ` · ${leads} lead${leads === 1 ? "" : "s"} left alone — a lead answers to its owner`
    : "";

const schema = z.object({
  /**
   * WHICH accounts. Ids for a tick-list, filters for "everything under X".
   *
   * They are a union rather than two optional fields because exactly one of
   * them is the answer, and a request carrying both would leave the server
   * choosing which one the person meant.
   */
  scope: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ids"),
      customerIds: z.array(z.string().min(1)).min(1),
    }),
    z.object({
      kind: z.literal("filters"),
      filters: z
        .object({
          query: z.string().optional(),
          status: z.string().optional(),
          salesAm: z.string().optional(),
          salesManager: z.string().optional(),
          backOfficeAm: z.string().optional(),
        })
        .default({}),
    }),
  ]),
  /**
   * WHO it becomes: an account, somebody on the HRMS master, or nobody.
   *
   * The same union the back office seat takes, and for the same reason —
   * several of the people running a sales line here have never signed in, and
   * refusing them would mean the true answer could not be recorded at all.
   * Sales is the seat that has no such union, because it decides whose calling
   * queue an account lands in and a name cannot be given a queue.
   *
   * An employee arrives as an ID and the name is read from the database here.
   * Taking the name off the request would let a caller write any string they
   * liked into a column every screen displays.
   */
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
    z.object({ kind: z.literal("employee"), employeeId: z.string().min(1) }),
    z.object({ kind: z.literal("none") }),
  ]),
  /**
   * Why, as a code from `people.amChangeReasons`.
   *
   * The same requirement the other two seats carry, and it earns its place the
   * same way: the question anybody asks weeks later is not who holds this
   * account — the row answers that — it is why it moved and what else moved
   * with it. A coded column can be grouped by; a sentence in an audit blob
   * can only be grepped.
   */
  reasonCode: z.string().min(1),
  note: z.string().trim().max(500).optional(),
  /**
   * What the caller was told it would move, and a refusal if that has changed.
   *
   * A filtered transfer is reviewed as a COUNT — "move all 147" — and the
   * screen that showed the count is not the transaction that does the move.
   * Between the two somebody can log a call, an import can land, a filter's
   * meaning can shift underneath. Sending the number back means a transfer
   * that would touch a different set is refused rather than silently made
   * larger, which on this action is the difference between moving a book and
   * moving the book plus everything that arrived while you were reading.
   *
   * Optional, because a tick-list has already named its rows one by one.
   */
  expectedCount: z.number().int().nonnegative().optional(),
});

export type AssignSalesManagerInput = z.input<typeof schema>;

export async function assignSalesManager(
  raw: AssignSalesManagerInput,
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

    const ctx = await requireCapability("customer.assignSalesManager");
    const config = await getConfig();

    /*
     * The reason list is a manager's to edit, so it is checked against the
     * stored list rather than an enum. An unknown code is refused instead of
     * stored, or the history grows values nothing can label.
     */
    const reasons = config["people.amChangeReasons"] as string[];
    if (!reasons.includes(input.reasonCode)) {
      return err("That is not a reason we record for a manager change.", "validation", [
        { field: "reasonCode", message: "Pick a reason from the list." },
      ]);
    }
    if (/^other$/i.test(input.reasonCode) && !input.note?.trim()) {
      return err("A note is required when the reason is Other.", "validation", [
        { field: "note", message: "Say what happened." },
      ]);
    }

    /* --- who it becomes ------------------------------------------------- */

    let toUserId: string | null = null;
    let toName: string | null = null;

    if (input.target.kind === "user") {
      const [u] = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.id, input.target.userId), eq(users.active, true)))
        .limit(1);
      // Active as well as present: an account switched off between the picker
      // rendering and the save landing belongs to a leaver, and handing them a
      // book is the thing this screen exists to undo.
      if (!u) return err("That person no longer has an active account.", "validation");
      toUserId = u.id;
      toName = u.name;
    } else if (input.target.kind === "employee") {
      const [staff] = await db
        .select({ name: employees.name })
        .from(employees)
        .where(
          and(
            eq(employees.id, input.target.employeeId),
            eq(employees.status, "active"),
          ),
        )
        .limit(1);
      if (!staff) {
        return err(
          "That employee is no longer on the current staff list.",
          "validation",
        );
      }
      toName = staff.name;
    }

    /* --- which accounts ------------------------------------------------- */

    const where =
      input.scope.kind === "ids"
        ? // Scoped as well as named. A tick-list comes from a page the reader
          // was shown, so this changes nothing in practice — and it means a
          // hand-built request cannot reach past what its author can see.
          and(
            await customerFilterClause({}),
            inArray(customers.id, input.scope.customerIds),
          )
        : await customerFilterClause(input.scope.filters);

    const rows = await db
      .select({
        id: customers.id,
        name: customers.name,
        kind: customers.kind,
        salesManagerId: customers.salesManagerId,
        salesManagerPersonName: customers.salesManagerPersonName,
      })
      .from(customers)
      .where(where);

    if (!rows.length) {
      return err(
        input.scope.kind === "ids"
          ? "Those customers no longer exist."
          : "Nothing matches those filters.",
        "not_found",
      );
    }

    if (
      input.expectedCount !== undefined &&
      input.expectedCount !== rows.length
    ) {
      return err(
        `This would now move ${rows.length} accounts, not the ${input.expectedCount} you reviewed. Open the list again and check what changed.`,
        "conflict",
      );
    }

    /*
     * A LEAD has no seat for this to sit above.
     *
     * The sales manager is who the SALESPERSON answers to, and a lead has no
     * salesperson — it has an owner, which is a different column and a
     * different fact. That is why the list draws no sales manager line on a
     * lead and the record page names none: writing one would store something
     * no screen can show, which is the state that ends with somebody insisting
     * they set it and nobody able to find it.
     *
     * They are counted and said out loud rather than dropped on the floor. A
     * filtered transfer over a mixed book is the ordinary case — "everything
     * Rahul had" catches his prospects too — and a message that reported a
     * smaller number than the screen promised, with no explanation, reads as a
     * transfer that half failed.
     */
    const leads = rows.filter((r) => r.kind === "lead").length;
    const eligible = rows.filter((r) => r.kind !== "lead");

    if (!eligible.length) {
      return err(
        leads
          ? "Those are all leads. A lead answers to its owner and has no salesperson for a sales manager to sit above."
          : "Nothing matches those filters.",
        "validation",
      );
    }

    /*
     * A no-op writes nothing at all — no column, no history row, no
     * notification. Transferring a hundred and forty-seven accounts to Sunita
     * when nine of them were already hers must not tell her she gained a
     * hundred and forty-seven.
     *
     * The ID decides while there is one; the NAME decides where both sides are
     * name-only, because employee-to-employee is null → null on the id and a
     * real change of person.
     */
    const moving = eligible.filter((r) =>
      r.salesManagerId !== null || toUserId !== null
        ? r.salesManagerId !== toUserId
        : (r.salesManagerPersonName ?? null) !== toName,
    );

    if (!moving.length) {
      return okVoid(
        `Nothing to change — they already have that sales manager${leadNote(leads)}`,
      );
    }

    const now = new Date();
    const lost = new Map<string, number>();

    await db.transaction(async (tx) => {
      for (const batch of chunked(moving)) {
        await tx
          .update(customers)
          .set({
            salesManagerId: toUserId,
            salesManagerPersonName: toName,
            updatedAt: now,
            updatedById: ctx.user.id,
          })
          .where(
            inArray(
              customers.id,
              batch.map((r) => r.id),
            ),
          );

        /*
         * No `amDecidedAt`. That mark exists to stop the sheet restating the
         * sales and back office seats it keeps re-reading; the customer master
         * carries no sales manager at all, so there is nothing to hold off —
         * and stamping it here would silently freeze the OTHER two seats
         * against a sync, which is a consequence nobody asked for by changing
         * a line manager.
         */
        await tx.insert(customerAmChanges).values(
          batch.map((r) => ({
            id: id("amc"),
            customerId: r.id,
            role: "sales_manager" as const,
            fromUserId: r.salesManagerId,
            fromName: r.salesManagerPersonName,
            toUserId,
            toName,
            reasonCode: input.reasonCode,
            note: input.note?.trim() || null,
            changedById: ctx.user.id,
            changedAt: now,
          })),
        );

        for (const r of batch) {
          if (r.salesManagerId) {
            lost.set(r.salesManagerId, (lost.get(r.salesManagerId) ?? 0) + 1);
          }
        }
      }

      /*
       * ONE audit row for the action, not one per account.
       *
       * `customer_am_changes` already holds the per-account record and holds
       * it better — from, to, reason, note, who and when, indexed by the
       * person it moved away from. A second per-account copy in `audit_log`
       * would add eleven hundred rows a transfer and answer nothing the
       * history does not. What the audit is for here is the ACT: somebody
       * moved a book, on these filters, this many accounts wide.
       */
      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        action: "customer.assignSalesManager",
        entityType: "customer",
        // The act has no single customer, and naming one of them would be a
        // lie about which. The count is the entity here.
        entityId: `${moving.length} accounts`,
        beforeState: {
          scope: input.scope,
          matched: rows.length,
        } as never,
        afterState: {
          salesManagerId: toUserId,
          salesManagerPersonName: toName,
          moved: moving.length,
          reasonCode: input.reasonCode,
          note: input.note?.trim() || null,
        } as never,
      });
    });

    /*
     * Both sides are told, and the new manager especially: a book has grown
     * under them without their asking, and the first they would otherwise know
     * is a list that is longer than it was. One notification per person per
     * action, never one per account.
     *
     * The gaining side is one person here — unlike the two-seat action, where
     * a change can hand accounts to several people at once — so it is a single
     * row rather than a map.
     */
    const notes: (typeof notifications.$inferInsert)[] = [];
    const plural = (n: number) => `${n} account${n === 1 ? "" : "s"}`;
    const why = `${input.reasonCode}${input.note?.trim() ? `: ${input.note.trim()}` : ""}`;

    if (toUserId) {
      notes.push({
        id: id("ntf"),
        userId: toUserId,
        title: "Accounts now report to you",
        body: `${ctx.user.name} made you the sales manager on ${plural(moving.length)} — ${why}`,
        kind: "info",
        href: "/crm/customers",
      });
    }
    for (const [userId, count] of lost) {
      // Net-unchanged: do not tell somebody twice about accounts that did not
      // actually leave them.
      if (userId === toUserId) continue;
      notes.push({
        id: id("ntf"),
        userId,
        title: "Accounts no longer report to you",
        body: `${ctx.user.name} moved ${plural(count)} to ${toName ?? "nobody"} — ${input.reasonCode}`,
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

    return okVoid(
      (toName
        ? `Sales manager set to ${toName} on ${plural(moving.length)}`
        : `Sales manager cleared on ${plural(moving.length)}`) + leadNote(leads),
    );
  } catch (e) {
    return fromThrown(e);
  }
}
