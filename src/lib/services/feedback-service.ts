import "server-only";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { feedback, feedbackMessages, users } from "@/db/schema";
import { listAttachments, type AttachmentView } from "./attachment-service";
import { triagerIds } from "./feedback-access";
import {
  feedbackRef,
  feedbackStage,
  triageQueue,
  type FeedbackImpact,
  type FeedbackKind,
  type FeedbackStage,
  type FeedbackStatus,
  type FeedbackVerdict,
  type TriageQueue,
} from "@/lib/feedback-labels";

/* ---------------------------------------------------------------------------
 * Reads for the feedback the team sends in.
 *
 * One shape for both readers: the reporter's own list, in whichever app they
 * are standing in, and the triage inbox in the Admin Console. They are the
 * same rows and they must not describe the same report differently — somebody
 * told "we are looking at it" on one screen and "new" on another stops
 * reporting.
 *
 * TWO VIEWS OF ONE THREAD. Triage reads every line, team notes included; the
 * reporter reads every line except team notes. That is the whole difference,
 * and it is decided here, in one place, rather than by a screen remembering to
 * hide something.
 *
 * "SAME PROBLEM AS". A report pointing at another (`duplicateOfId`) keeps its
 * own words and files, and reads its status and its conversation off the one it
 * points at. Everybody who reported the same thing is on the REPORTER side of
 * that one conversation: a reply to any of them is a reply to all of them.
 * ------------------------------------------------------------------------- */

export type FeedbackMessageView = {
  id: string;
  body: string | null;
  /** Set where this line also moved the report along. */
  statusTo: FeedbackStatus | null;
  /** A team note — present only in the team's view. */
  internal: boolean;
  authorId: string;
  authorName: string;
  authorRole: string;
  /** Written by somebody who reported this (the reporter or a "same problem"). */
  fromSubmitter: boolean;
  at: string;
  attachments: AttachmentView[];
};

/** Somebody else who reported the same thing, with their own words. */
export type AlsoReported = {
  id: string;
  ref: string;
  byId: string;
  byName: string;
  body: string;
  path: string | null;
  createdAt: string;
  attachments: AttachmentView[];
};

export type FeedbackRow = {
  id: string;
  number: number;
  /** "FB-1042". */
  ref: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  path: string | null;
  app: string | null;
  userAgent: string | null;
  status: FeedbackStatus;
  impact: FeedbackImpact | null;
  assigneeId: string | null;
  assigneeName: string | null;
  duplicateOfId: string | null;
  verdict: FeedbackVerdict | null;
  verdictAt: string | null;
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
  /** Everybody who said "same problem", oldest first. */
  alsoReported: AlsoReported[];
  /**
   * The last line the reporter can read came from the reporter side, or there
   * is none. The only state where triage owes somebody a reply, and a status
   * alone cannot say it.
   */
  awaitingReply: boolean;
  /** That last line is a written reply from triage — the reporter owes us. */
  teamAsked: boolean;
  /** Anybody on the team has said or done anything visible on it. */
  seen: boolean;
  stage: FeedbackStage;
  queue: Exclude<TriageQueue, "all">;
  /** When anything last happened on it, for sorting and for "2 days". */
  lastActivityAt: string;
  /** The last thing said that this reader can read, as a one-line snippet. */
  lastLine: { who: string; text: string } | null;
};

/**
 * What one REPORTER sees of their own report. Where they said "same problem",
 * it is the other report's status and thread with their own words on top —
 * `sameAs` says which report they are following.
 */
export type MyFeedbackRow = FeedbackRow & {
  sameAs: { id: string; ref: string; title: string } | null;
  /** Lines from the team they have not been shown yet. */
  unread: number;
};

function rowShape() {
  return {
    id: feedback.id,
    number: feedback.number,
    kind: feedback.kind,
    title: feedback.title,
    body: feedback.body,
    path: feedback.path,
    app: feedback.app,
    userAgent: feedback.userAgent,
    status: feedback.status,
    impact: feedback.impact,
    assigneeId: feedback.assigneeId,
    // Second and third reads of `users` as scalar subqueries rather than
    // aliased joins: one row either way, and the outer columns are written out
    // in full so they can never bind to the inner table.
    assigneeName: sql<string | null>`(select u.name from users u where u.id = feedback.assignee_id)`,
    duplicateOfId: feedback.duplicateOfId,
    verdict: feedback.verdict,
    verdictAt: feedback.verdictAt,
    byId: feedback.userId,
    byName: users.name,
    byRole: users.role,
    handledByName: sql<string | null>`(select u.name from users u where u.id = feedback.handled_by_id)`,
    handledAt: feedback.handledAt,
    createdAt: feedback.createdAt,
    submitterReadAt: feedback.submitterReadAt,
  };
}

type RawRow = {
  id: string;
  number: number;
  kind: string;
  title: string;
  body: string;
  path: string | null;
  app: string | null;
  userAgent: string | null;
  status: string;
  impact: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  duplicateOfId: string | null;
  verdict: string | null;
  verdictAt: Date | null;
  byId: string;
  byName: string;
  byRole: string;
  handledByName: string | null;
  handledAt: Date | null;
  createdAt: Date;
  submitterReadAt: Date | null;
};

const SNIPPET = 140;
const snippet = (s: string) => (s.length > SNIPPET ? `${s.slice(0, SNIPPET - 1).trimEnd()}…` : s);

/**
 * Hangs the conversation, the files and the "same problem" reports onto a page
 * of reports. `team` decides whether team notes are part of the thread.
 */
async function withThreads(raw: RawRow[], team: boolean): Promise<FeedbackRow[]> {
  if (!raw.length) return [];

  const ids = raw.map((r) => r.id);
  const messages = await db
    .select({
      id: feedbackMessages.id,
      feedbackId: feedbackMessages.feedbackId,
      body: feedbackMessages.body,
      statusTo: feedbackMessages.statusTo,
      internal: feedbackMessages.internal,
      authorId: feedbackMessages.authorId,
      authorName: users.name,
      authorRole: users.role,
      at: feedbackMessages.createdAt,
    })
    .from(feedbackMessages)
    .innerJoin(users, eq(users.id, feedbackMessages.authorId))
    .where(
      team
        ? inArray(feedbackMessages.feedbackId, ids)
        : and(inArray(feedbackMessages.feedbackId, ids), eq(feedbackMessages.internal, false)),
    )
    .orderBy(asc(feedbackMessages.createdAt));

  const dupes = await db
    .select({
      id: feedback.id,
      number: feedback.number,
      parentId: feedback.duplicateOfId,
      byId: feedback.userId,
      byName: users.name,
      body: feedback.body,
      path: feedback.path,
      createdAt: feedback.createdAt,
    })
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.userId))
    .where(inArray(feedback.duplicateOfId, ids))
    .orderBy(asc(feedback.createdAt));

  const fileOwners = [
    ...ids.map((id) => ["feedback", id] as const),
    ...dupes.map((d) => ["feedback", d.id] as const),
    ...messages.map((m) => ["feedback_message", m.id] as const),
  ];
  const files = new Map<string, AttachmentView[]>(
    await Promise.all(
      fileOwners.map(
        async ([type, id]) => [id, await listAttachments(type, id)] as [string, AttachmentView[]],
      ),
    ),
  );

  return raw.map((r) => {
    const also = dupes.filter((d) => d.parentId === r.id);
    const reporters = new Set([r.byId, ...also.map((d) => d.byId)]);

    const thread: FeedbackMessageView[] = messages
      .filter((m) => m.feedbackId === r.id)
      .map((m) => ({
        id: m.id,
        body: m.body,
        statusTo: (m.statusTo as FeedbackStatus | null) ?? null,
        internal: m.internal,
        authorId: m.authorId,
        authorName: m.authorName,
        authorRole: m.authorRole,
        fromSubmitter: reporters.has(m.authorId),
        at: m.at.toISOString(),
        attachments: files.get(m.id) ?? [],
      }));

    // What the reporter can read decides who owes whom — a team note is not
    // an answer, however much was written in it.
    const visible = thread.filter((m) => !m.internal);
    const last = visible[visible.length - 1];
    const awaitingReply = !last || last.fromSubmitter;
    const teamAsked = !!last && !last.fromSubmitter && !!last.body;
    const seen = visible.some((m) => !m.fromSubmitter) || r.status !== "new";

    const status = r.status as FeedbackStatus;
    const verdict = (r.verdict as FeedbackVerdict | null) ?? null;

    const lastAny = thread[thread.length - 1];
    const lastActivity = [r.createdAt, ...also.map((d) => d.createdAt)]
      .concat(lastAny ? [new Date(lastAny.at)] : [])
      .concat(r.verdictAt ? [r.verdictAt] : [])
      .reduce((a, b) => (b > a ? b : a));

    const lastSaid = [...visible].reverse().find((m) => m.body);

    return {
      id: r.id,
      number: r.number,
      ref: feedbackRef(r.number),
      kind: r.kind as FeedbackKind,
      title: r.title,
      body: r.body,
      path: r.path,
      app: r.app,
      userAgent: r.userAgent,
      status,
      impact: (r.impact as FeedbackImpact | null) ?? null,
      assigneeId: r.assigneeId,
      assigneeName: r.assigneeName,
      duplicateOfId: r.duplicateOfId,
      verdict,
      verdictAt: r.verdictAt ? r.verdictAt.toISOString() : null,
      byId: r.byId,
      byName: r.byName,
      byRole: r.byRole,
      handledByName: r.handledByName,
      handledAt: r.handledAt ? r.handledAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      attachments: files.get(r.id) ?? [],
      messages: thread,
      alsoReported: also.map((d) => ({
        id: d.id,
        ref: feedbackRef(d.number),
        byId: d.byId,
        byName: d.byName,
        body: d.body,
        path: d.path,
        createdAt: d.createdAt.toISOString(),
        attachments: files.get(d.id) ?? [],
      })),
      awaitingReply,
      teamAsked,
      seen,
      stage: feedbackStage({ status, seen, verdict }),
      queue: triageQueue({ status, awaitingReply, teamAsked }),
      lastActivityAt: lastActivity.toISOString(),
      lastLine: lastSaid?.body
        ? { who: lastSaid.authorName, text: snippet(lastSaid.body) }
        : null,
    };
  });
}

/* --------------------------------------------------------------- the console */

export type TriageFilter = {
  queue?: TriageQueue;
  app?: string;
  kind?: FeedbackKind;
  impact?: FeedbackImpact;
  /** A user id, "none" for nobody, or "mine-or-none" with `viewerId`. */
  assignee?: string;
  viewerId?: string;
  q?: string;
};

/**
 * Every report the console works, newest activity first — but never the ones
 * that only say "same problem as": those are read as part of the report they
 * point at, so a list showing both would count one problem twice.
 *
 * The queue is decided per row by `triageQueue`, the same function that draws
 * the counts, so a tab and its number can never disagree.
 */
export async function listFeedback(filter: TriageFilter = {}): Promise<FeedbackRow[]> {
  const q = filter.q?.trim();
  const refNumber = q?.match(/^fb-?(\d+)$/i)?.[1];
  const conditions = [
    isNull(feedback.duplicateOfId),
    filter.app ? eq(feedback.app, filter.app) : undefined,
    filter.kind ? eq(feedback.kind, filter.kind) : undefined,
    filter.impact ? eq(feedback.impact, filter.impact) : undefined,
    filter.assignee === "none"
      ? isNull(feedback.assigneeId)
      : filter.assignee === "mine-or-none" && filter.viewerId
        ? or(isNull(feedback.assigneeId), eq(feedback.assigneeId, filter.viewerId))
        : filter.assignee
          ? eq(feedback.assigneeId, filter.assignee)
          : undefined,
    refNumber
      ? eq(feedback.number, Number(refNumber))
      : q
        ? sql`(${feedback.title} ilike ${`%${q}%`} or ${feedback.body} ilike ${`%${q}%`} or ${users.name} ilike ${`%${q}%`})`
        : undefined,
  ].filter(Boolean);

  const raw = await db
    .select(rowShape())
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.userId))
    .where(and(...conditions))
    .orderBy(desc(feedback.createdAt))
    .limit(500);

  const rows = await withThreads(raw, true);
  const inQueue =
    !filter.queue || filter.queue === "all" ? rows : rows.filter((r) => r.queue === filter.queue);
  return inQueue.sort((a, b) => queueOrder(a, b, filter.queue));
}

const IMPACT_RANK: Record<string, number> = { blocking: 0, slows: 1, minor: 2 };

/**
 * Worst first where somebody is owed something — can't-work before slows-down,
 * then whoever has waited longest. Everywhere else, the newest activity first.
 */
function queueOrder(a: FeedbackRow, b: FeedbackRow, queue?: TriageQueue) {
  if (queue === "reply") {
    const ia = IMPACT_RANK[a.impact ?? ""] ?? 3;
    const ib = IMPACT_RANK[b.impact ?? ""] ?? 3;
    if (ia !== ib) return ia - ib;
    return a.lastActivityAt.localeCompare(b.lastActivityAt);
  }
  return b.lastActivityAt.localeCompare(a.lastActivityAt);
}

/** One thread in the team's view, or null. The caller decides who may read it. */
export async function getFeedback(id: string): Promise<FeedbackRow | null> {
  const raw = await db
    .select(rowShape())
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.userId))
    .where(eq(feedback.id, id))
    .limit(1);
  const [row] = await withThreads(raw, true);
  return row ?? null;
}

/* ---------------------------------------------------------- the reporter side */

/**
 * What one person has sent in, newest activity first, each with its whole
 * conversation as THEY may read it. A report they marked "same problem as"
 * shows the other report's status and thread, with their own words on top.
 */
export async function listMyFeedback(userId: string, limit = 50): Promise<MyFeedbackRow[]> {
  const mine = await db
    .select(rowShape())
    .from(feedback)
    .innerJoin(users, eq(users.id, feedback.userId))
    .where(eq(feedback.userId, userId))
    .orderBy(desc(feedback.createdAt))
    .limit(limit);
  if (!mine.length) return [];

  const parentIds = [...new Set(mine.map((r) => r.duplicateOfId).filter((x): x is string => !!x))];
  const parentsRaw = parentIds.length
    ? await db
        .select(rowShape())
        .from(feedback)
        .innerJoin(users, eq(users.id, feedback.userId))
        .where(inArray(feedback.id, parentIds))
    : [];

  const own = await withThreads(mine, false);
  const parents = new Map((await withThreads(parentsRaw, false)).map((p) => [p.id, p]));

  const rows: MyFeedbackRow[] = own.map((r, i) => {
    const readAt = mine[i].submitterReadAt?.toISOString() ?? "";
    const parent = r.duplicateOfId ? parents.get(r.duplicateOfId) : undefined;
    // Following another report: its status, its conversation, its verdict —
    // the reporter's own words, files and number stay theirs.
    const view: FeedbackRow = parent
      ? {
          ...parent,
          id: r.id,
          number: r.number,
          ref: r.ref,
          kind: r.kind,
          title: r.title,
          body: r.body,
          path: r.path,
          app: r.app,
          userAgent: r.userAgent,
          impact: r.impact,
          byId: r.byId,
          byName: r.byName,
          byRole: r.byRole,
          createdAt: r.createdAt,
          attachments: r.attachments,
          duplicateOfId: r.duplicateOfId,
        }
      : r;
    const unread = view.messages.filter(
      (m) => m.authorId !== userId && !m.fromSubmitter && m.at > readAt,
    ).length;
    return {
      ...view,
      sameAs: parent ? { id: parent.id, ref: parent.ref, title: parent.title } : null,
      unread,
    };
  });

  return rows.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/* ------------------------------------------------------------ "same problem" */

export type SimilarReport = {
  id: string;
  ref: string;
  title: string;
  app: string | null;
  path: string | null;
  status: FeedbackStatus;
  reporters: number;
  createdAt: string;
};

/**
 * Open reports that read like what somebody is typing — so the second person
 * to hit a fault adds their words to the first report instead of starting a
 * second conversation about the same thing.
 *
 * Trigram similarity, which `pg_trgm` already gives the product search: it
 * finds "outstanding wrong" against "the outstanding figure is wrong" without a
 * model, and costs nothing per keystroke. A report already pointing at another
 * is never offered — the chain is one level deep.
 */
export async function similarFeedback(text: string, limit = 3): Promise<SimilarReport[]> {
  const q = text.trim().slice(0, 400);
  if (q.length < 12) return [];

  const rows = await db.execute<{
    id: string;
    number: number;
    title: string;
    app: string | null;
    path: string | null;
    status: string;
    reporters: number;
    created_at: Date;
  }>(sql`
    select f.id, f.number, f.title, f.app, f.path, f.status, f.created_at,
           1 + (select count(*)::int from feedback d where d.duplicate_of_id = f.id) as reporters
      from feedback f
     where f.duplicate_of_id is null
       and f.status in ('new', 'in_progress')
       and greatest(
             word_similarity(f.title, ${q}),
             similarity(f.title || ' ' || f.body, ${q})
           ) > 0.32
     order by greatest(
                word_similarity(f.title, ${q}),
                similarity(f.title || ' ' || f.body, ${q})
              ) desc,
              f.created_at desc
     limit ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    ref: feedbackRef(Number(r.number)),
    title: r.title,
    app: r.app,
    path: r.path,
    status: r.status as FeedbackStatus,
    reporters: Number(r.reporters),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/* ------------------------------------------------------------------ who may */

// The rule itself lives in `feedback-access.ts` so attachments can ask it
// without importing this file. Re-exported here because every other reader
// comes through the service.
export { canSeeFeedback, canTriageFeedback, triagerIds } from "./feedback-access";

/** Everybody a report can be handed to: the people who may triage. */
export async function feedbackAssignees(): Promise<{ id: string; name: string }[]> {
  const ids = await triagerIds();
  if (!ids.length) return [];
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, ids))
    .orderBy(asc(users.name));
}

/* ------------------------------------------------------------------ counts */

export type FeedbackCounts = Record<Exclude<TriageQueue, "all">, number> & {
  total: number;
  /** Threads where triage owes the reporter. The console's nav badge. */
  awaitingReply: number;
};

/**
 * The console's tab counts and nav badge. Read through `listFeedback` rather
 * than a second SQL statement of the same rules: the queue of a report is
 * decided in exactly one function, and a count computed another way is a
 * count that disagrees with its own tab.
 */
export async function feedbackCounts(): Promise<FeedbackCounts> {
  const rows = await listFeedback();
  const counts: FeedbackCounts = {
    reply: 0,
    waiting: 0,
    looking: 0,
    closed: 0,
    total: rows.length,
    awaitingReply: 0,
  };
  for (const r of rows) counts[r.queue] += 1;
  counts.awaitingReply = counts.reply;
  return counts;
}

/** How many replies this person has not been shown yet — the header badge. */
export async function unreadFeedbackReplies(userId: string): Promise<number> {
  // A reply on the report they follow ("same problem as") is a reply to them.
  // Team notes are never theirs to read, so never counted.
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from feedback f
      join feedback_messages m on m.feedback_id = coalesce(f.duplicate_of_id, f.id)
     where f.user_id = ${userId}
       and m.internal = false
       and m.author_id <> ${userId}
       and m.author_id not in (
             select p.user_id from feedback p where p.id = coalesce(f.duplicate_of_id, f.id)
             union
             select d.user_id from feedback d where d.duplicate_of_id = coalesce(f.duplicate_of_id, f.id)
           )
       and m.created_at > coalesce(f.submitter_read_at, to_timestamp(0))
  `);
  return Number(row?.n ?? 0);
}

/* ---------------------------------------------------------------- overview */

export type FeedbackOverview = {
  periodDays: number;
  /** Open, and nobody on the team has said anything visible yet. */
  needsFirstReply: number;
  /** …of those, waiting more than a day. */
  firstReplyOverdue: number;
  open: number;
  beingLookedAt: number;
  /** Median hours from report to the team's first visible line, this period. */
  medianFirstReplyHours: number | null;
  confirmedFixed: number;
  stillHappening: number;
  openByApp: { app: string; n: number }[];
  topScreens: { path: string; reports: number; issues: number }[];
  waitingLongest: FeedbackRow[];
};

/**
 * An address with record ids taken out, so "/crm/customers/cus_8f2a…" and
 * "/crm/customers/cus_91be…" count as one screen.
 */
export function screenOf(path: string | null): string | null {
  if (!path) return null;
  const clean = path.split("?")[0].split("#")[0];
  return (
    clean
      .split("/")
      .map((seg) => (/\d/.test(seg) && (seg.includes("_") || seg.length > 12 || /^\d+$/.test(seg)) ? ":id" : seg))
      .join("/") || "/"
  );
}

/** The console's Feedback overview — what is owed, how fast, and where it hurts. */
export async function feedbackOverview(periodDays: number): Promise<FeedbackOverview> {
  const all = await listFeedback();
  const since = Date.now() - periodDays * 86_400_000;
  const open = all.filter((r) => r.status === "new" || r.status === "in_progress");

  const firstTeamLine = (r: FeedbackRow) =>
    r.messages.find((m) => !m.internal && !m.fromSubmitter)?.at ?? null;

  const unanswered = open.filter((r) => !firstTeamLine(r));
  const dayAgo = Date.now() - 86_400_000;

  const waits = all
    .filter((r) => Date.parse(r.createdAt) >= since)
    .map((r) => {
      const first = firstTeamLine(r);
      return first ? (Date.parse(first) - Date.parse(r.createdAt)) / 3_600_000 : null;
    })
    .filter((h): h is number => h !== null)
    .sort((a, b) => a - b);
  const median = waits.length
    ? waits.length % 2
      ? waits[(waits.length - 1) / 2]
      : (waits[waits.length / 2 - 1] + waits[waits.length / 2]) / 2
    : null;

  const verdictsInPeriod = all.filter((r) => r.verdictAt && Date.parse(r.verdictAt) >= since);

  const byApp = new Map<string, number>();
  for (const r of open) byApp.set(r.app ?? "other", (byApp.get(r.app ?? "other") ?? 0) + 1);

  const screens = new Map<string, { reports: number; issues: number }>();
  for (const r of all.filter((x) => Date.parse(x.createdAt) >= since)) {
    const s = screenOf(r.path);
    if (!s) continue;
    const cur = screens.get(s) ?? { reports: 0, issues: 0 };
    cur.issues += 1;
    cur.reports += 1 + r.alsoReported.length;
    screens.set(s, cur);
  }

  return {
    periodDays,
    needsFirstReply: unanswered.length,
    firstReplyOverdue: unanswered.filter((r) => Date.parse(r.createdAt) < dayAgo).length,
    open: open.length,
    beingLookedAt: open.filter((r) => r.status === "in_progress").length,
    medianFirstReplyHours: median,
    confirmedFixed: verdictsInPeriod.filter((r) => r.verdict === "fixed").length,
    stillHappening: verdictsInPeriod.filter((r) => r.verdict === "still_happening").length,
    openByApp: [...byApp.entries()]
      .map(([app, n]) => ({ app, n }))
      .sort((a, b) => b.n - a.n),
    topScreens: [...screens.entries()]
      .map(([path, v]) => ({ path, ...v }))
      .sort((a, b) => b.reports - a.reports)
      .slice(0, 6),
    waitingLongest: all
      .filter((r) => r.queue === "reply")
      .sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt))
      .slice(0, 5),
  };
}
