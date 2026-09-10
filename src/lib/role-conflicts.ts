/* ---------------------------------------------------------------------------
 * WHERE TWO HATS SHOULD NOT MEET.
 *
 * PURE and client-safe, like the complaint labels and the account types beside
 * it, because both ends need it: `access-control.ts` is `server-only` and
 * answers with these when somebody asks what a person holds, and the access
 * dialog — a client component — has to say it on the review page BEFORE
 * anything is written. A second copy typed into the screen would drift, and
 * the half that drifts is always the one somebody reads.
 *
 * THEY ARE NOT REFUSALS. The capability matrix keeps `order.approve` away from
 * managers on purpose — the person chasing a target must not sign off the
 * orders that hit it — but at nine people the same person does have to do
 * both, and a system that refuses it is defeated in a minute by granting admin
 * instead, which grants far more and records no reason. So the combination is
 * allowed, said in words where it is granted, and every action taken under it
 * records which hat authorised it.
 *
 * A CONFLICT IS BETWEEN TWO HATS, AND A HAT IS AN APP AND A LEVEL. It used to
 * be between two roles, which worked only while two of the four role values
 * were secretly app names: "telecaller and accounts" meant "the calling book
 * and the ledger desk" and read as a sentence about roles. With roles reduced
 * to levels that sentence cannot be written any more — "associate and
 * associate" says nothing — so the pair names the apps, and the level goes
 * beside it where the level is what makes the pair dangerous.
 * ------------------------------------------------------------------------- */

/** An app id, kept as a bare string so this file imports nothing. */
export type ConflictApp = string;

/**
 * One side of a conflict: an app, and optionally the level that makes it bite.
 *
 * `level` omitted means any level of that app. It is named on the Accounts
 * side of every rule below because the decisions that clash — approving an
 * order, confirming a payment, setting a target — are the Accounts MANAGER's,
 * and an Accounts associate who only records and reads clashes with nothing.
 */
export type ConflictHat = { app: ConflictApp; level?: "associate" | "manager" };

export type RoleConflict = {
  hats: [ConflictHat, ConflictHat];
  /** What the pair lets somebody do that the matrix was written to prevent. */
  sentence: string;
};

export const ROLE_CONFLICTS: RoleConflict[] = [
  {
    hats: [{ app: "crm", level: "manager" }, { app: "accounts", level: "manager" }],
    sentence:
      "Approves orders and confirms payments, while carrying a sales target and setting the team's. The person chasing a target should not sign off the orders that hit it.",
  },
  {
    hats: [{ app: "crm" }, { app: "accounts", level: "manager" }],
    sentence:
      "Records payments in the CRM and confirms them in Accounts, so one person can report that money arrived and then be the one who says it did.",
  },
  {
    hats: [{ app: "crm" }, { app: "accounts", level: "manager" }],
    sentence:
      "Carries a sales target in the CRM and sets targets in Accounts, so one person could set their own number and then be measured against it.",
  },
  {
    /*
     * The handset half of the one above. A field salesman records payments at
     * a counter exactly as a telecaller records them on a call, and the same
     * person confirming them at the desk is the same problem — it was missing
     * only because `field` had no role of its own to name.
     */
    hats: [{ app: "field" }, { app: "accounts", level: "manager" }],
    sentence:
      "Collects payments in the field and confirms them in Accounts, so one person can bring money in and then be the one who says it arrived.",
  },
];

/** What somebody holds, in the shape this file compares against. */
export type HeldHat = { app: string | null; role: string };

function matches(hat: ConflictHat, held: readonly HeldHat[]): boolean {
  return held.some(
    (h) => h.app === hat.app && (!hat.level || h.role === hat.level),
  );
}

/** The conflicts a set of hats produces. Empty for almost everybody. */
export function conflictsFor(held: readonly HeldHat[]): RoleConflict[] {
  /* An admin holds everything everywhere, so every pair below is true of
     them. Saying so on the review page would put four warnings on every
     administrator and teach people to scroll past all of them — the thing to
     weigh when granting admin is that it is admin, which the screen already
     says in its own words. */
  if (held.some((h) => h.role === "admin")) return [];

  return ROLE_CONFLICTS.filter(
    (c) => matches(c.hats[0], held) && matches(c.hats[1], held),
  );
}
