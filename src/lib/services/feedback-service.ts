import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { feedback, users } from "@/db/schema";
import type { FeedbackKind, FeedbackStatus } from "@/lib/feedback-labels";

/* ---------------------------------------------------------------------------
 * Reads for the feedback the team sends in.
 *
 * One shape for both readers: the submitter's own list on the form they wrote
 * it from, and the triage list in the Admin Console. They are the same rows
 * and they must not describe the same report differently — somebody told "we
 * are looking at it" on one screen and "new" on another stops reporting.
 * ------------------------------------------------------------------------- */

export type FeedbackRow = {
  id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  path: string | null;
  app: string | null;
  userAgent: string | null;
  status: FeedbackStatus;
  adminNote: string | null;
  byId: string;
  byName: string;
  byRole: string;
  handledByName: string | null;
  handledAt: string | null;
  createdAt: string;
};

function rowShape() {
  return {
    id: feedback.id,
    kind: feedback.kind,
    title: feedback.title,
    body: feedback.body,
    path: feedback.path,
    app: feedback.app,
    userAgent: feedback.userAgent,
    status: feedback.status,
    adminNote: feedback.adminNote,
    byId: feedback.userId,
    byName: users.name,
    byRole: users.role,
    // A second join to `users` for the handler would need an alias; the name
    // is read with a scalar subquery instead, which is one row either way and
    // keeps the query readable. The outer column is written out in full —
    // Drizzle would render a bare "handled_by_id" that binds to the inner
    // table the moment `users` ever gains a column by that name.
    handledByName: sql<
      string | null
    >`(select u.name from users u where u.id = feedback.handled_by_id)`,
    handledAt: feedback.handledAt,
    createdAt: feedback.createdAt,
  };
}

function toRow(r: {
  id: string;
  kind: string;
  title: string;
  body: string;
  path: string | null;
  app: string | null;
  userAgent: string | null;
  status: string;
  adminNote: string | null;
  byId: string;
  byName: string;
  byRole: string;
  handledByName: string | null;
  handledAt: Date | null;
  createdAt: Date;
}): FeedbackRow {
  return {
    ...r,
    kind: r.kind as FeedbackKind,
    status: r.status as FeedbackStatus,
    handledAt: r.handledAt ? r.handledAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Everything sent in, newest first, optionally cut to one status or kind.
 *
 * There is no paging yet and deliberately so: a workspace of eight people
 * does not produce a list worth paging, and a filter that hides the oldest
 * unanswered report is how one goes unanswered.
 */
export async function listFeedback(
  filter: { status?: FeedbackStatus; kind?: FeedbackKind; limit?: number } = {},
): Promise<FeedbackRow[]> {
  const conditions = [
    filter.status ? eq(feedback.status, filter.status) : undefined,
    filter.kind ? eq(feedback.kind, filter.kind) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select(rowShape())
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.userId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(feedback.createdAt))
    .limit(filter.limit ?? 500);

  return rows.map(toRow);
}

/** What one person has sent in. Shown back to them on the feedback form. */
export async function listMyFeedback(userId: string, limit = 10): Promise<FeedbackRow[]> {
  const rows = await db
    .select(rowShape())
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.userId))
    .where(eq(feedback.userId, userId))
    .orderBy(desc(feedback.createdAt))
    .limit(limit);

  return rows.map(toRow);
}

export type FeedbackCounts = Record<FeedbackStatus, number> & { total: number };

/** The badge on the console's nav counts what is waiting, not what exists. */
export async function feedbackCounts(): Promise<FeedbackCounts> {
  const rows = await db
    .select({ status: feedback.status, n: sql<number>`count(*)::int` })
    .from(feedback)
    .groupBy(feedback.status);

  const counts: FeedbackCounts = {
    new: 0,
    in_progress: 0,
    done: 0,
    declined: 0,
    total: 0,
  };
  for (const r of rows) {
    counts[r.status as FeedbackStatus] = r.n;
    counts.total += r.n;
  }
  return counts;
}
