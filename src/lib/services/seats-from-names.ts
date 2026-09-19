import "server-only";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { customers, users } from "@/db/schema";
import { assignedUserId } from "@/lib/access-control";
import { applyAccountManagerChange } from "@/lib/services/account-manager-service";

/* ---------------------------------------------------------------------------
 * PUTTING THE SEAT BACK WHERE THE NAME SAYS IT SHOULD BE.
 *
 * A one-off remediation, and the shape of the damage is worth stating because
 * the same shape can be made again. An account carries a seat — `sales_am_id`,
 * which decides whose Call Log it is on and whose target its orders count
 * toward — and beside it the NAME of the person the team says sells to that
 * shop. The screens read the name; everything that moves money reads the id.
 * Nothing kept them in step, and `am_decided_at` — set by a change to ANY
 * seat — then froze whatever disagreement existed at that moment for good,
 * because the nightly pass skips a decided account.
 *
 * On this book that left fifty accounts displaying one person and belonging to
 * another. Twenty-one were one salesperson's: the reason recorded was
 * "Salesperson left", the back office seat moved, the book did not, and her
 * targets went on counting orders she was no longer selling.
 *
 * THE NAME ON THE RECORD IS THE ANSWER, and only that. Not the party sheet:
 * the team maintains these names in MahekOne for accounts it already holds,
 * and reaching back into the spreadsheet would overwrite a decision made here
 * with whatever the last sync happened to see. An account with no name is
 * therefore LEFT ALONE — a seat nobody has named is a question for a person,
 * not something to infer.
 *
 * It writes through `applyAccountManagerChange`, the same service the dialog
 * calls, so every move lands as a history row, an audit row, a timeline entry
 * and one notification per person. A script writing the columns itself would
 * be the unaudited second door, on exactly the change where a record of who
 * did it matters most.
 * ------------------------------------------------------------------------- */

export type SeatMove = {
  customerId: string;
  customerName: string;
  kind: string;
  /** The name on the record — what the team says. */
  wants: string;
  toUserId: string;
  /** Who holds the seat today, or null where nobody does. */
  fromName: string | null;
};

export type SeatPlan = {
  moves: SeatMove[];
  /** A name with no MahekOne account behind it: nothing to point a seat at. */
  unresolved: { name: string; accounts: number }[];
  /** Already correct — the name and the seat agree. */
  agree: number;
};

/**
 * What would move, and what would not. Reads only.
 *
 * An ACTIVE user, matched on the name exactly as stored apart from case and
 * surrounding space. A name matching two accounts is deliberately not guessed
 * at: it lands in `unresolved` for a person to answer.
 */
export async function planSeatsFromNames(
  /*
   * WHICH HALF, because they are two different decisions.
   *
   * On a CUSTOMER the seat moves revenue: the orders it carries stop counting
   * toward one person's target and start counting toward another's. On a LEAD
   * it moves a book and no money at all — and most of those leads sit on the
   * importer rather than on anybody who was ever given them, so it is less a
   * correction than an assignment that was never made. Running the money half
   * first is the order that lets somebody stop after it.
   */
  only: "customer" | "lead" | "all" = "all",
): Promise<SeatPlan> {
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      kind: customers.kind,
      ownerId: customers.ownerId,
      salesAmId: customers.salesAmId,
      amDecidedAt: customers.amDecidedAt,
      salesPersonName: customers.salesPersonName,
    })
    .from(customers)
    .where(isNotNull(customers.salesPersonName));

  const staff = await db
    .select({ id: users.id, name: users.name, active: users.active })
    .from(users);

  const byName = new Map<string, string[]>();
  for (const u of staff) {
    if (!u.active) continue;
    const key = u.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), u.id]);
  }
  const nameOf = new Map(staff.map((u) => [u.id, u.name]));

  const moves: SeatMove[] = [];
  const unresolved = new Map<string, number>();
  let agree = 0;

  for (const row of rows) {
    if (only !== "all" && (only === "lead") !== (row.kind === "lead")) continue;
    const wants = row.salesPersonName?.trim();
    if (!wants) continue;
    const matches = byName.get(wants.toLowerCase()) ?? [];
    if (matches.length !== 1) {
      unresolved.set(wants, (unresolved.get(wants) ?? 0) + 1);
      continue;
    }
    const toUserId = matches[0];
    const held = assignedUserId({
      kind: row.kind === "lead" ? "lead" : "customer",
      ownerId: row.ownerId,
      salesAmId: row.salesAmId,
      amDecidedAt: row.amDecidedAt,
    });
    if (held === toUserId) {
      agree += 1;
      continue;
    }
    moves.push({
      customerId: row.id,
      customerName: row.name,
      kind: row.kind,
      wants,
      toUserId,
      fromName: held ? (nameOf.get(held) ?? held) : null,
    });
  }

  return {
    moves,
    unresolved: [...unresolved].map(([name, accounts]) => ({ name, accounts })),
    agree,
  };
}

/**
 * Applies the plan, grouped by destination so each person is told once rather
 * than fifteen times.
 *
 * "Correcting a mistake" is the reason, because that is what this is. The code
 * has to be one the configured list carries or the service refuses it, which
 * is why it is not spelled some other way here.
 */
export async function applySeatsFromNames(
  actorEmail: string,
  only: "customer" | "lead" | "all" = "all",
  reasonCode = "Correcting a mistake",
): Promise<{ moved: number; people: number }> {
  const [actor] = await db
    .select({ id: users.id, name: users.name, role: users.role, active: users.active })
    .from(users)
    .where(eq(users.email, actorEmail))
    .limit(1);
  if (!actor) throw new Error(`No account for ${actorEmail}.`);
  if (!actor.active) throw new Error(`${actor.name}'s sign-in is disabled.`);
  /*
   * The capability is each door's own to ask, and this door demands an admin:
   * moving a seat moves revenue attribution, `customer.reassign` is
   * deliberately accounts' and admin's, and a script has no session to read
   * hats from.
   */
  if (actor.role !== "admin") {
    throw new Error(`${actor.name} is not an admin; reassignment is admin's.`);
  }

  const plan = await planSeatsFromNames(only);
  const byTarget = new Map<string, string[]>();
  for (const m of plan.moves) {
    byTarget.set(m.toUserId, [...(byTarget.get(m.toUserId) ?? []), m.customerId]);
  }

  let moved = 0;
  for (const [toUserId, customerIds] of byTarget) {
    const result = await applyAccountManagerChange(
      { customerIds, salesAmId: toUserId, sales: { reasonCode } },
      {
        userId: actor.id,
        name: actor.name,
        authorisedBy: "admin",
        /* No app is named: this is a job and not a screen, so
           `audit_log.actor_app` says null rather than claiming a console
           somebody was never standing in. */
        authorisedIn: null,
      },
    );
    if (!result.ok) throw new Error(`${toUserId}: ${result.error}`);
    moved += customerIds.length;
  }

  return { moved, people: byTarget.size };
}
