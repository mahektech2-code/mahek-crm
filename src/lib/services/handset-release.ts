import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, mbosDevices, notifications, users } from "@/db/schema";
import { err, okVoid, type Result } from "@/lib/result";

const gen = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

/**
 * RELEASING A HANDSET, written once for the two doors onto it.
 *
 * The sign-in refusal tells a salesman to "ask an admin to release the old
 * one", and the only button that did it was on Sales → Logins — behind the
 * Sales Dashboard grant, which a platform administrator does not hold by
 * being one. So the person the sentence named opened the Admin Console's
 * Handsets table, found the phone listed, and had nothing to press.
 *
 * Both doors now land here, so the row, the audit entry and the notification
 * the salesman reads cannot differ by which screen released him. What differs
 * is WHO may, and that stays with each caller: the Sales Dashboard narrows to
 * a manager's own team, the console is a platform administrator's and sees
 * everybody — `outsideScope` is how the first says so.
 */
export async function releaseHandsetBinding(input: {
  actor: { id: string; name: string };
  deviceId: string;
  reason: string;
  /** Answer true to refuse a salesman the caller may not act on. */
  outsideScope?: (salesmanId: string) => Promise<boolean>;
  refusedOutsideScope?: string;
}): Promise<Result> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    return err(
      "Say why this handset is being released — somebody reading the row in six months has only this sentence.",
      "validation",
    );
  }

  const [row] = await db
    .select()
    .from(mbosDevices)
    .where(eq(mbosDevices.deviceId, input.deviceId))
    .limit(1);
  if (!row) return err("That handset is not registered to anybody.", "not_found");
  if (input.outsideScope && (await input.outsideScope(row.userId))) {
    return err(input.refusedOutsideScope ?? "That person is not yours to change.", "not_permitted");
  }
  if (!row.active) {
    return err("That handset has already been released.", "validation");
  }

  const [owner] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);

  await db
    .update(mbosDevices)
    .set({
      active: false,
      releasedAt: new Date(),
      releaseReason: reason,
      updatedById: input.actor.id,
      updatedAt: new Date(),
    })
    .where(eq(mbosDevices.id, row.id));

  await db.insert(auditLog).values({
    id: gen("aud"),
    actorId: input.actor.id,
    action: "mbos.device.release",
    entityType: "mbos_device",
    entityId: row.id,
    beforeState: { deviceId: row.deviceId, model: row.model, active: true } as never,
    afterState: { active: false, releaseReason: reason } as never,
  });

  /* The salesman finds out from the handset — it stops syncing on the next
     call — so he is told here as well, with the reason, rather than being
     left to discover it in a market with a phone that has stopped working. */
  await db.insert(notifications).values({
    id: gen("ntf"),
    userId: row.userId,
    kind: "neutral",
    title: "Your handset was released",
    body: `${input.actor.name} released the phone you were signed in on — ${reason}. Sign in again on the handset you are using now.`,
  });

  return okVoid(`${owner?.name ?? "That salesman"} can sign in on a new handset now.`);
}
