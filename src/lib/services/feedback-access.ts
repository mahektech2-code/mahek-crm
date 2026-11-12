import "server-only";
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, feedback, feedbackMessages, users, type User } from "@/db/schema";
import { isManager } from "@/lib/auth";

/* ---------------------------------------------------------------------------
 * Who may read and answer a feedback thread.
 *
 * Its own file, and a small one, because two subsystems ask: the feedback
 * service, and the attachment endpoint deciding whether somebody may open a
 * screenshot hanging off a reply. Putting it in `feedback-service.ts` would
 * make attachments import feedback and feedback import attachments — a cycle
 * that happens to work in ESM and stops working the day somebody reads one of
 * these at module scope.
 * ------------------------------------------------------------------------- */

/**
 * Who may move a report along and answer it: a manager, or whoever holds the
 * Admin app.
 *
 * One definition, because three things ask it — the action, the console's
 * read-only banner, and the attachment endpoint. Three copies of a permission
 * rule is how one of them ends up more generous than the others.
 */
export async function canTriageFeedback(
  user: Pick<User, "id" | "role">,
): Promise<boolean> {
  if (isManager(user)) return true;
  const rows = await db
    .select({ app: appAccess.app })
    .from(appAccess)
    .where(and(eq(appAccess.userId, user.id), eq(appAccess.app, "admin")))
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether this person may read one thread: the two sides of the conversation
 * and nobody else. A report can name a customer, a figure or a colleague, and
 * it was written to whoever looks after MahekOne rather than to the office.
 */
export async function canSeeFeedback(
  user: Pick<User, "id" | "role">,
  feedbackId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ userId: feedback.userId })
    .from(feedback)
    .where(eq(feedback.id, feedbackId))
    .limit(1);
  if (!row) return false;
  if (row.userId === user.id) return true;
  // Somebody who said "same problem" is on the reporter side of this thread:
  // every reply here is a reply to them too, so they may read it and answer.
  const [follower] = await db
    .select({ id: feedback.id })
    .from(feedback)
    .where(and(eq(feedback.duplicateOfId, feedbackId), eq(feedback.userId, user.id)))
    .limit(1);
  if (follower) return true;
  return canTriageFeedback(user);
}

/**
 * Every active person who may triage — exactly the set `canTriageFeedback`
 * lets in: managers and administrators by level, and whoever holds the Admin
 * app. Notified of new reports, and offered as the person to hand one to.
 */
export async function triagerIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .leftJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "admin")))
    .where(
      and(
        eq(users.active, true),
        or(sql`${users.role} in ('manager', 'admin')`, sql`${appAccess.id} is not null`),
      ),
    );
  return rows.map((r) => r.id);
}

/** The thread one message belongs to — for deciding who may open its files. */
export async function feedbackBehindMessage(messageId: string): Promise<string | null> {
  const [row] = await db
    .select({ feedbackId: feedbackMessages.feedbackId })
    .from(feedbackMessages)
    .where(eq(feedbackMessages.id, messageId))
    .limit(1);
  return row?.feedbackId ?? null;
}
