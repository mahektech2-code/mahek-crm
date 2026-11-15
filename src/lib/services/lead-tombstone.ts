import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { customers, mbosDeletions } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * A LEAD THAT LEAVES THE LEADS CHANNEL IS TOLD TO LEAVE THE PHONE.
 *
 * A pull says what exists; only a tombstone says what stopped. `openLeads`
 * stops sending a lead the moment it is lost, archived, reassigned away from
 * somebody, marked third-party or converted — and the handset keeps whatever
 * it last received for the life of the installation. Conversion
 * (`recordConversion`) and the trash (`lead-trash-sync.ts`) always wrote one;
 * nothing else did, so a lost lead sat under Leads at its last rung for ever.
 *
 * The handset ARCHIVES a `leads` tombstone rather than deleting the row (see
 * `applyDeletionChunk` in mbos-app), so anything still queued against it
 * reaches the office, and `upsertLeads` writes `archived = 0` the next time the
 * lead is sent — which is how a lead that comes BACK reappears. Only the
 * `leads` entity: the shop itself is still in his book (or not) by the
 * customers channel's own rules.
 *
 * `userIds` null is everybody, which is right for a fact about the LEAD (lost,
 * archived, third-party): every phone holding it should let it go, and a phone
 * that never held it archives nothing. A reassignment is a fact about ONE
 * PERSON, so it is written for the former holder only.
 *
 * THE PULL NEVER TOMBSTONES A LEAD IT IS ALSO SENDING (`buildPull` drops the
 * pair), because the handset applies upserts BEFORE tombstones: a lead lost
 * and reopened, or taken away and given back, between two of somebody's syncs
 * would otherwise arrive and be archived in the same pull. Lifting the
 * standing tombstone below is the second half of the same promise, for a phone
 * that has not synced since.
 * ------------------------------------------------------------------------- */

export type LeadTombstoneReason =
  | "lead_lost"
  | "lead_archived"
  | "lead_reassigned"
  | "lead_third_party";

/** Every reason THIS file writes — and so may lift. Conversion and trash are
 *  not here: a converted lead is not a lead again, and the trash withdraws its
 *  own (`leadsReturnedToHandsets`). */
export const LEAD_LEFT_REASONS: readonly LeadTombstoneReason[] = [
  "lead_lost",
  "lead_archived",
  "lead_reassigned",
  "lead_third_party",
];

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Tx | typeof db;

function asList(ids: string | readonly string[]): string[] {
  return [...new Set((typeof ids === "string" ? [ids] : ids).filter(Boolean))];
}

/**
 * Tell the handsets of `userIds` (null: everybody) that these leads have left
 * their Leads screens. Idempotent in effect — a second tombstone archives an
 * already archived row — and never fails for an empty list.
 */
export async function tombstoneLeadFor(
  tx: Executor,
  leadIds: string | readonly string[],
  userIds: readonly (string | null | undefined)[] | null,
  reason: LeadTombstoneReason = "lead_reassigned",
): Promise<number> {
  const leads = asList(leadIds);
  if (!leads.length) return 0;
  const targets: (string | null)[] =
    userIds === null ? [null] : [...new Set(userIds.filter((u): u is string => Boolean(u)))];
  if (!targets.length) return 0;
  const rows = leads.flatMap((entityId) =>
    targets.map((userId) => ({
      id: `del_${randomUUID().slice(0, 12)}`,
      entity: "leads",
      entityId,
      userId,
      reason,
    })),
  );
  for (let i = 0; i < rows.length; i += 1000) {
    await tx.insert(mbosDeletions).values(rows.slice(i, i + 1000));
  }
  return rows.length;
}

/**
 * The lead is visible again — reopened, restored, or given (back) to these
 * people. Withdraws the standing tombstones this file wrote, so a phone that
 * has not synced since is never told to archive a lead that is back.
 *
 * `userIds` null withdraws the everybody-tombstones (lost, archived,
 * third-party); a list withdraws those people's own (and, for good measure,
 * nothing else). `reasons` narrows which kinds are withdrawn.
 */
export async function liftLeadTombstones(
  tx: Executor,
  leadIds: string | readonly string[],
  userIds: readonly (string | null | undefined)[] | null,
  reasons: readonly LeadTombstoneReason[] = LEAD_LEFT_REASONS,
): Promise<void> {
  const leads = asList(leadIds);
  if (!leads.length || !reasons.length) return;
  const who =
    userIds === null
      ? isNull(mbosDeletions.userId)
      : (() => {
          const ids = [...new Set(userIds.filter((u): u is string => Boolean(u)))];
          return ids.length ? inArray(mbosDeletions.userId, ids) : undefined;
        })();
  if (!who) return;
  await tx
    .delete(mbosDeletions)
    .where(
      and(
        eq(mbosDeletions.entity, "leads"),
        inArray(mbosDeletions.entityId, leads),
        inArray(mbosDeletions.reason, [...reasons]),
        who,
      ),
    );
}

/**
 * EVERY SEAT THAT PUTS A LEAD ON SOMEBODY'S HANDSET, read after a write.
 * The seats `scopedToUsers` reads for a lead (its owner — `ASSIGNED_TO_SQL`
 * for a lead — the back office, the lead manager, the relationship owner),
 * which are the seats `openLeads` sends a lead through. A former holder who
 * still sits in one is not told to let it go. Reach through a manager's team,
 * the party sheet's name or a territory is not checked here; `buildPull`
 * drops a tombstone for any lead it is also sending, which covers those.
 */
async function seatHolders(tx: Executor, leadId: string): Promise<Set<string>> {
  const [row] = await tx
    .select({
      ownerId: customers.ownerId,
      leadManagerId: customers.leadManagerId,
      backOfficeAmId: customers.backOfficeAmId,
      relationshipOwnerId: customers.relationshipOwnerId,
    })
    .from(customers)
    .where(eq(customers.id, leadId))
    .limit(1);
  const out = new Set<string>();
  if (!row) return out;
  for (const v of Object.values(row)) if (v) out.add(v);
  return out;
}

/** Who sits in a lead's seats now — read BEFORE a write, handed to
 *  `syncLeadHolders` after it. */
export async function leadSeatHolders(tx: Executor, leadId: string): Promise<string[]> {
  return [...(await seatHolders(tx, leadId))];
}

/**
 * A SEAT ON A LEAD CHANGED — call it inside the same transaction, AFTER the
 * update. Each former holder who no longer sits in any seat is tombstoned
 * (their phone archives the lead); every current holder has any standing
 * reassignment tombstone of theirs withdrawn, so a lead given back reappears.
 *
 * `formerIds` is whoever held the seats before the write; nulls are ignored.
 */
export async function syncLeadHolders(
  tx: Executor,
  leadId: string,
  formerIds: readonly (string | null | undefined)[],
): Promise<{ tombstoned: string[] }> {
  const now = await seatHolders(tx, leadId);
  const gone = [...new Set(formerIds.filter((u): u is string => Boolean(u)))].filter(
    (u) => !now.has(u),
  );
  if (gone.length) await tombstoneLeadFor(tx, leadId, gone, "lead_reassigned");
  if (now.size) await liftLeadTombstones(tx, leadId, [...now], ["lead_reassigned"]);
  return { tombstoned: gone };
}

export { seatsMoved, withoutResentLeads } from "./lead-tombstone-rules";
