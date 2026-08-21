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
 * ------------------------------------------------------------------------- */

export type ConflictRole = "telecaller" | "manager" | "accounts" | "admin";

export type RoleConflict = {
  roles: [ConflictRole, ConflictRole];
  /** What the pair lets somebody do that the matrix was written to prevent. */
  sentence: string;
};

export const ROLE_CONFLICTS: RoleConflict[] = [
  {
    roles: ["manager", "accounts"],
    sentence:
      "Approves orders and confirms payments, while carrying a sales target and setting the team's. The person chasing a target should not sign off the orders that hit it.",
  },
  {
    roles: ["telecaller", "accounts"],
    sentence:
      "Records payments as a telecaller and confirms them as accounts, so one person can report that money arrived and then be the one who says it did.",
  },
];

/** The conflicts a set of hats produces. Empty for almost everybody. */
export function conflictsFor(roles: readonly ConflictRole[]): RoleConflict[] {
  return ROLE_CONFLICTS.filter(
    (c) => roles.includes(c.roles[0]) && roles.includes(c.roles[1]),
  );
}
