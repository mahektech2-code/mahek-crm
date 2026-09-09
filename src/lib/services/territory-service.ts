import "server-only";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { mbosUserTerritories } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * WHERE A PERSON WORKS, and what that does and does not mean.
 *
 * A territory NARROWS a book somebody already had. It is not a permission and
 * it must never be read as one: `ASSIGNED_TO_SQL`, `BACK_OFFICE_SQL` and
 * `LEAD_MANAGER_SQL` in `access-control.ts` remain the whole of who may see
 * what, and nothing here can widen them. A salesman allocated Nagpur sees HIS
 * customers and HIS leads in Nagpur — never another salesman's.
 *
 * The distinction is the important thing in this file, because the two look
 * alike from a distance. A reader who mistakes this for the security boundary
 * might delete a real check believing it redundant, and the failure would be
 * silent and in the wrong direction.
 *
 * NO TERRITORY MEANS NO NARROWING. Allocating cities to eight people and
 * forgetting the ninth must not empty her book. This codebase already has that
 * failure on record — reading one seat where two were meant gave Seema Roy
 * "queue cleared" on a day she had 195 accounts to work — and an empty screen
 * is the one outcome nobody debugs, because it looks like having no work.
 * ------------------------------------------------------------------------- */

/** The kinds a territory can be, coarsest first. */
export const TERRITORY_KINDS = ["state", "region", "city", "beat"] as const;
export type TerritoryKind = (typeof TERRITORY_KINDS)[number];

/**
 * Which customer column each kind is matched against.
 *
 * `state` has no column of its own — MahekOne has never stored one, and
 * inventing it here would mean a field nothing fills. It matches
 * `territory_region`, which is the widest geography the customer master
 * actually carries, and the label on the console says so rather than offering a
 * state picker that quietly behaves like a region one.
 */
const COLUMN: Record<TerritoryKind, string> = {
  state: "territory_region",
  region: "territory_region",
  city: "city",
  beat: "beat",
};

export type Territory = { kind: TerritoryKind; value: string };

/** What this person works. Empty means everywhere they already had. */
export async function territoriesFor(userId: string): Promise<Territory[]> {
  const rows = await db
    .select({ kind: mbosUserTerritories.kind, region: mbosUserTerritories.region })
    .from(mbosUserTerritories)
    .where(eq(mbosUserTerritories.userId, userId));

  return rows
    .filter((r): r is { kind: TerritoryKind; region: string } =>
      (TERRITORY_KINDS as readonly string[]).includes(r.kind),
    )
    .map((r) => ({ kind: r.kind, value: r.region }));
}

/**
 * The SQL that narrows a customer list to somebody's territories.
 *
 * `undefined` where there is nothing to narrow by — which every caller must
 * treat as "no filter" rather than "match nothing". That is the whole of the
 * no-territory rule, and it is expressed as an absent clause rather than as a
 * true one so a caller cannot accidentally AND it into oblivion.
 *
 * Comparison is case-insensitive and trimmed, because "Nagpur", "nagpur " and
 * "NAGPUR" are one city typed by three people, and a territory that matched
 * only one spelling would hide a book without saying so.
 */
export function territoryClause(territories: Territory[]): SQL | undefined {
  if (!territories.length) return undefined;

  const parts = territories.map(
    (t) =>
      sql`lower(trim(coalesce(customers.${sql.raw(COLUMN[t.kind])}, ''))) = ${t.value.trim().toLowerCase()}`,
  );

  return sql`(${sql.join(parts, sql` or `)})`;
}

/** The same, for a caller that has a user id and not a list. */
export async function territoryClauseFor(userId: string): Promise<SQL | undefined> {
  return territoryClause(await territoriesFor(userId));
}

/**
 * Set somebody's working territories, replacing what they had of those kinds.
 *
 * `region` rows are deliberately NOT touched here: those are a manager's
 * oversight patch, set by its own action, and clearing them as a side effect of
 * allocating a salesman a city would silently widen a manager's console to the
 * whole country.
 */
export async function setWorkingTerritories(
  userId: string,
  territories: Territory[],
  actorId: string,
): Promise<void> {
  const wanted = territories.filter((t) => t.kind !== "region" && t.value.trim());

  await db.transaction(async (tx) => {
    await tx
      .delete(mbosUserTerritories)
      .where(
        and(
          eq(mbosUserTerritories.userId, userId),
          sql`${mbosUserTerritories.kind} <> 'region'`,
        ),
      );

    if (wanted.length) {
      await tx.insert(mbosUserTerritories).values(
        wanted.map((t) => ({
          id: `ut_${crypto.randomUUID().slice(0, 12)}`,
          userId,
          kind: t.kind,
          region: t.value.trim(),
          createdById: actorId,
        })),
      );
    }
  });
}
