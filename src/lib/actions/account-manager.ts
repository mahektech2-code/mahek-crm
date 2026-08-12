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

/**
 * A reason belongs to a SEAT, not to the dialog.
 *
 * It used to be one code and one note for whatever moved, which reads fine
 * until both seats move at once — and both moving at once is the ordinary
 * case, because that is what happens when somebody leaves. "Salesperson left"
 * was then stamped on the back-office row too, and the history said the
 * dispatch clerk changed because a salesperson resigned. Two changes, two
 * reasons, two rows.
 */
const seatReason = z.object({
  reasonCode: z.string().min(1),
  note: z.string().trim().max(500).optional(),
});

const schema = z.object({
  customerIds: z.array(z.string().min(1)).min(1),
  /**
   * `null` means UNASSIGN, and is different from omitting the key, which means
   * leave this manager alone. Collapsing the two would make "clear the back
   * office manager" unexpressible, and the sheet leaves plenty of accounts
   * with nobody in that seat.
   */
  salesAmId: z.string().min(1).nullable().optional(),
  /**
   * The sales seat, where the person who sells has no login.
   *
   * Four of the biggest salespeople on this book are exactly that: Prakash
   * Vasudev Prasad (301 accounts), Rahul Richhariya (147), Bharat Singh (73)
   * and Sanjay Kumar Samantaray (25) are all current employees and none of
   * them has ever signed in. Refusing to record them meant the true answer
   * could not be written down at all, and the sheet's name stayed the only
   * place it existed.
   *
   * WHAT IT COSTS, and why the screen says so: `sales_am_id` is what
   * `ASSIGNED_TO_SQL` reads, so a customer whose sales seat holds a NAME is
   * on nobody's calling queue and nobody's collections list. That is the
   * honest state of an account whose salesperson cannot sign in — better said
   * out loud than hidden behind a login that belongs to somebody else.
   */
  salesEmployeeId: z.string().min(1).optional(),
  /**
   * The back office seat takes a PERSON, who may not have a login.
   *
   * `user` is an account; `employee` is somebody on the HRMS master, stored as
   * a name in `customers.backOfficeName` exactly as the sheet has always
   * stored them; `none` empties the seat. Sales has no such union on purpose —
   * it decides whose calling queue the account lands in, and a name with no
   * account cannot be given a queue.
   *
   * An employee arrives as an ID and the NAME is read from the database here.
   * Taking the name off the request would let a caller write any string they
   * liked into a column the screens display.
   */
  backOffice: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
      z.object({ kind: z.literal("employee"), employeeId: z.string().min(1) }),
      z.object({ kind: z.literal("none") }),
    ])
    .optional(),
  sales: seatReason.optional(),
  backOfficeReason: seatReason.optional(),
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

    const changingSales =
      input.salesAmId !== undefined || input.salesEmployeeId !== undefined;
    if (input.salesAmId && input.salesEmployeeId) {
      return err(
        "A sales manager is one person: an account or an employee, not both.",
        "validation",
      );
    }
    const changingBackOffice = input.backOffice !== undefined;
    if (!changingSales && !changingBackOffice) {
      return err("Pick at least one account manager to change.", "validation");
    }

    /*
     * A seat that is moving must say why. Checked per seat rather than once,
     * because the two are separate decisions with separate answers — and the
     * screen asks them separately, so an action that accepted one reason for
     * both would quietly let the interface and the record disagree.
     *
     * The reason list is a manager's to edit, so it is validated against the
     * stored list rather than an enum. An unknown code is refused instead of
     * stored, or the history grows values nothing can label.
     */
    const reasons = config["people.amChangeReasons"] as string[];
    const checkReason = (
      seat: { reasonCode: string; note?: string } | undefined,
      label: string,
      field: string,
    ): string | null => {
      if (!seat) return `Say why the ${label} account manager is changing.`;
      if (!reasons.includes(seat.reasonCode)) {
        return `That is not a reason we record for the ${label} account manager.`;
      }
      if (/^other$/i.test(seat.reasonCode) && !seat.note?.trim()) {
        return `A note is required when the ${label} reason is Other.`;
      }
      void field;
      return null;
    };
    if (changingSales) {
      const problem = checkReason(input.sales, "sales", "sales.reasonCode");
      if (problem) return err(problem, "validation");
    }
    if (changingBackOffice) {
      const problem = checkReason(
        input.backOfficeReason,
        "back office",
        "backOfficeReason.reasonCode",
      );
      if (problem) return err(problem, "validation");
    }

    /*
     * The sales target must be a real account. `sales_am_id` can only hold a
     * `users` row — a name the sheet carries with no login cannot be given a
     * book, which is the whole reason `salesPersonName` exists beside it.
     */
    const nameById = new Map<string, string>();
    const salesTargetId =
      typeof input.salesAmId === "string" ? input.salesAmId : null;
    const backOfficeUserId =
      input.backOffice?.kind === "user" ? input.backOffice.userId : null;
    const wantedUserIds = [salesTargetId, backOfficeUserId].filter(
      (v): v is string => typeof v === "string",
    );
    if (wantedUserIds.length) {
      const targets = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(inArray(users.id, wantedUserIds), eq(users.active, true)));
      for (const u of targets) nameById.set(u.id, u.name);
      for (const wanted of wantedUserIds) {
        if (!nameById.has(wanted)) {
          // Active as well as present: an account that has been switched off
          // between the picker rendering and the save landing is a leaver, and
          // handing them a book is what this screen exists to undo.
          return err("That person no longer has an active account.", "validation");
        }
      }
    }

    /*
     * An employee on the back office seat is resolved to a name HERE, from a
     * row that must still be current. The request carries an id and never the
     * name, so a caller cannot write arbitrary text into a column the screens
     * display, and a leaver cannot be assigned by an old browser tab.
     */
    let salesEmployeeName: string | null = null;
    if (input.salesEmployeeId) {
      const [staff] = await db
        .select({ name: employees.name })
        .from(employees)
        .where(
          and(eq(employees.id, input.salesEmployeeId), eq(employees.status, "active")),
        )
        .limit(1);
      if (!staff) {
        return err(
          "That employee is no longer on the current staff list.",
          "validation",
        );
      }
      salesEmployeeName = staff.name;
    }

    let backOfficeEmployeeName: string | null = null;
    if (input.backOffice?.kind === "employee") {
      const [staff] = await db
        .select({ name: employees.name })
        .from(employees)
        .where(
          and(
            eq(employees.id, input.backOffice.employeeId),
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
      backOfficeEmployeeName = staff.name;
    }

    /** What the back office seat becomes: an account, a name, or nobody. */
    const backOfficeTarget: { userId: string | null; name: string | null } =
      input.backOffice?.kind === "user"
        ? {
            userId: input.backOffice.userId,
            name: nameById.get(input.backOffice.userId) ?? null,
          }
        : input.backOffice?.kind === "employee"
          ? { userId: null, name: backOfficeEmployeeName }
          : { userId: null, name: null };

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
          // An employee holds the seat by NAME and takes no id with them.
          const to = salesEmployeeName ? null : (input.salesAmId ?? null);
          const toName = salesEmployeeName ?? (to ? (nameById.get(to) ?? null) : null);
          /*
           * The ID decides while there is one. Names only decide where both
           * sides are name-only — employee to employee is null → null on the
           * id and a real change to the person.
           *
           * Comparing names unconditionally made re-picking the account that
           * was already there read as a move, because the stored mirror can
           * be null while the account has a name. A no-op must write no
           * history and notify nobody.
           */
          if (from !== to || (to === null && (row.salesPersonName ?? null) !== toName)) {
            changed = true;
            // A lead answers to its owner; a customer to its sales AM. Both
            // are written on a customer so the fallback in `ASSIGNED_TO_SQL`
            // can never resolve back to a stale owner.
            if (row.kind === "lead") values.ownerId = to;
            else values.salesAmId = to;
            // The mirror moves with the id, or the screens keep showing the
            // sheet's name and the reassignment looks like it failed.
            values.salesPersonName = toName;
            history.push({
              id: id("amc"),
              customerId: row.id,
              role: "sales",
              fromUserId: from,
              fromName: row.salesPersonName,
              toUserId: to,
              toName,
              reasonCode: input.sales!.reasonCode,
              note: input.sales!.note?.trim() || null,
              changedById: ctx.user.id,
              changedAt: now,
            });
            if (to) gained.set(to, (gained.get(to) ?? 0) + 1);
            if (from) lost.set(from, (lost.get(from) ?? 0) + 1);
          }
        }

        if (changingBackOffice) {
          const from = row.backOfficeAmId;
          const to = backOfficeTarget.userId;
          /*
           * The seat can move without the ID moving: from an employee name to
           * a different employee name is null → null on the id and a real
           * change to the person. Comparing ids alone would report "nothing to
           * change" and write nothing, on a screen that had just been told
           * somebody new does the paperwork.
           */
          const fromName = row.backOfficeName;
          const toName = backOfficeTarget.name;
          if (from !== to || (to === null && (fromName ?? null) !== (toName ?? null))) {
            changed = true;
            values.backOfficeAmId = to;
            values.backOfficeName = toName;
            history.push({
              id: id("amc"),
              customerId: row.id,
              role: "back_office",
              fromUserId: from,
              fromName,
              toUserId: to,
              toName,
              reasonCode: input.backOfficeReason!.reasonCode,
              note: input.backOfficeReason!.note?.trim() || null,
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
            // Both reasons, each against the seat it explains.
            salesReason: changingSales ? input.sales : undefined,
            backOfficeReason: changingBackOffice ? input.backOfficeReason : undefined,
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
    /*
     * Which reason to tell somebody about. A person can gain accounts through
     * either seat, and the two now carry different reasons — so the message
     * names whichever seat actually moved, and both where both did, rather
     * than picking one and being wrong half the time.
     */
    const reasonSentence = [
      changingSales ? `sales: ${input.sales!.reasonCode}` : null,
      changingBackOffice
        ? `back office: ${input.backOfficeReason!.reasonCode}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const noteSentence = [input.sales?.note?.trim(), input.backOfficeReason?.note?.trim()]
      .filter(Boolean)
      .join(" · ");
    for (const [userId, count] of gained) {
      notes.push({
        id: id("ntf"),
        userId,
        title: "Accounts assigned to you",
        body: `${ctx.user.name} moved ${plural(count)} to you — ${reasonSentence}${noteSentence ? `: ${noteSentence}` : ""}`,
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
        body: `${ctx.user.name} moved ${plural(count)} to somebody else — ${reasonSentence}`,
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
