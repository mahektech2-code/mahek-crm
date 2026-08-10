import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, feedback, feedbackMessages, type User } from "@/db/schema";
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
  return canTriageFeedback(user);
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
