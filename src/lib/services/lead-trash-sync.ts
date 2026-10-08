import "server-only";
import { randomUUID } from "node:crypto";
import { and, inArray } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mbosDeletions } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * THE LEAD TRASH, ON THE SALESMEN'S PHONES.
 *
 * A pull says what exists and only a tombstone says what stopped (see
 * `mbos_deletions`), so a lead moved to the trash would otherwise sit on every
 * handset that already holds it. Two tombstones per lead, for everybody
 * (`user_id` null — a phone that never held it deletes nothing):
 *
 *   `customers` takes the shop off the Customers list on every build;
 *   `leads` takes it off the Leads screens — archived there, never deleted,
 *     because a lead may have the salesman's own changes still queued. Builds
 *     older than the one that learned this ignore the entity, so on them the
 *     lead leaves the Customers list and stays under Leads until updated.
 *
 * Restoring withdraws both, so a phone that never synced in between is never
 * told to drop a lead that is back; the restore also moves `updated_at`, so a
 * phone that did drop it is sent it again on its next pull.
 * ------------------------------------------------------------------------- */

const REASON = "lead_trashed";
const ENTITIES = ["customers", "leads"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function leadsLeftHandsets(tx: Tx, customerIds: string[]): Promise<void> {
  if (!customerIds.length) return;
  await tx.insert(mbosDeletions).values(
    customerIds.flatMap((entityId) =>
      ENTITIES.map((entity) => ({
        id: `del_${randomUUID().slice(0, 12)}`,
        entity,
        entityId,
        userId: null,
        reason: REASON,
      })),
    ),
  );
}

export async function leadsReturnedToHandsets(tx: Tx, customerIds: string[]): Promise<void> {
  if (!customerIds.length) return;
  await tx
    .delete(mbosDeletions)
    .where(
      and(
        eq(mbosDeletions.reason, REASON),
        inArray(mbosDeletions.entity, [...ENTITIES]),
        inArray(mbosDeletions.entityId, customerIds),
      ),
    );
}
