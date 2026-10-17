import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appModuleAccess, users } from "@/db/schema";
import { stamp } from "@/lib/format";
import { notifyUser, notifyUsers } from "@/lib/notify";
import { REVIEW_MODULE_KEY } from "./kinds";

/* ---------------------------------------------------------------------------
 * TELLING PEOPLE WHAT HAPPENED TO THEIR WEBSITE CHANGES.
 *
 * A decision nobody receives is not a decision: an approval the employee never
 * hears about sits unpublished until it expires, and a rejection nobody reads
 * is the same change submitted again unchanged. So every step that hands the
 * work to somebody else tells them — and ONLY them:
 *
 *   assigned         → the employee;
 *   submitted        → every holder of `website.review`, except the person who
 *                      submitted (they know);
 *   approved         → the person who submitted;
 *   rejected         → the person who submitted, with the reason in the message;
 *   revoked, expired,
 *   stale            → the person who submitted.
 *
 * A reviewer is not told about another reviewer's decision, and nobody is told
 * about a withdrawal: the person who withdrew it did it themselves.
 *
 * Every link starts `/website/`, which is what `notificationAppOf` reads to put
 * the message in the Website app's bell and nowhere else.
 *
 * BEST-EFFORT, AND AFTER THE COMMIT. These run once the change is safely in the
 * database, and a failure here is logged and swallowed: a bell that could not be
 * written must never undo an approval, hold up a publish or fail a submission.
 * That is also why none of them is called from inside a transaction — a
 * rolled-back change must not have told anybody it happened.
 * ------------------------------------------------------------------------- */

/** The exact words an employee is told when their changes are approved. */
export const APPROVED_TITLE = "Verification Granted — You can now publish your approved changes.";

const quote = (s: string) => `“${s}”`;

/** "“Alpha”", "“Alpha”, “Bravo”", or "5 items (“Alpha”, “Bravo” and 3 more)" — never a wall of names. */
export function summarise(labels: readonly string[]): string {
  if (labels.length === 0) return "your changes";
  if (labels.length === 1) return quote(labels[0]);
  if (labels.length <= 3) return labels.map(quote).join(", ");
  return `${labels.length} items (${quote(labels[0])}, ${quote(labels[1])} and ${labels.length - 2} more)`;
}

export type AfterCommit = () => Promise<void>;

/**
 * Runs what was queued during a transaction, once it has committed. Each one is
 * isolated: one that fails is logged and the rest still run, and none of them can
 * throw into the caller.
 */
export async function runAfterCommit(queue: readonly AfterCommit[]): Promise<void> {
  for (const send of queue) {
    try {
      await send();
    } catch (e) {
      console.error("website review: a notification could not be written —", e instanceof Error ? e.message : e);
    }
  }
}

/** Everybody who may decide a submission: an active person with the Website app AND the review module's own row. */
export async function reviewHolderIds(): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(appModuleAccess)
    .innerJoin(users, eq(users.id, appModuleAccess.userId))
    .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "website")))
    .where(and(eq(appModuleAccess.app, "website"), eq(appModuleAccess.module, REVIEW_MODULE_KEY), eq(users.active, true)));
  return [...new Set(rows.map((r) => r.id))];
}

/* ------------------------------------------------------------- the messages */

export async function notifyAssigned(input: { employeeId: string; assignerName: string; what: string; note: string | null }): Promise<void> {
  await notifyUser({
    userId: input.employeeId,
    title: "You have been assigned website work",
    body: `${input.assignerName} assigned you ${input.what}.${input.note ? ` ${input.note}` : ""} You can edit it, and submit it for verification when it is ready.`,
    kind: "info",
    href: "/website/my-work",
  });
}

export async function notifySubmitted(input: { requestId: string; submitterId: string; submitterName: string; labels: readonly string[]; note: string | null }): Promise<void> {
  const reviewers = (await reviewHolderIds()).filter((id) => id !== input.submitterId);
  if (reviewers.length === 0) return;
  await notifyUsers(
    reviewers.map((userId) => ({
      userId,
      title: "Website changes waiting for review",
      body: `${input.submitterName} submitted ${summarise(input.labels)} for verification.${input.note ? ` Note: ${quote(input.note)}` : ""}`,
      kind: "info",
      href: `/website/review/${input.requestId}`,
    })),
  );
}

export async function notifyApproved(input: { requestId: string; submitterId: string; reviewerName: string; labels: readonly string[]; expiresAt: Date }): Promise<void> {
  await notifyUser({
    userId: input.submitterId,
    title: APPROVED_TITLE,
    body: `${input.reviewerName} approved ${summarise(input.labels)}. Publish it by ${stamp(input.expiresAt)}; after that the approval lapses.`,
    kind: "success",
    href: `/website/my-work/${input.requestId}`,
  });
}

export type ClosedHow = "rejected" | "revoked" | "expired" | "stale";

/** Rejected, revoked, expired or stale: the request is closed and the person who submitted it is told which, and why. */
export async function notifyClosed(input: {
  how: ClosedHow;
  requestId: string;
  submitterId: string;
  labels: readonly string[];
  /** The reviewer who rejected or revoked; null for the two that nobody decided. */
  actorName: string | null;
  reason: string | null;
}): Promise<void> {
  const what = summarise(input.labels);
  const by = input.actorName ?? "A reviewer";
  const text: Record<ClosedHow, { title: string; body: string }> = {
    rejected: {
      title: "Website changes rejected",
      body: `${by} rejected ${what}${input.reason ? `: ${quote(input.reason)}` : "."} Fix what it says and submit it again.`,
    },
    revoked: {
      title: "Approval revoked",
      body: `${by} took back the approval for ${what} before it was published. Nothing went live. You can submit it again.`,
    },
    expired: {
      title: "Approval expired",
      body: `The approval for ${what} ran out after 7 days and nothing was published. Submit it again to ask for it afresh.`,
    },
    stale: {
      title: "Approval no longer applies",
      body: `${what} changed after it was submitted, so the approval cannot be used and nothing was published. Submit it again.`,
    },
  };
  await notifyUser({
    userId: input.submitterId,
    title: text[input.how].title,
    body: text[input.how].body,
    kind: "warn",
    href: `/website/my-work/${input.requestId}`,
  });
}
