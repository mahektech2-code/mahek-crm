import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { feedback, feedbackMessages, users } from "@/db/schema";
import { listAttachments, type AttachmentView } from "./attachment-service";
import type { FeedbackKind, FeedbackStatus } from "@/lib/feedback-labels";

/* ---------------------------------------------------------------------------
 * Reads for the feedback the team sends in.
 *
 * One shape for both readers: the submitter's own list on the form they wrote
 * it from, and the triage list in the Admin Console. They are the same rows
 * and they must not describe the same report differently — somebody told "we
 * are looking at it" on one screen and "new" on another stops reporting.
 *
 * A report is now a THREAD, so both readers get the same messages in the same
 * order and the same files hanging off them. The submitter reading a shorter
 * version of the conversation they are in would be its own kind of lie.
 * ------------------------------------------------------------------------- */

export type FeedbackMessageView = {
  id: string;
  body: string | null;
  /** Set where this line also moved the report along. */
  statusTo: FeedbackStatus | null;
  authorId: string;
  authorName: string;
  authorRole: string;
  /** Which side of the conversation wrote it — the person who reported it, or triage. */
  fromSubmitter: boolean;
  at: string;
  attachments: AttachmentView[];
};

export type FeedbackRow = {
  id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  path: string | null;
  app: string | null;
  userAgent: string | null;
  status: FeedbackStatus;
  byId: string;
  byName: string;
  byRole: string;
  handledByName: string | null;
  handledAt: string | null;
  createdAt: string;
  /** Screenshots sent with the report itself. */
  attachments: AttachmentView[];
  /** Everything said since, oldest first, so it reads as a conversation. */
  messages: FeedbackMessageView[];
  /**
   * The last line came from the person who reported it, and nobody has
   * answered since. That is the only state where triage owes somebody a reply,
   * and a status alone cannot say it: a report can sit at "Being looked at"
   * with a question against it that nobody has read.
   */
  awaitingReply: boolean;
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

type RawRow = {
  id: string;
  kind: string;
  title: string;
  body: string;
  path: string | null;
  app: string | null;
  userAgent: string | null;
  status: string;
  byId: string;
  byName: string;
  byRole: string;
  handledByName: string | null;
  handledAt: Date | null;
  createdAt: Date;
};

/**
 * Hangs the conversation and the files onto a page of reports.
 *
 * Two queries for the messages and one `listAttachments` per thing that can
 * carry a file, rather than a join that returns the report body once per
 * attachment. A workspace of eight people does not produce the row count that
 * would make that arithmetic matter, and the shape stays readable.
 */
async function withThreads(raw: RawRow[]): Promise<FeedbackRow[]> {
  if (!raw.length) return [];

  const ids = raw.map((r) => r.id);
  const messages = await db
    .select({
      id: feedbackMessages.id,
      feedbackId: feedbackMessages.feedbackId,
      body: feedbackMessages.body,
      statusTo: feedbackMessages.statusTo,
      authorId: feedbackMessages.authorId,
      authorName: users.name,
      authorRole: users.role,
      at: feedbackMessages.createdAt,
    })
    .from(feedbackMessages)
    .innerJoin(users, eq(users.id, feedbackMessages.authorId))
    .where(inArray(feedbackMessages.feedbackId, ids))
    .orderBy(asc(feedbackMessages.createdAt));

  const reportFiles = new Map<string, AttachmentView[]>(
    await Promise.all(
      ids.map(
        async (id) => [id, await listAttachments("feedback", id)] as [string, AttachmentView[]],
      ),
    ),
  );
  const messageFiles = new Map<string, AttachmentView[]>(
    await Promise.all(
      messages.map(
        async (m) =>
          [m.id, await listAttachments("feedback_message", m.id)] as [string, AttachmentView[]],
      ),
    ),
  );

  return raw.map((r) => {
    const thread = messages
      .filter((m) => m.feedbackId === r.id)
      .map((m) => ({
        id: m.id,
        body: m.body,
        statusTo: (m.statusTo as FeedbackStatus | null) ?? null,
        authorId: m.authorId,
        authorName: m.authorName,
        authorRole: m.authorRole,
        fromSubmitter: m.authorId === r.byId,
        at: m.at.toISOString(),
        attachments: messageFiles.get(m.id) ?? [],
      }));

    const last = thread[thread.length - 1];

    return {
      ...r,
      kind: r.kind as FeedbackKind,
      status: r.status as FeedbackStatus,
      handledAt: r.handledAt ? r.handledAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      attachments: reportFiles.get(r.id) ?? [],
      messages: thread,
      // No reply at all is also somebody waiting: the report itself is the
      // submitter's first message, and silence on it reads the same to them.
      awaitingReply: !last || last.fromSubmitter,
    };
  });
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

  return withThreads(rows);
}

/** What one person has sent in, with the whole conversation on each. */
export async function listMyFeedback(userId: string, limit = 25): Promise<FeedbackRow[]> {
  const rows = await db
    .select(rowShape())
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.userId))
    .where(eq(feedback.userId, userId))
    .orderBy(desc(feedback.createdAt))
    .limit(limit);

  return withThreads(rows);
}

/** One thread, or null. The caller decides who may read it — see `canSeeFeedback`. */
export async function getFeedback(id: string): Promise<FeedbackRow | null> {
  const rows = await db
    .select(rowShape())
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.userId))
    .where(eq(feedback.id, id))
    .limit(1);

  const [row] = await withThreads(rows);
  return row ?? null;
}

/* ------------------------------------------------------------------ who may */

// The rule itself lives in `feedback-access.ts` so attachments can ask it
// without importing this file. Re-exported here because every other reader
// comes through the service.
export { canSeeFeedback, canTriageFeedback } from "./feedback-access";

export type FeedbackCounts = Record<FeedbackStatus, number> & {
  total: number;
  /** Threads where the last word is the submitter's. What triage owes people. */
  awaitingReply: number;
};

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
    awaitingReply: 0,
  };
  for (const r of rows) {
    counts[r.status as FeedbackStatus] = r.n;
    counts.total += r.n;
  }

  // Open threads whose last line came from the person who reported it — the
  // report itself counting as their first line, which is why a thread with no
  // messages at all is in here too. Done and Not doing are excluded: those
  // have been answered, and a thank-you left on one is not work.
  const [waiting] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from feedback f
     where f.status in ('new', 'in_progress')
       and coalesce(
             (select m.author_id
                from feedback_messages m
               where m.feedback_id = f.id
               order by m.created_at desc
               limit 1),
             f.user_id
           ) = f.user_id
  `);
  counts.awaitingReply = Number(waiting?.n ?? 0);

  return counts;
}

/** How many replies this person has not been shown yet — the header badge. */
export async function unreadFeedbackReplies(userId: string): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from feedback_messages m
      join feedback f on f.id = m.feedback_id
     where f.user_id = ${userId}
       and m.author_id <> ${userId}
       and m.created_at > coalesce(f.submitter_read_at, to_timestamp(0))
  `);
  return Number(row?.n ?? 0);
}
