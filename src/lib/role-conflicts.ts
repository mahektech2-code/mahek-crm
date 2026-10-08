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
 * side because most of the decisions that clash — approving an order,
 * confirming a payment, setting a target — are the Accounts MANAGER's. Not
 * all: editing a price list is held at BOTH Accounts levels, so the associate
 * clashes with whoever quotes prices. A level names exactly that level, so the
 * associate rule and the manager rules do not double up on one person.
 */
export type ConflictHat = { app: ConflictApp; level?: "associate" | "manager" };

export type RoleConflict = {
  hats: [ConflictHat, ConflictHat];
  /** What the pair lets somebody do that the matrix was written to prevent. */
  sentence: string;
};

export const ROLE_CONFLICTS: RoleConflict[] = [
  /*
   * The CRM against the ledger desk. One rule where there used to be three: a
   * CRM manager who was also an Accounts manager drew all three on the review
   * page for one pair of grants, and three warnings about one decision is how
   * people learn to scroll past the box.
   */
  {
    hats: [{ app: "crm" }, { app: "accounts", level: "manager" }],
    sentence:
      "Works the calling book and decides at the ledger desk — can approve the orders that hit their own target, confirm the payments they recorded on a call, and set the targets they are measured against.",
  },
  {
    /*
     * The handset half. A field salesman collects money at a counter exactly
     * as a telecaller records it on a call.
     */
    hats: [{ app: "field" }, { app: "accounts", level: "manager" }],
    sentence:
      "Collects payments in the field and confirms them in Accounts, so one person can bring money in and then be the one who says it arrived.",
  },
  {
    /*
     * The Sales Dashboard was missing entirely: its manager runs the field
     * team's figures and decides their claims, and the Accounts manager writes
     * the expense policy and sets the targets those figures are judged by.
     */
    hats: [{ app: "sales" }, { app: "accounts", level: "manager" }],
    sentence:
      "Runs the field team and decides at the ledger desk — can set the team's targets, write the expense policy their claims are paid on, and approve the orders that hit those targets.",
  },
  {
    /*
     * THE PRICE DESK. `pricelist.manage` is held at BOTH levels of Accounts, so
     * an Accounts associate is not the harmless clerk this file once assumed.
     * The person quoting a price on a call must not also be the person setting
     * it — the reason the CRM and Sales Dashboard only read price lists.
     */
    hats: [{ app: "crm" }, { app: "accounts", level: "associate" }],
    sentence:
      "Quotes prices on calls and edits the price lists in Accounts, so one person can set the price their own orders are measured in.",
  },
  {
    hats: [{ app: "sales" }, { app: "founder" }],
    sentence:
      "Runs the field team and edits price lists from the Founder desk, so one person can set the price their team's orders are measured in.",
  },
];

/** What somebody holds, in the shape this file compares against. */
export type HeldHat = { app: string | null; role: string };

/* Admin of an app holds that app's manager list, so a rule naming the manager
   level is true of its administrator too. */
function levelMatches(want: ConflictHat["level"], role: string): boolean {
  if (!want) return true;
  return want === "manager" ? role === "manager" || role === "admin" : role === want;
}

function matches(hat: ConflictHat, held: readonly HeldHat[]): boolean {
  return held.some((h) => h.app === hat.app && levelMatches(hat.level, h.role));
}

/** The conflicts a set of hats produces. Empty for almost everybody. */
export function conflictsFor(held: readonly HeldHat[]): RoleConflict[] {
  /* A PLATFORM administrator holds everything everywhere, so every pair below
     is true of them, and saying so would put five warnings on every
     administrator and teach people to scroll past all of them — the thing to
     weigh when granting that is that it is the platform, which the screen
     says in its own words. Admin of ONE app is not that: it holds that app
     alone, so it is checked like any other hat. */
  if (held.some((h) => h.app === "admin" && h.role === "admin")) return [];

  return ROLE_CONFLICTS.filter(
    (c) => matches(c.hats[0], held) && matches(c.hats[1], held),
  );
}
