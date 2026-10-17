import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { websiteAssignment, websiteReviewSetting } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import type { User } from "@/db/schema";
import { err, type Err } from "@/lib/result";
import {
  KINDS,
  MODULE_SLUGS,
  PUBLISH_MODULE_KEY,
  REVIEW_MODULE_KEY,
  moduleKeyFor,
  type KindKey,
} from "./kinds";
import { anyAssignmentCovers, hasKindWideAssignment, type AssignmentLike } from "./review-status";

/* ---------------------------------------------------------------------------
 * WHO MAY DO WHAT TO THE WEBSITE'S CONTENT — checked on the SERVER, by every
 * action and route, from the same module grant the sidebar is drawn from.
 *
 *   editing a kind     → the Website module that owns it (`website.products`…)
 *                        and, WHEN ASSIGNMENTS ARE ENFORCED, an assignment that
 *                        covers the item
 *   uploading images   → any Website module that edits content
 *   publishing / live  → `website.publish`, which is explicit-only: never implied
 *   reviewing          → `website.review`, explicit-only too: assigning work,
 *                        deciding submissions, changing the enforcement setting
 *
 * A hidden button is a courtesy. These are the checks. They return the shared
 * error shape rather than redirecting, because a server action has no page to
 * redirect from and a refusal must reach the screen as a message.
 *
 * ASSIGNMENTS ARE OFF UNTIL SOMEBODY TURNS THEM ON (`website_review_setting`),
 * so on the day this shipped nobody who could edit lost that. Turned on, an
 * editor who holds neither `website.publish` nor `website.review` can touch only
 * what they were assigned; holders of those two keep editing directly, exactly
 * as before.
 * ------------------------------------------------------------------------- */

/**
 * `actor` is on a refusal so a caller can record WHO was turned away: a denied
 * attempt is worth an audit row, and the gate is the only place that knows the
 * person it just refused.
 */
export type Gate = { user: User; error: null } | { user: null; error: Err; actor?: User };

const refuse = (what: string, actor?: User): Gate => ({
  user: null,
  error: err(`You do not have access to ${what}.`, "not_permitted"),
  actor,
});

/* ----------------------------------------------------------- the setting */

/**
 * Whether assignments are enforced. A MISSING row means off — the migration
 * inserts it, but a table truncated with `users` (the row points at one) or a
 * database restored without it must not turn enforcement on by accident, which
 * would lock every editor out at once.
 */
export async function assignmentsEnforced(): Promise<boolean> {
  const [row] = await db
    .select({ on: websiteReviewSetting.enforceAssignments })
    .from(websiteReviewSetting)
    .where(eq(websiteReviewSetting.id, "site"))
    .limit(1);
  return row?.on === true;
}

/* -------------------------------------------------------------- holdings */

export function holdsPublish(userId: string): Promise<boolean> {
  return canOpenModule(userId, PUBLISH_MODULE_KEY);
}

export function holdsReview(userId: string): Promise<boolean> {
  return canOpenModule(userId, REVIEW_MODULE_KEY);
}

/** Holders of `website.publish` or `website.review` edit directly, whatever the setting says. */
export async function isDirectEditor(userId: string): Promise<boolean> {
  return (await holdsPublish(userId)) || (await holdsReview(userId));
}

export async function activeAssignments(userId: string): Promise<AssignmentLike[]> {
  return db
    .select({ kind: websiteAssignment.kind, contentId: websiteAssignment.contentId, revokedAt: websiteAssignment.revokedAt })
    .from(websiteAssignment)
    .where(and(eq(websiteAssignment.employeeId, userId), isNull(websiteAssignment.revokedAt)));
}

/* ------------------------------------------------------------------ gates */

/**
 * What an edit is aimed at. Required, never defaulted: an edit gate that can be
 * asked "may this person edit products" without saying WHICH is how an
 * assignment gets skipped.
 *
 *   item      — an existing row, named by its id (its kind comes from the row);
 *   create    — a new item of the kind: no row to name, so only a kind-wide
 *               assignment covers it;
 *   kindWide  — an act on the whole list (reordering);
 *   any       — looking at the kind at all (a preview of its page).
 */
export type EditScope = { item: string } | { create: true } | { kindWide: true } | { any: true };

export async function gateEdit(kind: KindKey, scope: EditScope): Promise<Gate> {
  const user = await requireUser();
  if (!(await canOpenModule(user.id, moduleKeyFor(kind)))) {
    return refuse(`edit ${KINDS[kind].plural} on the website`);
  }
  if (!(await assignmentsEnforced())) return { user, error: null };
  if (await isDirectEditor(user.id)) return { user, error: null };

  const mine = await activeAssignments(user.id);
  const covered =
    "item" in scope
      ? anyAssignmentCovers(mine, { kind, contentId: scope.item })
      : "create" in scope || "kindWide" in scope
        ? hasKindWideAssignment(mine, kind)
        : mine.some((a) => a.kind === kind);
  if (covered) return { user, error: null };

  const what =
    "item" in scope
      ? `edit this ${KINDS[kind].noun}`
      : "create" in scope
        ? `add ${KINDS[kind].plural}`
        : "kindWide" in scope
          ? `reorder ${KINDS[kind].plural}`
          : `work on ${KINDS[kind].plural}`;
  return {
    user: null,
    error: err(`You have not been assigned to ${what}. Ask the person who assigns website work to give it to you.`, "not_permitted"),
    actor: user,
  };
}

/** Somebody who holds at least one Website content module — enough to add an image. */
export async function gateAnyEdit(): Promise<Gate> {
  const user = await requireUser();
  if (await canEditAny(user.id)) return { user, error: null };
  return refuse("the website's images");
}

export async function gatePublish(): Promise<Gate> {
  const user = await requireUser();
  if (!(await canOpenModule(user.id, PUBLISH_MODULE_KEY))) {
    return refuse("publish to the live website", user);
  }
  return { user, error: null };
}

/** Assigning work, deciding submissions, changing the setting. Explicit-only, never implied. */
export async function gateReview(): Promise<Gate> {
  const user = await requireUser();
  if (!(await holdsReview(user.id))) return refuse("review website changes", user);
  return { user, error: null };
}

/**
 * Submitting, withdrawing and publishing an APPROVED request: somebody who works
 * on the website (any content module) or reviews it. This is only the door —
 * what each command then requires of the particular request (that it is yours,
 * that it is approved, that you still hold the module of every kind in it) is
 * the command's own check, from the database row.
 */
export async function gateWorkflow(): Promise<Gate> {
  const user = await requireUser();
  if ((await canEditAny(user.id)) || (await holdsReview(user.id))) return { user, error: null };
  return refuse("website changes", user);
}

/** Whether a person holds at least one Website content module. */
export async function canEditAny(userId: string): Promise<boolean> {
  for (const slug of MODULE_SLUGS) {
    if (await canOpenModule(userId, `website.${slug}`)) return true;
  }
  return false;
}

/**
 * May this person LOOK AT an uploaded image through the editor's own route? An
 * editor, and a reviewer — who may hold no content module at all and still has
 * to see the old and the new picture to decide.
 */
export async function canReadMedia(userId: string): Promise<boolean> {
  return (await canEditAny(userId)) || (await holdsReview(userId));
}
