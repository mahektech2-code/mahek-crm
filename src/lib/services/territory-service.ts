import "server-only";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { mbosUserTerritories } from "@/db/schema";
import { TERRITORY_REGION_SQL, qualify } from "@/lib/territory-sql";
import {
  territoryClause,
  TERRITORY_KINDS,
  type Territory,
  type TerritoryKind,
} from "@/lib/territory-rules";

export { TERRITORY_REGION_SQL, qualify };

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
 * NO TERRITORY NOW MEANS NO BOOK, and that is a reversal — it meant no
 * narrowing until this landed, and the reasoning for the old answer is worth
 * keeping because it is still true and is now something to be paid for rather
 * than avoided. Allocating cities to eight people and forgetting the ninth
 * empties her handset, and an empty screen is the one outcome nobody debugs,
 * because it looks like having no work. This codebase has that failure on
 * record: reading one seat where two were meant gave Seema Roy "queue cleared"
 * on a day she had 195 accounts to work.
 *
 * What makes the reversal survivable is that the emptiness is NAMED at both
 * ends. `mbosTerritoryState` hands the handset the reason, so the Customers tab
 * says "no area has been allocated to you yet" rather than "nothing in your
 * book"; and the console counts the unallocated on the team screen, so the
 * office sees whose handset it has switched off. An empty book that explains
 * itself is a support call; one that does not is a fortnight of a salesman
 * assuming the sync is broken.
 *
 * The reversal is deliberate and it is Mahek's: an unallocated salesman
 * carrying the whole book is how five thousand shops end up on one phone, and
 * a forcing function on the office is worth more than the safety valve.
 * ------------------------------------------------------------------------- */

export {
  PARENT_KIND,
  TERRITORY_KINDS,
  territoryClause,
  type Territory,
  type TerritoryKind,
} from "@/lib/territory-rules";

/** What this person works. Empty means they have been given nowhere. */
export async function territoriesFor(userId: string): Promise<Territory[]> {
  const rows = await db
    .select({
      kind: mbosUserTerritories.kind,
      region: mbosUserTerritories.region,
      parent: mbosUserTerritories.parent,
    })
    .from(mbosUserTerritories)
    .where(eq(mbosUserTerritories.userId, userId));

  return rows
    .filter((r): r is { kind: TerritoryKind; region: string; parent: string } =>
      (TERRITORY_KINDS as readonly string[]).includes(r.kind),
    )
    .map((r) => ({ kind: r.kind, value: r.region, parent: r.parent || undefined }));
}

/** The working ones — everything the "where they work" dialog owns. */
export async function workingTerritoriesFor(userId: string): Promise<Territory[]> {
  return (await territoriesFor(userId)).filter((t) => t.kind !== "region");
}

/** The same, for a caller that has a user id and not a list. */
export async function territoryClauseFor(userId: string): Promise<SQL> {
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
          parent: t.parent?.trim() ?? "",
          createdById: actorId,
        })),
      );
    }
  });
}
