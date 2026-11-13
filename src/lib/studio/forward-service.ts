import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { studioForwardRecipients, studioForwards } from "@/db/schema";
import { tally, type ForwardStatus } from "./domain/forward";

/* Reads for Upload & Bulk Forward. A forward belongs to whoever uploaded it:
   somebody else's id answers exactly as an id that does not exist. */

export const imageUrlOf = (id: string) => `/api/studio/forwards/${encodeURIComponent(id)}/image`;

export async function getForward(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(studioForwards)
    .where(and(eq(studioForwards.id, id), eq(studioForwards.createdById, userId)))
    .limit(1);
  return row ?? null;
}

export async function myForwards(userId: string, limit = 30) {
  const rows = await db.select().from(studioForwards).where(eq(studioForwards.createdById, userId)).orderBy(desc(studioForwards.createdAt)).limit(limit);
  if (!rows.length) return [];
  const recipients = await db
    .select({ forwardId: studioForwardRecipients.forwardId, status: studioForwardRecipients.status })
    .from(studioForwardRecipients)
    .where(
      inArray(
        studioForwardRecipients.forwardId,
        rows.map((r) => r.id),
      ),
    );
  return rows.map((r) => ({ ...r, tally: tally(recipients.filter((x) => x.forwardId === r.id).map((x) => x.status as ForwardStatus)) }));
}

export async function forwardRecipients(forwardId: string) {
  return db.select().from(studioForwardRecipients).where(eq(studioForwardRecipients.forwardId, forwardId)).orderBy(asc(studioForwardRecipients.company), asc(studioForwardRecipients.id));
}

/** Customers this person has already forwarded this very picture (same bytes) to, in a forward they actually started. */
export async function alreadySentTo(userId: string, sha256: string, exceptForwardId: string, customerIds: readonly string[]): Promise<Set<string>> {
  if (!customerIds.length) return new Set();
  const rows = await db
    .select({ customerId: studioForwardRecipients.customerId })
    .from(studioForwardRecipients)
    .innerJoin(studioForwards, eq(studioForwards.id, studioForwardRecipients.forwardId))
    .where(
      and(
        eq(studioForwards.createdById, userId),
        eq(studioForwards.sha256, sha256),
        eq(studioForwards.status, "started"),
        inArray(studioForwardRecipients.customerId, [...customerIds]),
        inArray(studioForwardRecipients.status, ["opened", "sent"]),
      ),
    );
  void exceptForwardId;
  return new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x));
}
