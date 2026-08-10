"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { appAccess, feedback, feedbackMessages, notifications, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { APP_IDS, type AppId } from "@/lib/apps";
import {
  bindAttachments,
  createAttachment,
  type ParentType,
} from "@/lib/services/attachment-service";
import { canSeeFeedback, canTriageFeedback } from "@/lib/services/feedback-access";
import { unreadFeedbackReplies } from "@/lib/services/feedback-service";
import {
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  KIND_SHORT,
  STATUS_LABELS,
  type FeedbackKind,
  type FeedbackStatus,
} from "@/lib/feedback-labels";
import { err as fail, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Feedback from the people using MahekOne.
 *
 * Anybody signed in may write one — that is the entire point, and a form the
 * telecallers cannot reach is a form that only hears from managers. Triage is
 * a different question: changing a status is saying something back to a
 * colleague on the record, so it is checked here rather than by hiding the
 * control.
 *
 * A report is a CONVERSATION. It used to be a row with one overwritable note
 * on it: a second answer erased the first, and the person who wrote the report
 * had no way to say "that is not quite it" — which, for a bug report, is
 * usually the sentence that solves it. Both sides write to the same thread,
 * and each side's message notifies the other. Silence is what teaches a team
 * to stop reporting things.
 * ------------------------------------------------------------------------- */

const newId = (p = "fb") => `${p}_${randomUUID().slice(0, 12)}`;

/** Where the submitter reads their threads. Every notification to them lands here. */
const THREAD_HREF = "/feedback";
/** Where triage reads them. */
const TRIAGE_HREF = "/admin/feedback";

const SubmitSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  title: z
    .string()
    .trim()
    .min(4, "Give it a short heading — a few words is enough.")
    .max(120, "Keep the heading under 120 characters; the detail goes below."),
  body: z
    .string()
    .trim()
    .min(10, "Say a little more — what happened, or what you would like.")
    .max(4000, "That is longer than 4,000 characters. Trim it a little."),
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
 *
 * Derived rather than asked: mid-shift nobody wants a dropdown for something
 * the address bar already knows, and an answer typed by hand is one that goes
 * wrong exactly when the report matters.
 */
function appOfPath(path: string | undefined): AppId | "launcher" | null {
  if (!path) return null;
  const first = path.split("/").filter(Boolean)[0];
  if (!first) return null;
  if (first === "apps") return "launcher";
  return APP_IDS.includes(first as AppId) ? (first as AppId) : null;
}

/**
 * Stores the screenshots and binds them to whatever was just written.
 *
 * §4.2 — an attachment never blocks a save. The report is already in the
 * database by the time this runs; a dead uploader must not take somebody's bug
 * report down with it, so what did not make it is reported by count rather
 * than thrown.
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

/** The sentence to add when some files did not make it. Nothing to say when they all did. */
function attachmentNote({ wanted, attached }: { wanted: number; attached: number }) {
  if (!wanted || attached === wanted) return null;
  return `${attached} of ${wanted} screenshot${wanted === 1 ? "" : "s"} attached.`;
}

/** Anybody signed in may send feedback. */
export async function submitFeedback(
  input: SubmitFeedbackInput,
): Promise<Result<{ id: string }>> {
  const user = await requireUser();

  const parsed = SubmitSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(first?.message ?? "That did not look right.", "validation", [
      { field: String(first?.path[0] ?? "body"), message: first?.message ?? "" },
    ]);
  }
  const value = parsed.data;

  const id = newId();
  await db.insert(feedback).values({
    id,
    userId: user.id,
    kind: value.kind,
    title: value.title,
    body: value.body,
    path: value.path ?? null,
    app: appOfPath(value.path),
    userAgent: value.userAgent ?? null,
  });

  const files = await attachImages(input.images, "feedback", id);

  // Whoever triages it is told. A report that only exists on a screen nobody
  // has open is a report that waits for somebody to go looking for it.
  await notifyTriage(user.name, value.kind, value.title, files.attached);

  refresh();
  return ok(
    { id },
    [
      value.kind === "bug"
        ? "Thank you — that is logged, with the screen you were on."
        : "Thank you — that is logged and will be read.",
      attachmentNote(files),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/** Who may move a report along: a manager, or whoever holds the Admin app. */
async function triager() {
  const user = await requireUser();
  if (!(await canTriageFeedback(user))) {
    throw new Error("Only a manager can answer feedback.");
  }
  return user;
}

export async function setFeedbackStatus(
  id: string,
  status: FeedbackStatus,
): Promise<Result<null>> {
  let actor;
  try {
    actor = await triager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }
  if (!FEEDBACK_STATUSES.includes(status)) return fail("Not a status.");

  const [row] = await db.select().from(feedback).where(eq(feedback.id, id)).limit(1);
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
      })
      .where(eq(feedback.id, id));

    // The decision is a line of the conversation, not a silent column change.
    // A thread showing the reply but not the "not doing" beside it would make
    // somebody read two screens to find out what happened to their report.
    await tx.insert(feedbackMessages).values({
      id: newId("fbm"),
      feedbackId: id,
      authorId: actor.id,
      body: null,
      statusTo: status,
    });
  });

  // The person who wrote it hears the answer. Being told "not doing" is worth
  // far more than silence, which is what teaches people to stop reporting.
  await notifySubmitter(row.userId, {
    title: `Your feedback: ${STATUS_LABELS[status]}`,
    body: row.title,
    kind: status === "declined" ? "warn" : "info",
  });

  refresh();
  return ok(null, `Marked ${STATUS_LABELS[status].toLowerCase()}.`);
}

const ReplySchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Write something first.")
    .max(2000, "That reply is too long — 2,000 characters is the limit."),
});

/**
 * A line of the conversation, from either side.
 *
 * Both directions come through one action because they are the same act: the
 * two branches are who is allowed to write it and who gets told about it, and
 * splitting that into a reply action and an answer action would give the same
 * conversation two sets of rules about length, files and notification.
 */
export async function replyToFeedback(input: {
  id: string;
  body: string;
  images?: File[];
}): Promise<Result<{ id: string }>> {
  const user = await requireUser();

  const [row] = await db
    .select()
    .from(feedback)
    .where(eq(feedback.id, input.id))
    .limit(1);
  if (!row) return fail("That report is no longer here.", "not_found");

  // A report can name a customer, a figure or a colleague. Only the two sides
  // of it may read the thread, and only they may add to it.
  if (!(await canSeeFeedback(user, input.id))) {
    return fail("That report is not yours to answer.", "not_permitted");
  }
  const fromSubmitter = row.userId === user.id;

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
      feedbackId: input.id,
      authorId: user.id,
      body: parsed.data.body,
    });

    await tx
      .update(feedback)
      .set(
        fromSubmitter
          ? // Their own reply is read by definition — they just wrote it.
            { submitterReadAt: new Date(), updatedAt: new Date() }
          : { handledById: user.id, handledAt: new Date(), updatedAt: new Date() },
      )
      .where(eq(feedback.id, input.id));
  });

  const files = await attachImages(input.images, "feedback_message", messageId);

  if (fromSubmitter) {
    // Triage hears it, because a question added to a thread nobody has open is
    // a question nobody answers.
    await notifyTriagers({
      title: `${row.title}`,
      body: `${user.name} replied${files.attached ? ` · ${files.attached} screenshot${files.attached === 1 ? "" : "s"}` : ""}`,
      kind: "info",
      href: TRIAGE_HREF,
    });
  } else {
    await notifySubmitter(row.userId, {
      title: `${user.name} replied to your feedback`,
      body: row.title,
      kind: "info",
    });
  }

  refresh();
  return ok(
    { id: messageId },
    [fromSubmitter ? "Sent." : "Reply sent — they are notified.", attachmentNote(files)]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * Marks a submitter's threads as read up to now.
 *
 * Called when they open their own feedback screen — the dot on the Feedback
 * button counts replies written after this stamp, and a dot that never clears
 * is a dot people stop looking at.
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

/**
 * What this person has sent in and what has come back, for the dialog they
 * send it from.
 *
 * Read when the dialog opens rather than plumbed through five app shells: the
 * Feedback button is mounted by the CRM header, the Accounts shell, the HRMS
 * header, the launcher and the feedback page itself, and threading a count
 * through all of them to render a dot is a lot of layout code for a number
 * nobody sees until they open the dialog anyway.
 */
export async function myFeedbackSummary(): Promise<
  Result<{ total: number; unreadReplies: number }>
> {
  const user = await requireUser();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(feedback)
    .where(eq(feedback.userId, user.id));

  return ok({
    total: Number(row?.n ?? 0),
    unreadReplies: await unreadFeedbackReplies(user.id),
  });
}

/**
 * Everybody who can open the Admin Console hears about a new report.
 *
 * One insert per triager rather than a broadcast table: notifications are per
 * user here, and a workspace this size makes that a handful of rows.
 */
async function notifyTriage(
  from: string,
  kind: FeedbackKind,
  title: string,
  screenshots: number,
) {
  await notifyTriagers({
    title: `${KIND_SHORT[kind]} from ${from}`,
    body: screenshots
      ? `${title} · ${screenshots} screenshot${screenshots === 1 ? "" : "s"}`
      : title,
    kind: kind === "bug" ? "warn" : "info",
    href: TRIAGE_HREF,
  });
}

async function notifyTriagers(note: {
  title: string;
  body: string;
  kind: string;
  href: string;
}) {
  // Exactly the people `canTriageFeedback` lets in: managers, and whoever
  // holds the Admin app. Notifying a narrower set than the one allowed to
  // answer is how a report sits unread in front of the person who could have
  // answered it.
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .leftJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "admin")))
    .where(
      and(
        eq(users.active, true),
        or(
          sql`${users.role} in ('manager', 'admin')`,
          sql`${appAccess.id} is not null`,
        ),
      ),
    );

  const ids = rows.map((u) => u.id);
  if (!ids.length) return;

  await db.insert(notifications).values(
    ids.map((userId) => ({
      id: newId("ntf"),
      userId,
      title: note.title,
      body: note.body,
      kind: note.kind,
      href: note.href,
    })),
  );
}

/**
 * The reply lands in the notification bell of whoever wrote the report, and it
 * carries a link. A notification saying somebody answered, with nowhere to go
 * and read the answer, is the shape this had before threads existed.
 */
async function notifySubmitter(
  userId: string,
  note: { title: string; body: string; kind: string },
) {
  await db.insert(notifications).values({
    id: newId("ntf"),
    userId,
    title: note.title,
    body: note.body,
    kind: note.kind,
    href: THREAD_HREF,
  });
}

function refresh() {
  try {
    revalidatePath("/admin");
    revalidatePath("/admin/feedback");
    revalidatePath("/feedback");
  } catch {
    /* outside a request, which is fine */
  }
}
