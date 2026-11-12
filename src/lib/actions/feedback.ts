"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { feedback, feedbackMessages, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { APP_IDS, type AppId } from "@/lib/apps";
import {
  bindAttachments,
  createAttachment,
  type ParentType,
} from "@/lib/services/attachment-service";
import {
  canSeeFeedback,
  canTriageFeedback,
  triagerIds,
} from "@/lib/services/feedback-access";
import {
  listMyFeedback,
  similarFeedback,
  unreadFeedbackReplies,
  type SimilarReport,
} from "@/lib/services/feedback-service";
import {
  FEEDBACK_IMPACTS,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  KIND_SHORT,
  STAGE_LABELS,
  STATUS_LABELS,
  feedbackRef,
  titleFromBody,
  type FeedbackStage,
  type FeedbackStatus,
  type FeedbackVerdict,
} from "@/lib/feedback-labels";
import { err as fail, ok, type Result } from "@/lib/result";
import { notifyUsers } from "../notify";
import { ADMIN } from "@/lib/admin-routes";

/* ---------------------------------------------------------------------------
 * Feedback from the people using MahekOne.
 *
 * Anybody signed in may write one — that is the entire point, and a form the
 * telecallers cannot reach is a form that only hears from managers. Triage is
 * a different question: changing a status, handing a report to somebody,
 * merging two, or writing a team note is saying something on the record, so
 * it is checked here rather than by hiding the control.
 *
 * A report is a CONVERSATION. Both sides write to the same thread, and each
 * side's message notifies the other. Silence is what teaches a team to stop
 * reporting.
 *
 * "SAME PROBLEM" is a report too. The second person to hit a fault writes
 * their own words and screenshot, and their report points at the first
 * (`duplicateOfId`). From then on they are on the reporter side of the first
 * report's conversation: every reply there reaches them, and anything they
 * add lands there.
 *
 * DONE CLOSES IT. Nobody waits for the reporter to confirm — Mahek's call, Nov
 * 2026. The reporter is told and asked; "yes" is recorded, "still happening"
 * reopens it and puts it back at the top of the queue.
 * ------------------------------------------------------------------------- */

const newId = (p = "fb") => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * Where a reporter reads one of their threads. `/feedback` sends them to the
 * Feedback page of an app they hold, so the notification works from every app
 * and opens inside one rather than on a page of its own.
 */
const threadHref = (rowId: string) => `/feedback?r=${rowId}`;
/** Where triage reads them. */
const triageHref = (rowId?: string) => (rowId ? `${ADMIN.feedback()}?r=${rowId}` : ADMIN.feedback());

const SubmitSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  /** Optional now: the first line of what they said becomes the heading. */
  title: z
    .string()
    .trim()
    .max(120, "Keep the heading under 120 characters; the detail goes below.")
    .optional(),
  body: z
    .string()
    .trim()
    .min(10, "Say a little more — what happened, or what you would like.")
    .max(4000, "That is longer than 4,000 characters. Trim it a little."),
  /** Only a fault is asked how much it is getting in the way. */
  impact: z.enum(FEEDBACK_IMPACTS).optional(),
  /** "Same problem — add mine to it": the report they are joining. */
  sameAsId: z.string().trim().max(40).optional(),
  /** Captured by the form from the address bar, never typed. */
  path: z.string().trim().max(300).optional(),
  userAgent: z.string().trim().max(400).optional(),
});

export type SubmitFeedbackInput = z.input<typeof SubmitSchema> & {
  /** Screenshots of the fault. Optional, and never able to fail the report. */
  images?: File[];
};

/**
 * Which app a path belongs to. `/crm/queue` → `crm`, `/apps` → the launcher.
 * Derived rather than asked: mid-shift nobody wants a dropdown for something
 * the address bar already knows.
 */
function appOfPath(path: string | undefined): AppId | "launcher" | null {
  if (!path) return null;
  const first = path.split("/").filter(Boolean)[0];
  if (!first) return null;
  if (first === "apps") return "launcher";
  return APP_IDS.includes(first as AppId) ? (first as AppId) : null;
}

/**
 * Stores the screenshots and binds them to whatever was just written. An
 * attachment never blocks a save: what did not make it is reported by count.
 */
async function attachImages(
  images: File[] | undefined,
  parentType: ParentType,
  parentId: string,
): Promise<{ wanted: number; attached: number }> {
  const wanted = images?.length ?? 0;
  if (!wanted) return { wanted: 0, attached: 0 };

  const results = await Promise.allSettled(
    images!.map(async (file) => {
      const created = await createAttachment({
        filename: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        declaredType: file.type,
      });
      if (!created.ok) throw new Error(created.error);
      return created.data.id;
    }),
  );
  const ids = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!ids.length) return { wanted, attached: 0 };

  const bound = await bindAttachments(ids, parentType, parentId);
  return { wanted, attached: bound.ok ? bound.data.bound : 0 };
}

function attachmentNote({ wanted, attached }: { wanted: number; attached: number }) {
  if (!wanted || attached === wanted) return null;
  return `${attached} of ${wanted} screenshot${wanted === 1 ? "" : "s"} attached.`;
}

/** The report a "same problem" points at — never a report that itself points elsewhere. */
async function rootOf(id: string): Promise<typeof feedback.$inferSelect | null> {
  const [row] = await db.select().from(feedback).where(eq(feedback.id, id)).limit(1);
  if (!row) return null;
  if (!row.duplicateOfId) return row;
  const [parent] = await db.select().from(feedback).where(eq(feedback.id, row.duplicateOfId)).limit(1);
  return parent ?? row;
}

/**
 * Everybody on the reporter side of one thread, each with THEIR OWN report's
 * id — the link in their notification opens their own row, which reads the
 * shared thread.
 */
async function reportersOf(rootId: string): Promise<{ userId: string; rowId: string }[]> {
  const rows = await db
    .select({ userId: feedback.userId, rowId: feedback.id })
    .from(feedback)
    .where(sql`${feedback.id} = ${rootId} or ${feedback.duplicateOfId} = ${rootId}`);
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.userId) ? false : (seen.add(r.userId), true)));
}

/* ------------------------------------------------------------------ submit */

/** Anybody signed in may send feedback. */
export async function submitFeedback(
  input: SubmitFeedbackInput,
): Promise<Result<{ id: string; ref: string; sameAs: string | null }>> {
  const user = await requireUser();

  const parsed = SubmitSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(first?.message ?? "That did not look right.", "validation", [
      { field: String(first?.path[0] ?? "body"), message: first?.message ?? "" },
    ]);
  }
  const value = parsed.data;

  const title = value.title?.trim() || titleFromBody(value.body);
  if (title.length < 4) {
    return fail("Start with a line that says what it is about.", "validation", [
      { field: "body", message: "Start with a line that says what it is about." },
    ]);
  }

  // Joining another report: always its root, and only one still open — a
  // closed report is not a conversation anybody is reading.
  let sameAs: typeof feedback.$inferSelect | null = null;
  if (value.sameAsId) {
    sameAs = await rootOf(value.sameAsId);
    if (!sameAs) return fail("That report is no longer here — send yours as new.", "not_found");
    if (sameAs.status === "done" || sameAs.status === "declined") {
      return fail("That report is closed — send yours as new.", "validation");
    }
  }

  const id = newId();
  const [row] = await db
    .insert(feedback)
    .values({
      id,
      userId: user.id,
      kind: value.kind,
      title,
      body: value.body,
      impact: value.kind === "bug" ? (value.impact ?? null) : null,
      duplicateOfId: sameAs?.id ?? null,
      path: value.path ?? null,
      app: appOfPath(value.path),
      userAgent: value.userAgent ?? null,
    })
    .returning({ number: feedback.number });

  const files = await attachImages(input.images, "feedback", id);
  const ref = feedbackRef(row.number);

  if (sameAs) {
    // The report gained a reporter — triage (and whoever holds it) hears that,
    // because "three people now" changes how urgent it is.
    await notifyTriagers({
      title: `${user.name} has the same problem`,
      body: `${feedbackRef(sameAs.number)} · ${sameAs.title}`,
      kind: "info",
      href: triageHref(sameAs.id),
      alsoUserId: sameAs.assigneeId,
    });
  } else {
    await notifyTriagers({
      title: `${KIND_SHORT[value.kind]} from ${user.name}`,
      body: files.attached
        ? `${ref} · ${title} · ${files.attached} screenshot${files.attached === 1 ? "" : "s"}`
        : `${ref} · ${title}`,
      kind: value.kind === "bug" ? "warn" : "info",
      href: triageHref(id),
    });
  }

  refresh();
  return ok(
    { id, ref, sameAs: sameAs ? feedbackRef(sameAs.number) : null },
    [
      sameAs
        ? `Added to ${feedbackRef(sameAs.number)} — you will hear every reply on it.`
        : `Sent as ${ref}.`,
      attachmentNote(files),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * Open reports that read like what somebody is typing, for the "someone
 * reported this already" card. Read-only, and quiet on failure — a similar
 * search that broke must never stop somebody sending.
 */
export async function similarReports(text: string): Promise<Result<SimilarReport[]>> {
  await requireUser();
  try {
    return ok(await similarFeedback(text));
  } catch {
    return ok([]);
  }
}

/* ------------------------------------------------------------------ triage */

/** Who may move a report along: a manager, or whoever holds the Admin app. */
async function triager() {
  const user = await requireUser();
  if (!(await canTriageFeedback(user))) {
    throw new Error("Only a manager can answer feedback.");
  }
  return user;
}

async function asTriager<T>(fn: (actor: Awaited<ReturnType<typeof triager>>) => Promise<Result<T>>) {
  let actor;
  try {
    actor = await triager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.", "not_permitted") as Result<T>;
  }
  return fn(actor);
}

export async function setFeedbackStatus(
  id: string,
  status: FeedbackStatus,
): Promise<Result<null>> {
  return asTriager(async (actor) => {
    if (!FEEDBACK_STATUSES.includes(status)) return fail("Not a status.");

    const row = await rootOf(id);
    if (!row) return fail("That report is no longer here.", "not_found");
    if (row.status === status) return ok(null, "No change.");

    await db.transaction(async (tx) => {
      await tx
        .update(feedback)
        .set({
          status,
          handledById: actor.id,
          handledAt: new Date(),
          updatedAt: new Date(),
          // Reopened: a verdict on the previous Done no longer describes it.
          ...(status === "done" ? {} : { verdict: null, verdictAt: null }),
        })
        .where(eq(feedback.id, row.id));

      // The decision is a line of the conversation, not a silent column change.
      await tx.insert(feedbackMessages).values({
        id: newId("fbm"),
        feedbackId: row.id,
        authorId: actor.id,
        body: null,
        statusTo: status,
      });
    });

    await notifyReporters(row.id, actor.id, (ref) => ({
      title:
        status === "done"
          ? `Done: ${row.title}`
          : `Your feedback: ${STATUS_LABELS[status]}`,
      body:
        status === "done"
          ? `${ref} · Can you check it is fixed for you?`
          : `${ref} · ${row.title}`,
      kind: status === "declined" ? "warn" : status === "done" ? "success" : "info",
    }));

    refresh();
    return ok(null, `Marked ${STATUS_LABELS[status].toLowerCase()}.`);
  });
}

/** Hands a report to somebody on the team, or to nobody. */
export async function assignFeedback(
  id: string,
  assigneeId: string | null,
): Promise<Result<null>> {
  return asTriager(async (actor) => {
    const row = await rootOf(id);
    if (!row) return fail("That report is no longer here.", "not_found");
    if (assigneeId) {
      const allowed = await triagerIds();
      if (!allowed.includes(assigneeId)) {
        return fail("A report can only be handed to somebody who can answer feedback.");
      }
    }
    if ((row.assigneeId ?? null) === assigneeId) return ok(null, "No change.");

    await db
      .update(feedback)
      .set({ assigneeId, updatedAt: new Date() })
      .where(eq(feedback.id, row.id));

    if (assigneeId && assigneeId !== actor.id) {
      await notifyUsers([
        {
          userId: assigneeId,
          title: `${actor.name} handed you a report`,
          body: `${feedbackRef(row.number)} · ${row.title}`,
          kind: "info",
          href: triageHref(row.id),
        },
      ]);
    }
    refresh();
    return ok(null, assigneeId ? "Handed over." : "Nobody is holding it now.");
  });
}

/**
 * "Same problem as" from the console: this report joins `intoId`, or — with
 * null — stands on its own again. Whoever reported it is told where the
 * conversation is now; anybody who had joined IT moves with it, because a
 * chain two deep is a thread nobody can find.
 */
export async function mergeFeedback(
  id: string,
  /** The report it is the same as — "FB-1038", "1038" or its id — or null to separate. */
  intoId: string | null,
): Promise<Result<null>> {
  return asTriager(async (actor) => {
    const [row] = await db.select().from(feedback).where(eq(feedback.id, id)).limit(1);
    if (!row) return fail("That report is no longer here.", "not_found");

    if (!intoId) {
      if (!row.duplicateOfId) return ok(null, "It already stands on its own.");
      await db.update(feedback).set({ duplicateOfId: null, updatedAt: new Date() }).where(eq(feedback.id, id));
      refresh();
      return ok(null, "Separated — it is its own report again.");
    }

    // Typed as "FB-1038", "1038" or an id — triage reads numbers, not ids.
    const number = intoId.trim().match(/^(?:fb-?)?(\d+)$/i)?.[1];
    let intoRowId = intoId.trim();
    if (number) {
      const [hit] = await db
        .select({ id: feedback.id })
        .from(feedback)
        .where(eq(feedback.number, Number(number)))
        .limit(1);
      if (!hit) return fail(`There is no FB-${number}.`, "not_found");
      intoRowId = hit.id;
    }
    const into = await rootOf(intoRowId);
    if (!into) return fail("There is no report by that number.", "not_found");
    if (into.id === id) return fail("A report cannot be the same as itself.");

    await db.transaction(async (tx) => {
      await tx
        .update(feedback)
        .set({ duplicateOfId: into.id, updatedAt: new Date() })
        .where(eq(feedback.id, id));
      await tx
        .update(feedback)
        .set({ duplicateOfId: into.id, updatedAt: new Date() })
        .where(eq(feedback.duplicateOfId, id));
      await tx.insert(feedbackMessages).values({
        id: newId("fbm"),
        feedbackId: into.id,
        authorId: actor.id,
        body: `${feedbackRef(row.number)} from ${await nameOf(row.userId)} is the same problem — merged into this one.`,
        internal: true,
      });
    });

    await notifyUsers(
      (await reportersOf(into.id))
        .filter((r) => r.userId === row.userId || r.rowId === id)
        .map((r) => ({
          userId: r.userId,
          title: "Your report joined another one",
          body: `${feedbackRef(row.number)} is the same problem as ${feedbackRef(into.number)} — every reply there reaches you.`,
          kind: "info",
          href: threadHref(r.rowId),
          mbosHref: "/notifications",
        })),
    );

    refresh();
    return ok(null, `Merged into ${feedbackRef(into.number)}.`);
  });
}

async function nameOf(userId: string) {
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.name ?? "somebody";
}

/* -------------------------------------------------------------- the thread */

const ReplySchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Write something first.")
    .max(2000, "That reply is too long — 2,000 characters is the limit."),
});

/**
 * A line of the conversation, from either side — or, from triage, a team note
 * (`internal`) that the reporter never reads and is never told about.
 *
 * A reporter who joined another report writes on THAT one: they read it as
 * their own, so what they add belongs where the team is reading.
 */
export async function replyToFeedback(input: {
  id: string;
  body: string;
  images?: File[];
  internal?: boolean;
}): Promise<Result<{ id: string }>> {
  const user = await requireUser();

  const root = await rootOf(input.id);
  if (!root) return fail("That report is no longer here.", "not_found");

  if (!(await canSeeFeedback(user, root.id))) {
    return fail("That report is not yours to answer.", "not_permitted");
  }
  const reporters = await reportersOf(root.id);
  const fromSubmitter = reporters.some((r) => r.userId === user.id);

  if (input.internal && !(await canTriageFeedback(user))) {
    return fail("Only the team can write a team note.", "not_permitted");
  }
  const internal = !!input.internal;

  const parsed = ReplySchema.safeParse({ body: input.body });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(first?.message ?? "Write something first.", "validation", [
      { field: "body", message: first?.message ?? "" },
    ]);
  }

  const messageId = newId("fbm");
  await db.transaction(async (tx) => {
    await tx.insert(feedbackMessages).values({
      id: messageId,
      feedbackId: root.id,
      authorId: user.id,
      body: parsed.data.body,
      internal,
    });

    if (fromSubmitter) {
      // Their own reply is read by definition — they just wrote it.
      await tx
        .update(feedback)
        .set({ submitterReadAt: new Date(), updatedAt: new Date() })
        .where(and(eq(feedback.userId, user.id), sql`(${feedback.id} = ${root.id} or ${feedback.duplicateOfId} = ${root.id})`));
    } else if (!internal) {
      await tx
        .update(feedback)
        .set({ handledById: user.id, handledAt: new Date(), updatedAt: new Date() })
        .where(eq(feedback.id, root.id));
    }
  });

  const files = await attachImages(input.images, "feedback_message", messageId);
  const ref = feedbackRef(root.number);

  if (internal) {
    // A team note reaches whoever is holding the report, and nobody else.
    if (root.assigneeId && root.assigneeId !== user.id) {
      await notifyUsers([
        {
          userId: root.assigneeId,
          title: `Team note on ${ref}`,
          body: `${user.name}: ${parsed.data.body.slice(0, 140)}`,
          kind: "info",
          href: triageHref(root.id),
        },
      ]);
    }
  } else if (fromSubmitter) {
    await notifyTriagers({
      title: `${user.name} replied on ${ref}`,
      body: `${root.title}${files.attached ? ` · ${files.attached} screenshot${files.attached === 1 ? "" : "s"}` : ""}`,
      kind: "info",
      href: triageHref(root.id),
      onlyUserId: root.assigneeId,
    });
  } else {
    await notifyReporters(root.id, user.id, (r) => ({
      title: `${user.name} replied to your feedback`,
      body: `${r} · ${parsed.data.body.slice(0, 140)}`,
      kind: "info",
    }));
  }

  refresh();
  return ok(
    { id: messageId },
    [
      internal ? "Team note saved." : fromSubmitter ? "Sent." : "Reply sent — they are notified.",
      attachmentNote(files),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * The reporter's answer once a report is Done. "Fixed" is recorded and thanks
 * the team; "still happening" REOPENS it, puts it back in the team's
 * "Needs a reply" queue and tells whoever is holding it — which is the only
 * reason the question is asked at all.
 */
export async function answerFix(input: {
  id: string;
  verdict: FeedbackVerdict;
  note?: string;
}): Promise<Result<null>> {
  const user = await requireUser();
  const root = await rootOf(input.id);
  if (!root) return fail("That report is no longer here.", "not_found");
  const reporters = await reportersOf(root.id);
  if (!reporters.some((r) => r.userId === user.id)) {
    return fail("Only the person who reported it can answer that.", "not_permitted");
  }
  if (root.status !== "done") return fail("It is not marked done yet.", "validation");
  if (input.verdict !== "fixed" && input.verdict !== "still_happening") return fail("Not an answer.");

  const note = input.note?.trim().slice(0, 2000) || null;
  const still = input.verdict === "still_happening";

  await db.transaction(async (tx) => {
    await tx
      .update(feedback)
      .set({
        verdict: input.verdict,
        verdictAt: new Date(),
        submitterReadAt: new Date(),
        updatedAt: new Date(),
        ...(still ? { status: "in_progress" as const } : {}),
      })
      .where(eq(feedback.id, root.id));
    await tx.insert(feedbackMessages).values({
      id: newId("fbm"),
      feedbackId: root.id,
      authorId: user.id,
      body: note ?? (still ? "It is still happening." : "Confirmed — it is fixed for me."),
      statusTo: still ? "in_progress" : null,
    });
  });

  await notifyTriagers({
    title: still ? `Still happening: ${root.title}` : `Confirmed fixed: ${root.title}`,
    body: `${feedbackRef(root.number)} · ${user.name}${note ? ` — ${note.slice(0, 120)}` : ""}`,
    kind: still ? "warn" : "success",
    href: triageHref(root.id),
    onlyUserId: still ? null : root.assigneeId ?? root.handledById,
  });

  refresh();
  return ok(null, still ? "Reopened — the team is told." : "Thank you — recorded as fixed.");
}

/**
 * Marks a reporter's threads as read up to now. The dot on the Feedback button
 * counts replies written after this stamp, and a dot that never clears is a
 * dot people stop looking at.
 */
export async function markFeedbackRead(id?: string): Promise<Result<null>> {
  const user = await requireUser();
  await db
    .update(feedback)
    .set({ submitterReadAt: new Date() })
    .where(
      id
        ? and(eq(feedback.id, id), eq(feedback.userId, user.id))
        : eq(feedback.userId, user.id),
    );
  return ok(null);
}

export type FeedbackSummaryItem = {
  id: string;
  ref: string;
  title: string;
  stage: FeedbackStage;
  stageLabel: string;
  unread: number;
  lastLine: { who: string; text: string } | null;
  lastActivityAt: string;
};

/**
 * What this person has sent in and what has come back — the count on the
 * Feedback button and the "What you've sent" part of its menu. Read by the
 * button itself rather than plumbed through a dozen app shells.
 */
export async function myFeedbackSummary(): Promise<
  Result<{ total: number; unreadReplies: number; recent: FeedbackSummaryItem[] }>
> {
  const user = await requireUser();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(feedback)
    .where(eq(feedback.userId, user.id));

  const total = Number(row?.n ?? 0);
  const recent = total ? (await listMyFeedback(user.id, 6)).slice(0, 3) : [];

  return ok({
    total,
    unreadReplies: total ? await unreadFeedbackReplies(user.id) : 0,
    recent: recent.map((r) => ({
      id: r.id,
      ref: r.ref,
      title: r.title,
      stage: r.stage,
      stageLabel: STAGE_LABELS[r.stage],
      unread: r.unread,
      lastLine: r.lastLine,
      lastActivityAt: r.lastActivityAt,
    })),
  });
}

/* ---------------------------------------------------------------- notifying */

/**
 * Tells the people who may triage. `onlyUserId` narrows it to whoever is
 * holding the report, when somebody is; `alsoUserId` adds one person to the
 * whole set. Nobody is told about something they did themselves.
 */
async function notifyTriagers(note: {
  title: string;
  body: string;
  kind: string;
  href: string;
  onlyUserId?: string | null;
  alsoUserId?: string | null;
}) {
  const actor = await requireUser().catch(() => null);
  const ids = note.onlyUserId
    ? [note.onlyUserId]
    : [...new Set([...(await triagerIds()), ...(note.alsoUserId ? [note.alsoUserId] : [])])];
  const targets = ids.filter((id) => id !== actor?.id);
  if (!targets.length) return;

  await notifyUsers(
    targets.map((userId) => ({
      userId,
      title: note.title,
      body: note.body,
      kind: note.kind,
      href: note.href,
    })),
  );
}

/**
 * Tells everybody on the reporter side of a thread — the person who wrote it
 * and everybody who said "same problem" — each linked to THEIR OWN report,
 * which is where they read it. The field team included: the reply is the half
 * that has to reach them, so it goes to the handset's bell too.
 */
async function notifyReporters(
  rootId: string,
  actorId: string,
  note: (ref: string) => { title: string; body: string; kind: string },
) {
  const reporters = (await reportersOf(rootId)).filter((r) => r.userId !== actorId);
  if (!reporters.length) return;
  const numbers = await db
    .select({ id: feedback.id, number: feedback.number })
    .from(feedback)
    .where(inArray(feedback.id, reporters.map((r) => r.rowId)));
  const refOf = new Map(numbers.map((n) => [n.id, feedbackRef(n.number)]));

  await notifyUsers(
    reporters.map((r) => {
      const n = note(refOf.get(r.rowId) ?? "");
      return {
        userId: r.userId,
        title: n.title,
        body: n.body,
        kind: n.kind,
        href: threadHref(r.rowId),
        mbosHref: "/notifications",
      };
    }),
  );
}

function refresh() {
  try {
    revalidatePath("/", "layout");
  } catch {
    /* outside a request, which is fine */
  }
}
