import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { websiteContent, websiteMedia } from "@/db/schema";
import { confirmImpact } from "@/lib/impact/registry";
import type { ImpactConfirmation } from "@/lib/impact/types";
import { err, fromThrown, type Result } from "@/lib/result";
import {
  activeAssignments,
  assignmentsEnforced,
  gateAnyEdit,
  gateEdit,
  gatePublish,
  gateReview,
  gateWorkflow,
  holdsReview,
  isDirectEditor,
  type Gate,
} from "./access";
import { checkLiveSite, type ConnectionCheck, type LiveRefresh } from "./live-site";
import { isKind, KINDS, type KindKey } from "./kinds";
import { deleteMedia, updateMediaAlt } from "./media-service";
import * as review from "./review-service";
import { hasKindWideAssignment, STATUS_LABEL } from "./review-status";
import {
  createItem,
  deleteDraft,
  discardChanges,
  getItem,
  importWebsiteContent,
  moveItem,
  previewFor,
  previewForKind,
  publishPending,
  refreshLive,
  transitionItems,
  updateItem,
  type ImportReport,
  type ItemView,
  type PublishOutcome,
} from "./service";

/* ---------------------------------------------------------------------------
 * THE WEBSITE CMS COMMANDS — every operation a person can ask for, each one
 * checking who is asking BEFORE it touches anything.
 *
 * These are what `lib/actions/website-cms.ts` calls. They live apart from the
 * actions for one reason: a server action cannot run outside a Next request
 * (it revalidates paths), and the permission rules are the part that most needs
 * a test. So the actions are three lines each — call a command, refresh the
 * screens — and everything that matters is here, under test.
 *
 * What arrives from a screen is a URL: `kind` and `id` come as strings no
 * dropdown had to produce. The kind of an EXISTING item is read from its row,
 * never from the caller — somebody holding Products must not be able to edit
 * the menus by sending another kind. The same goes for every request, item and
 * assignment of the review workflow: what it is, whose it is and what state it
 * is in come from the database row, never from what the caller says about it.
 * ------------------------------------------------------------------------- */

async function kindOfItem(id: unknown): Promise<KindKey | null> {
  if (typeof id !== "string" || !id) return null;
  const [row] = await db.select({ kind: websiteContent.kind }).from(websiteContent).where(eq(websiteContent.id, id)).limit(1);
  return row && isKind(row.kind) ? row.kind : null;
}

const gone = () => err("That item no longer exists.", "not_found");

async function guard<T>(run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (e) {
    return fromThrown(e) as Result<T>;
  }
}

/**
 * The error of a refused gate — and, where the gate knows WHO it refused, a
 * line in the audit log saying so. Refusals by the plain module check carry no
 * actor and write nothing, exactly as before; what is new is that a refusal by
 * an assignment, by the review right or by a workflow rule is remembered.
 */
async function refused(gate: Extract<Gate, { user: null }>, attempt: string, entityId: string | null): Promise<ReturnType<typeof err>> {
  if (gate.actor) await review.auditDenied(gate.actor.id, attempt, entityId, gate.error.error);
  return gate.error;
}

/** A service answered "not permitted": remember who asked, then pass the answer on. */
async function remembered<T>(userId: string, attempt: string, entityId: unknown, result: Result<T>): Promise<Result<T>> {
  if (!result.ok && result.code === "not_permitted") {
    await review.auditDenied(userId, attempt, typeof entityId === "string" ? entityId : null, result.error);
  }
  return result;
}

/**
 * An item that is waiting in a review request cannot be changed under it: the
 * reviewer is reading a frozen copy, and a save would make what they approve and
 * what gets published two different things. Withdrawing the request is the way
 * to edit again — a deliberate step, not a surprise.
 */
async function heldByRequest(id: string): Promise<ReturnType<typeof err> | null> {
  const open = await review.openRequestFor(id);
  if (!open) return null;
  return err(
    `This item is waiting in a review request (${STATUS_LABEL[open.status]}). Withdraw that request before changing it.`,
    "conflict",
  );
}

/**
 * THE IMPACT CHECK, handed to the service as its last word before writing.
 *
 * A destructive command takes the confirmation its modal sent back and the
 * service asks this after every refusal of its own — so a published item
 * still answers "only a draft can be deleted" rather than "confirm first",
 * and an act that would change nothing needs no confirmation at all.
 */
const confirming = (kind: string, id: string, confirmation: ImpactConfirmation | null | undefined) => () =>
  confirmImpact(kind, id, confirmation);

/* ------------------------------------------------------------------ editing */

export function createContent(kind: unknown, data: unknown): Promise<Result<ItemView>> {
  return guard(async () => {
    if (!isKind(kind)) return err("That is not something the website holds.", "validation");
    const gate = await gateEdit(kind, { create: true });
    if (gate.error) return refused(gate, `add ${KINDS[kind].plural}`, null);
    return createItem(gate.user, kind, data);
  });
}

export function saveContent(id: unknown, data: unknown, expectedVersion?: unknown): Promise<Result<ItemView>> {
  return guard(async () => {
    const kind = await kindOfItem(id);
    if (!kind) return gone();
    const gate = await gateEdit(kind, { item: id as string });
    if (gate.error) return refused(gate, `edit a ${KINDS[kind].noun}`, id as string);
    const held = await heldByRequest(id as string);
    if (held) return held;
    return updateItem(gate.user, id as string, data, typeof expectedVersion === "number" ? expectedVersion : undefined);
  });
}

export function discardContentChanges(id: unknown, confirmation?: ImpactConfirmation): Promise<Result<ItemView>> {
  return guard(async () => {
    const kind = await kindOfItem(id);
    if (!kind) return gone();
    const gate = await gateEdit(kind, { item: id as string });
    if (gate.error) return refused(gate, `discard changes to a ${KINDS[kind].noun}`, id as string);
    const held = await heldByRequest(id as string);
    if (held) return held;
    return discardChanges(gate.user, id as string, confirming("site-content-discard", id as string, confirmation));
  });
}

export function deleteContentDraft(id: unknown, confirmation?: ImpactConfirmation): Promise<Result> {
  return guard(async () => {
    const kind = await kindOfItem(id);
    if (!kind) return gone();
    const gate = await gateEdit(kind, { item: id as string });
    if (gate.error) return refused(gate, `delete a ${KINDS[kind].noun}`, id as string);
    const held = await heldByRequest(id as string);
    if (held) return held;
    return deleteDraft(gate.user, id as string, confirming("site-content-delete", id as string, confirmation));
  });
}

export function moveContent(id: unknown, direction: unknown): Promise<Result> {
  return guard(async () => {
    if (direction !== "up" && direction !== "down") return err("Move up or down.", "validation");
    const kind = await kindOfItem(id);
    if (!kind) return gone();
    // Reordering renumbers every sibling and is published with the whole list, so it is the list's to change — not one item's.
    const gate = await gateEdit(kind, { kindWide: true });
    if (gate.error) return refused(gate, `reorder ${KINDS[kind].plural}`, id as string);
    return moveItem(gate.user, id as string, direction);
  });
}

/* --------------------------------------------------------------- publishing */

type Action = "publish" | "unpublish" | "archive" | "restore";

/** The two transitions that take something off mahekindia.com, and the kind each is confirmed under. */
const TAKES_DOWN: Partial<Record<Action, string>> = { unpublish: "site-content-unpublish", archive: "site-content-archive" };

export function transitionContent(ids: unknown, action: Action, confirmation?: ImpactConfirmation): Promise<Result<PublishOutcome>> {
  return guard(async () => {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || ids.some((i) => typeof i !== "string")) {
      return err("Nothing was selected.", "validation");
    }
    // Publishing is its own right, asked for whichever kind is touched…
    const gate = await gatePublish();
    if (gate.error) return refused(gate, `${action} website content`, null);
    // …and being able to publish does not reach a kind the person cannot edit.
    for (const id of ids as string[]) {
      const kind = await kindOfItem(id);
      if (!kind) return err("One of those items no longer exists.", "not_found");
      const edit = await gateEdit(kind, { item: id });
      if (edit.error) return edit.error;
    }
    /* Taking something off the live site is confirmed against the ids
       joined, exactly as the modal was asked about them. */
    const takesDown = TAKES_DOWN[action];
    const check = takesDown ? confirming(takesDown, (ids as string[]).join(","), confirmation) : undefined;
    return transitionItems(gate.user, ids as string[], action, check);
  });
}

export function publishAllPending(kinds?: unknown): Promise<Result<PublishOutcome>> {
  return guard(async () => {
    const gate = await gatePublish();
    if (gate.error) return refused(gate, "publish everything pending", null);
    const wanted = Array.isArray(kinds) ? kinds.filter(isKind) : undefined;
    const needed = wanted ?? (Object.keys(KINDS) as KindKey[]);
    for (const k of needed) {
      const edit = await gateEdit(k, { any: true });
      if (edit.error) {
        return wanted
          ? edit.error
          : err("Publishing everything needs access to every Website module. Publish the modules you hold one by one.", "not_permitted");
      }
    }
    return publishPending(gate.user, wanted);
  });
}

export function refreshLiveSiteNow(): Promise<Result<{ live: LiveRefresh }>> {
  return guard(async () => {
    const gate = await gatePublish();
    if (gate.error) return refused(gate, "refresh the live site", null);
    return refreshLive(gate.user);
  });
}

export function importSiteContent(): Promise<Result<ImportReport>> {
  return guard(async () => {
    const gate = await gatePublish();
    if (gate.error) return refused(gate, "import the site's content", null);
    return importWebsiteContent(gate.user);
  });
}

export function checkConnection(): Promise<Result<ConnectionCheck>> {
  return guard(async () => {
    const gate = await gateAnyEdit();
    if (gate.error) return gate.error;
    return { ok: true, data: await checkLiveSite() };
  });
}

/* ------------------------------------------------------------------ preview */

export function previewItem(id: unknown): Promise<Result<{ url: string }>> {
  return guard(async () => {
    const kind = await kindOfItem(id);
    if (!kind) return gone();
    const gate = await gateEdit(kind, { item: id as string });
    if (gate.error) return gate.error;
    return previewFor(id as string);
  });
}

export function previewKind(kind: unknown, path?: unknown): Promise<Result<{ url: string }>> {
  return guard(async () => {
    if (!isKind(kind)) return err("That is not something the website holds.", "validation");
    const gate = await gateEdit(kind, { any: true });
    if (gate.error) return gate.error;
    return previewForKind(kind, typeof path === "string" ? path : undefined);
  });
}

/* -------------------------------------------------------------------- media */

/**
 * Changing or deleting an uploaded image. Where assignments are enforced, an
 * editor without `website.publish` or `website.review` may change an image they
 * uploaded themselves, or any image if they are assigned the media library —
 * otherwise anybody holding any Website module could rename or remove the
 * pictures of content that was assigned to somebody else.
 */
export async function gateMediaWrite(id: unknown): Promise<Gate> {
  const gate = await gateAnyEdit();
  if (gate.error) return gate;
  if (!(await assignmentsEnforced()) || (await isDirectEditor(gate.user.id))) return gate;
  const [media] = await db
    .select({ uploadedById: websiteMedia.uploadedById })
    .from(websiteMedia)
    .where(eq(websiteMedia.id, String(id)))
    .limit(1);
  if (media?.uploadedById === gate.user.id) return gate;
  if (hasKindWideAssignment(await activeAssignments(gate.user.id), "media")) return gate;
  return {
    user: null,
    error: err("You can change only images you uploaded, unless you have been assigned the media library.", "not_permitted"),
    actor: gate.user,
  };
}

export function setMediaAlt(id: unknown, alt: unknown): Promise<Result> {
  return guard(async () => {
    const gate = await gateMediaWrite(id);
    if (gate.error) return refused(gate, "change an image's description", String(id));
    return updateMediaAlt(String(id), String(alt ?? ""));
  });
}

export function removeMedia(id: unknown, confirmation?: ImpactConfirmation): Promise<Result> {
  return guard(async () => {
    const gate = await gateMediaWrite(id);
    if (gate.error) return refused(gate, "delete an image", String(id));
    return deleteMedia(gate.user, String(id), confirming("site-media", String(id), confirmation));
  });
}

export function readContent(id: unknown): Promise<Result<ItemView>> {
  return guard(async () => {
    const kind = await kindOfItem(id);
    if (!kind) return gone();
    const gate = await gateEdit(kind, { item: id as string });
    if (gate.error) return refused(gate, `read a ${KINDS[kind].noun}`, id as string);
    const item = await getItem(id as string);
    return item ? { ok: true, data: item } : gone();
  });
}

/* ------------------------------------------------- the review workflow */

/** Who may assign: a `website.review` holder, and nobody else — not an administrator, not an app grant. */
export function assignWork(employeeId: unknown, kind: unknown, contentId?: unknown, scopeNote?: unknown): Promise<Result<review.AssignmentView>> {
  return guard(async () => {
    const gate = await gateReview();
    if (gate.error) return refused(gate, "assign website work", typeof employeeId === "string" ? employeeId : null);
    return review.assignWork(gate.user, { employeeId, kind, contentId, scopeNote });
  });
}

export function revokeAssignment(assignmentId: unknown, confirmation?: ImpactConfirmation): Promise<Result> {
  return guard(async () => {
    const gate = await gateReview();
    if (gate.error) return refused(gate, "take away website work", typeof assignmentId === "string" ? assignmentId : null);
    return review.revokeAssignment(gate.user, assignmentId, confirming("site-assignment", String(assignmentId), confirmation));
  });
}

/** Whether assignments are enforced. Changing it is the review holders' alone — not `config.write`'s. */
export function setEnforceAssignments(on: unknown): Promise<Result<{ enforced: boolean }>> {
  return guard(async () => {
    const gate = await gateReview();
    if (gate.error) return refused(gate, "change whether website assignments are enforced", null);
    if (typeof on !== "boolean") return err("Choose on or off.", "validation");
    return review.setEnforceAssignments(gate.user, on);
  });
}

/**
 * Submit drafts for verification. The door is "works on the website"; the
 * lock on each item is then THAT item's own edit gate — module, and assignment
 * where enforced — read from its row. Somebody who cannot edit an item cannot
 * submit it.
 */
export function submitForVerification(ids: unknown, note?: unknown, resubmissionOf?: unknown): Promise<Result<review.SubmittedView>> {
  return guard(async () => {
    const gate = await gateWorkflow();
    if (gate.error) return refused(gate, "submit website changes", null);
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== "string")) return err("Nothing was selected.", "validation");
    for (const id of new Set(ids as string[])) {
      const kind = await kindOfItem(id);
      if (!kind) return err("One of those items no longer exists.", "not_found");
      const edit = await gateEdit(kind, { item: id });
      if (edit.error) return refused(edit, `submit a ${KINDS[kind].noun}`, id);
    }
    return review.submitChange(gate.user, ids, { note, resubmissionOf });
  });
}

export function approveRequest(requestId: unknown): Promise<Result<{ approvalExpiresAt: string }>> {
  return guard(async () => {
    const gate = await gateReview();
    if (gate.error) return refused(gate, "approve a website change request", typeof requestId === "string" ? requestId : null);
    return remembered(gate.user.id, "approve a website change request", requestId, await review.approveRequest(gate.user, requestId));
  });
}

export function rejectRequest(requestId: unknown, reason: unknown): Promise<Result> {
  return guard(async () => {
    const gate = await gateReview();
    if (gate.error) return refused(gate, "reject a website change request", typeof requestId === "string" ? requestId : null);
    return remembered(gate.user.id, "reject a website change request", requestId, await review.rejectRequest(gate.user, requestId, reason));
  });
}

export function revokeApproval(requestId: unknown, confirmation?: ImpactConfirmation): Promise<Result> {
  return guard(async () => {
    const gate = await gateReview();
    if (gate.error) return refused(gate, "revoke an approval", typeof requestId === "string" ? requestId : null);
    const check = confirming("site-approval-revoke", String(requestId), confirmation);
    return remembered(gate.user.id, "revoke an approval", requestId, await review.revokeApproval(gate.user, requestId, check));
  });
}

export function withdrawRequest(requestId: unknown, confirmation?: ImpactConfirmation): Promise<Result> {
  return guard(async () => {
    const gate = await gateWorkflow();
    if (gate.error) return refused(gate, "withdraw a website change request", typeof requestId === "string" ? requestId : null);
    const asReviewer = await holdsReview(gate.user.id);
    const beforeWrite = confirming("site-request-withdraw", String(requestId), confirmation);
    return remembered(gate.user.id, "withdraw a website change request", requestId, await review.withdrawRequest(gate.user, requestId, { asReviewer, beforeWrite }));
  });
}

/**
 * Publish an APPROVED request. This is the one command that puts content live
 * without `website.publish`, and it is not a way round it: it takes a request
 * and no item ids, and the service refuses unless that request is approved,
 * unexpired and exactly what was reviewed. `gatePublish` is not loosened for any
 * other command — unpublish, archive, restore, import, refresh and "publish
 * everything" still ask for `website.publish`.
 */
export function publishApproved(requestId: unknown): Promise<Result<PublishOutcome>> {
  return guard(async () => {
    const gate = await gateWorkflow();
    if (gate.error) return refused(gate, "publish approved website changes", typeof requestId === "string" ? requestId : null);
    const asReviewer = await holdsReview(gate.user.id);
    return remembered(gate.user.id, "publish approved website changes", requestId, await review.publishApproved(gate.user, requestId, { asReviewer }));
  });
}

/** A request, for the person who submitted it or a reviewer — nobody else reads it. */
export function readRequest(requestId: unknown): Promise<Result<review.RequestView>> {
  return guard(async () => {
    const gate = await gateWorkflow();
    if (gate.error) return gate.error;
    if (typeof requestId !== "string" || !requestId) return err("That request no longer exists.", "not_found");
    const view = await review.getRequest(requestId);
    if (!view) return err("That request no longer exists.", "not_found");
    if (view.submitterId !== gate.user.id && !(await holdsReview(gate.user.id))) {
      // Said the same way as a missing one: a request's existence is not for everybody.
      return err("That request no longer exists.", "not_found");
    }
    return { ok: true, data: view };
  });
}
