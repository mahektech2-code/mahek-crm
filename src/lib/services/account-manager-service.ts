import "server-only";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  customerAmChanges,
  customers,
  employees,
  notifications,
  users,
} from "@/db/schema";
import { assignedUserId } from "@/lib/access-control";
import type { AppId } from "@/lib/apps";
import { CRM_EVENT, writeTimelineEvents } from "@/lib/timeline";
import { getConfig } from "@/lib/config/store";
import { err, okVoid, type Result } from "@/lib/result";
import { notifyUsers } from "@/lib/notify";
import type { AccountManagerChange } from "@/lib/actions/account-manager";

/* ---------------------------------------------------------------------------
 * MOVING A SEAT, once, wherever the instruction comes from.
 *
 * This was the body of `updateAccountManagers` and it stays the only
 * implementation. What it gained is an ACTOR passed in rather than read from
 * the request: the server action resolves one from the session and a
 * remediation job resolves one from its `--actor` argument, and both write the
 * same five things — the seat, the name beside it, `customer_am_changes`, the
 * audit row and the timeline entry — under a person's name.
 *
 * A job that wrote those columns itself would be the second door this file's
 * own comments already warn about: "two doors to the same fact is how one of
 * them ends up unaudited". The only correct number of implementations is one,
 * and a bulk correction of a few hundred accounts is precisely the case where
 * an unaudited one would matter most.
 *
 * THE CAPABILITY IS NOT CHECKED HERE. It is checked by each door, because the
 * doors answer it differently: the action asks `requireCapability`, which
 * reads the signed-in person's hats; the job demands a named admin. A check
 * inside this function would have to guess which of those it was looking at.
 * ------------------------------------------------------------------------- */

/** Who is doing this, and under which hat — see `audit_log.actor_role`. */
export type ManagerChangeActor = {
  userId: string;
  /** Printed in the notification the two people receive. */
  name: string;
  authorisedBy: "associate" | "manager" | "admin" | null;
  authorisedIn: AppId | null;
};

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export async function applyAccountManagerChange(
  input: AccountManagerChange,
  actor: ManagerChangeActor,
): Promise<Result> {
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
        amDecidedAt: customers.amDecidedAt,
        salesPersonName: customers.salesPersonName,
        backOfficeAmId: customers.backOfficeAmId,
        backOfficeName: customers.backOfficeName,
      })
      .from(customers)
      .where(inArray(customers.id, input.customerIds));

    if (!rows.length) return err("Those customers no longer exist.", "not_found");

    /*
     * THE NAMES OF WHOEVER ALREADY HOLDS A SEAT, so a mirror can be put back in
     * step with an id this call is not moving. See `reconcile` below.
     */
    const heldIds = [
      ...new Set(
        rows
          .flatMap((r) => [r.salesAmId, r.ownerId, r.backOfficeAmId])
          .filter((v): v is string => typeof v === "string"),
      ),
    ].filter((id) => !nameById.has(id));
    if (heldIds.length) {
      const held = await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, heldIds));
      for (const u of held) nameById.set(u.id, u.name);
    }

    /*
     * Who the account answers to TODAY, which is not one column.
     * `ASSIGNED_TO_SQL` reads `owner_id` for a lead and `sales_am_id` for a
     * customer, so the sales manager has to be read — and written — from the
     * matching one. Writing only `sales_am_id` leaves every lead exactly where
     * it was while the screen reports it moved.
     */
    // Through `assignedUserId`, not a third copy of the rule beside the SQL one
    // and the engine one. A previously-decided account reads its sales seat
    // exactly as it stands, so re-opening the dialog on an account somebody
    // has already emptied shows "nobody" rather than the importer's name.
    const salesIdOf = (r: (typeof rows)[number]) =>
      assignedUserId({
        kind: r.kind === "lead" ? "lead" : "customer",
        ownerId: r.ownerId,
        salesAmId: r.salesAmId,
        amDecidedAt: r.amDecidedAt,
      });

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
              /*
               * WHO ACTUALLY HELD IT, not what the record was displaying.
               *
               * This was `row.salesPersonName` — the mirror — which is right
               * only while the mirror agrees with the seat. Where it did not,
               * the history row came out reading "Sanjay → Sanjay" on a move
               * that actually took the account off Heena: the ids were
               * correct, and the sentence somebody reads on the record was
               * not. The remediation of that very disagreement produced
               * thirty-five such rows before this was noticed.
               *
               * The mirror is still the fallback, because a seat held by a
               * NAME with no login has no user to read a name from — and
               * there, the mirror is the only answer there is.
               */
              fromName: (from ? (nameById.get(from) ?? null) : null) ?? row.salesPersonName,
              toUserId: to,
              toName,
              reasonCode: input.sales!.reasonCode,
              note: input.sales!.note?.trim() || null,
              changedById: actor.userId,
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
          /* The person who held it, falling back to the mirror where the
             seat was held by a name with no account — see the note on the
             sales row above. */
          const fromName =
            (from ? (nameById.get(from) ?? null) : null) ?? row.backOfficeName;
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
              changedById: actor.userId,
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
        /*
         * A NAME MAY NOT CONTRADICT THE ID BESIDE IT — and this is where the
         * contradiction used to be created.
         *
         * `salesPersonName` and `backOfficeName` are the sheet's own words,
         * and the screens read them FIRST, falling through to the linked
         * account only where the sheet is silent. That is right while the
         * sheet is still in charge. It stops being right the moment
         * `amDecidedAt` is stamped below, because from then on
         * `recomputeSalesPeople` skips this account entirely and nothing will
         * ever bring the two back into step.
         *
         * So a back-office-only change used to freeze a sales NAME against a
         * sales ID it disagreed with. On MAA PAINT that left every screen
         * showing "Sanjay Kumar Samantaray" while the Call Log, the
         * collections list and the target that counted its orders all belonged
         * to the person the account had supposedly been taken away from. It
         * was true of forty-two accounts, and nobody could have found it from
         * any one screen: each of them was reporting a column correctly.
         *
         * Reconciling is deliberately one-directional — the ID decides. Where
         * a seat is held by an ACCOUNT, the mirror becomes that account's
         * name. Where it is held by nobody, or by a name with no login (which
         * `salesEmployeeId` exists to record), the mirror is left exactly as
         * it stands: that name is then the only statement of who works the
         * account, and overwriting it would destroy the answer rather than
         * correct it.
         */
        const finalSalesId =
          row.kind === "lead"
            ? (values.ownerId !== undefined ? values.ownerId : row.ownerId)
            : (values.salesAmId !== undefined ? values.salesAmId : row.salesAmId);
        if (finalSalesId && values.salesPersonName === undefined) {
          const trueName = nameById.get(finalSalesId) ?? null;
          if (trueName && trueName !== row.salesPersonName) {
            values.salesPersonName = trueName;
          }
        }
        const finalBackOfficeId =
          values.backOfficeAmId !== undefined
            ? values.backOfficeAmId
            : row.backOfficeAmId;
        if (finalBackOfficeId && values.backOfficeName === undefined) {
          const trueName = nameById.get(finalBackOfficeId) ?? null;
          if (trueName && trueName !== row.backOfficeName) {
            values.backOfficeName = trueName;
          }
        }

        values.amDecidedAt = now;
        values.updatedAt = now;
        await tx.update(customers).set(values).where(eq(customers.id, row.id));

        audits.push({
          id: id("aud"),
          actorId: actor.userId,
      // Which hat allowed it — see `audit_log.actor_role`.
      actorRole: actor.authorisedBy,
        actorApp: actor.authorisedIn,
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

      /*
       * §R — an ownership change is a fact about the ACCOUNT, and the timeline
       * is the one place somebody reads an account's story before ringing it.
       * `customer_am_changes` already records the same move in far more detail
       * — from, to, reason code, both names — and stays the authority; this is
       * the one line that says it happened, in the stream beside the calls and
       * the visits it explains.
       *
       * In the transaction, like every other timeline write: an entry for a
       * reassignment that rolled back is a reassignment that never happened, on
       * a screen somebody believes.
       */
      await writeTimelineEvents(
        tx,
        history.map((h) => ({
          customerId: h.customerId,
          eventType: CRM_EVENT.ownerChange,
          sourceApp: "crm" as const,
          sourceRecordId: h.id,
          occurredAt: new Date(),
          actorUserId: actor.userId,
          summary: `${h.role === "back_office" ? "Back office" : "Salesperson"} changed${h.toName ? ` to ${h.toName}` : " — now unassigned"}${h.reasonCode ? ` (${h.reasonCode.replace(/_/g, " ")})` : ""}`,
        })),
      );
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
        body: `${actor.name} moved ${plural(count)} to you — ${reasonSentence}${noteSentence ? `: ${noteSentence}` : ""}`,
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
        body: `${actor.name} moved ${plural(count)} to somebody else — ${reasonSentence}`,
        kind: "info",
        href: "/crm/customers",
      });
    }
    if (notes.length) await notifyUsers(notes);

    try {
      revalidatePath("/crm/customers");
      revalidatePath("/accounts/customers");
      revalidatePath("/crm/customers/[id]", "page");
    } catch {
      /* no request context — nothing cached, nothing to invalidate */
    }

    return okVoid(`Account manager updated on ${plural(touched)}`);
}
