"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { feedback, notifications, users } from "@/db/schema";
import { requireUser, isManager } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { APP_IDS, type AppId } from "@/lib/apps";
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
 * ------------------------------------------------------------------------- */

const newId = () => `fb_${randomUUID().slice(0, 12)}`;

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

export type SubmitFeedbackInput = z.input<typeof SubmitSchema>;

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

  // Whoever triages it is told. A report that only exists on a screen nobody
  // has open is a report that waits for somebody to go looking for it.
  await notifyTriage(user.name, value.kind, value.title);

  refresh();
  return ok(
    { id },
    value.kind === "bug"
      ? "Thank you — that is logged, with the screen you were on."
      : "Thank you — that is logged and will be read.",
  );
}

/** Who may move a report along: a manager, or whoever holds the Admin app. */
async function triager() {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!isManager(user) && !apps.includes("admin")) {
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

  await db
    .update(feedback)
    .set({
      status,
      handledById: actor.id,
      handledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(feedback.id, id));

  // The person who wrote it hears the answer. Being told "not doing" is worth
  // far more than silence, which is what teaches people to stop reporting.
  await db.insert(notifications).values({
    id: `ntf_${randomUUID().slice(0, 12)}`,
    userId: row.userId,
    title: `Your feedback: ${STATUS_LABELS[status]}`,
    body: row.title,
    kind: status === "declined" ? "warn" : "info",
  });

  refresh();
  return ok(null, `Marked ${STATUS_LABELS[status].toLowerCase()}.`);
}

/** The reply whoever triaged it wrote. Shown to the submitter, so it is theirs. */
export async function setFeedbackNote(id: string, note: string): Promise<Result<null>> {
  let actor;
  try {
    actor = await triager();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }

  const trimmed = note.trim();
  if (trimmed.length > 2000) return fail("That reply is too long.");

  const [row] = await db.select().from(feedback).where(eq(feedback.id, id)).limit(1);
  if (!row) return fail("That report is no longer here.", "not_found");

  await db
    .update(feedback)
    .set({
      adminNote: trimmed || null,
      handledById: actor.id,
      handledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(feedback.id, id));

  refresh();
  return ok(null, trimmed ? "Reply saved." : "Reply cleared.");
}

/**
 * Everybody who can open the Admin Console hears about a new report.
 *
 * One insert per triager rather than a broadcast table: notifications are per
 * user here, and a workspace this size makes that a handful of rows.
 */
async function notifyTriage(from: string, kind: FeedbackKind, title: string) {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.role, ["manager", "admin"]), eq(users.active, true)));

  const ids = rows.map((u) => u.id);
  if (!ids.length) return;

  await db.insert(notifications).values(
    ids.map((userId) => ({
      id: `ntf_${randomUUID().slice(0, 12)}`,
      userId,
      title: `${KIND_SHORT[kind]} from ${from}`,
      body: title,
      kind: kind === "bug" ? "warn" : "info",
      href: "/admin/feedback",
    })),
  );
}

function refresh() {
  try {
    revalidatePath("/admin");
    revalidatePath("/admin/feedback");
  } catch {
    /* outside a request, which is fine */
  }
}
