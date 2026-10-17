import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  users,
  websiteAssignment,
  websiteChangeItem,
  websiteChangeRequest,
  websiteContent,
  websitePublishLog,
  websiteReviewSetting,
  type User,
  type WebsiteChangeRequestRow,
} from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { err, ok, type Result } from "@/lib/result";
import { KINDS, moduleKeyFor, validateKindData, type KindKey } from "./kinds";
import { refreshLiveSite } from "./live-site";
import { actionFor, diffData, hasRealChange, mediaIdsOf, type FieldChange } from "./review-diff";
import { freshness, proposedHash } from "./review-hash";
import {
  APPROVAL_VALID_DAYS,
  approvalExpiry,
  approvalIsLive,
  canTransition,
  isAssignableKind,
  isReturned,
  STATUS_LABEL,
  type RequestStatus,
} from "./review-status";
import { notifyApproved, notifyAssigned, notifyClosed, notifySubmitted, runAfterCommit, type AfterCommit } from "./review-notify";
import { describeLive, type PublishOutcome } from "./service";

/* ---------------------------------------------------------------------------
 * THE WEBSITE REVIEW WORKFLOW — assignments, submissions and decisions.
 *
 * Authorisation of WHO IS ASKING is not here for the editing doors (the
 * commands ask `access.ts` first and pass the person in). What IS here is what
 * must hold whoever asks:
 *
 *   - a submission FREEZES what it contains — the working copy, its hash, the
 *     version, what was live — in one transaction, under row locks;
 *   - an item is in at most one open request: `open_content_id` is set when a
 *     request opens and cleared by the ONE function that closes a request, in
 *     the same transaction as the status change and its audit row;
 *   - an approval covers exactly what was reviewed: publishing re-reads every
 *     row and compares version AND hash, and one difference voids the request
 *     and publishes nothing;
 *   - nobody decides their own submission;
 *   - every change writes its audit row IN THE SAME TRANSACTION, so there is no
 *     moment where the change exists and the record of it does not.
 *
 * `publishApproved` is the only way somebody without `website.publish` puts
 * anything live. It publishes the items the request names and nothing else — it
 * deliberately does NOT run `syncPublishedOrder`, which would publish the
 * working order of the whole kind and with it somebody else's unreviewed
 * reordering.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Db = typeof db | Tx;

/** The audit row, written through whichever client the change itself used. */
async function audit(
  client: Db,
  actorId: string | null,
  action: string,
  entityType: "website_change_request" | "website_assignment" | "website_review_setting" | "website_access",
  entityId: string | null,
  state: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null } = {},
) {
  await client.insert(auditLog).values({
    id: newId("aud"),
    actorId,
    // Not a capability check, so no hat was recorded ("Null means NOT recorded, never 'no role'"); the app is known.
    actorApp: "website",
    action,
    entityType,
    entityId,
    beforeState: (state.before ?? null) as never,
    afterState: (state.after ?? null) as never,
  });
}

/**
 * A refusal worth remembering. Written on its own, outside any transaction —
 * the change it records did not happen — and never allowed to fail the refusal
 * it describes.
 */
export async function auditDenied(actorId: string | null, attempt: string, entityId: string | null, reason: string): Promise<void> {
  try {
    await audit(db, actorId, "website.access.denied", "website_access", entityId, { after: { attempt, reason } });
  } catch {
    /* the person is still refused */
  }
}

async function publishLog(client: Db, actorId: string | null, row: { id: string; kind: string; slug: string }, detail: string) {
  await client.insert(websitePublishLog).values({
    id: newId("wl"),
    actorId,
    action: "publish",
    kind: row.kind,
    slug: row.slug,
    contentId: row.id,
    ok: true,
    detail: detail.slice(0, 500),
  });
}

const isUnique = (e: unknown, constraint?: string): boolean => {
  const c = ((e as { cause?: unknown }).cause ?? e) as { code?: string; constraint_name?: string };
  return c?.code === "23505" && (!constraint || c.constraint_name === constraint);
};

const labelOf = (kind: string, data: Record<string, unknown>, slug: string): string => {
  const def = KINDS[kind as KindKey];
  return def ? def.labelOf(data) : slug;
};

/* ------------------------------------------------------------ the setting */

export async function setEnforceAssignments(user: User, on: boolean): Promise<Result<{ enforced: boolean }>> {
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(websiteReviewSetting).where(eq(websiteReviewSetting.id, "site")).for("update");
    await tx
      .insert(websiteReviewSetting)
      .values({ id: "site", enforceAssignments: on, updatedById: user.id })
      .onConflictDoUpdate({ target: websiteReviewSetting.id, set: { enforceAssignments: on, updatedAt: new Date(), updatedById: user.id } });
    await audit(tx, user.id, "website.review.enforcement_changed", "website_review_setting", "site", {
      before: { enforceAssignments: before?.enforceAssignments ?? false },
      after: { enforceAssignments: on },
    });
  });
  return ok(
    { enforced: on },
    on
      ? "Assignments are now enforced: an editor can change only what they were assigned."
      : "Assignments are no longer enforced: editors can change what their Website modules cover, as before.",
  );
}

/* ------------------------------------------------------------ assignments */

export type AssignmentView = {
  id: string;
  employeeId: string;
  kind: string;
  contentId: string | null;
  scopeNote: string | null;
  assignedAt: string;
};

const assignmentView = (a: typeof websiteAssignment.$inferSelect): AssignmentView => ({
  id: a.id,
  employeeId: a.employeeId,
  kind: a.kind,
  contentId: a.contentId,
  scopeNote: a.scopeNote,
  assignedAt: a.assignedAt.toISOString(),
});

export async function assignWork(
  user: User,
  input: { employeeId: unknown; kind: unknown; contentId?: unknown; scopeNote?: unknown },
): Promise<Result<AssignmentView>> {
  if (typeof input.employeeId !== "string" || !input.employeeId) return err("Choose an employee.", "validation");
  const [employee] = await db.select().from(users).where(eq(users.id, input.employeeId)).limit(1);
  if (!employee || !employee.active) return err("That person is not an active employee.", "not_found");

  let kind: string;
  let contentId: string | null = null;
  let itemLabel: string | null = null;
  if (typeof input.contentId === "string" && input.contentId) {
    // The row decides the kind, never the caller: somebody who names a product's id and another kind is mistaken, not clever.
    const [row] = await db.select({ id: websiteContent.id, kind: websiteContent.kind, slug: websiteContent.slug, data: websiteContent.data }).from(websiteContent).where(eq(websiteContent.id, input.contentId)).limit(1);
    if (!row) return err("That item no longer exists.", "not_found");
    if (input.kind !== undefined && input.kind !== null && input.kind !== row.kind) {
      return err("That item is not of the kind you named.", "validation");
    }
    kind = row.kind;
    contentId = row.id;
    itemLabel = labelOf(row.kind, row.data, row.slug);
  } else {
    if (!isAssignableKind(input.kind)) return err("Choose what to assign.", "validation");
    kind = input.kind;
  }

  const moduleKey = kind === "media" ? "website.media" : moduleKeyFor(kind as KindKey);
  if (!(await canOpenModule(employee.id, moduleKey))) {
    return err(
      `${employee.name} does not hold the Website module this belongs to (${moduleKey}). Give it to them on the Access screen first — an assignment cannot open a screen.`,
      "rule_violation",
    );
  }
  const note = typeof input.scopeNote === "string" && input.scopeNote.trim() ? input.scopeNote.trim().slice(0, 500) : null;

  const [existing] = await db
    .select()
    .from(websiteAssignment)
    .where(
      and(
        eq(websiteAssignment.employeeId, employee.id),
        eq(websiteAssignment.kind, kind),
        contentId ? eq(websiteAssignment.contentId, contentId) : isNull(websiteAssignment.contentId),
        isNull(websiteAssignment.revokedAt),
      ),
    )
    .limit(1);
  if (existing) return ok(assignmentView(existing), `${employee.name} already has this assigned.`);

  try {
    const made = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(websiteAssignment)
        .values({ id: newId("wa"), employeeId: employee.id, kind, contentId, scopeNote: note, assignedById: user.id })
        .returning();
      await audit(tx, user.id, "website.assignment.assigned", "website_assignment", row.id, {
        after: { employeeId: employee.id, employee: employee.name, kind, contentId, scopeNote: note },
      });
      return row;
    });
    const what = itemLabel
      ? `the ${KINDS[kind as KindKey].noun} “${itemLabel}”`
      : kind === "media"
        ? "the media library"
        : `all of the website's ${KINDS[kind as KindKey].plural}`;
    await runAfterCommit([() => notifyAssigned({ employeeId: employee.id, assignerName: user.name, what, note })]);
    return ok(assignmentView(made), `Assigned to ${employee.name}.`);
  } catch (e) {
    if (isUnique(e, "website_assignment_active_key")) {
      const [again] = await db.select().from(websiteAssignment).where(and(eq(websiteAssignment.employeeId, employee.id), eq(websiteAssignment.kind, kind), isNull(websiteAssignment.revokedAt)));
      if (again) return ok(assignmentView(again), `${employee.name} already has this assigned.`);
    }
    throw e;
  }
}

export async function revokeAssignment(user: User, assignmentId: unknown): Promise<Result> {
  if (typeof assignmentId !== "string" || !assignmentId) return err("That assignment no longer exists.", "not_found");
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(websiteAssignment).where(eq(websiteAssignment.id, assignmentId)).for("update");
    if (!row) return err("That assignment no longer exists.", "not_found");
    if (row.revokedAt) return { ok: true as const, data: undefined, message: "That assignment was already taken away." };
    await tx.update(websiteAssignment).set({ revokedAt: new Date(), revokedById: user.id }).where(eq(websiteAssignment.id, row.id));
    await audit(tx, user.id, "website.assignment.revoked", "website_assignment", row.id, {
      before: { employeeId: row.employeeId, kind: row.kind, contentId: row.contentId },
    });
    return { ok: true as const, data: undefined, message: "Assignment taken away." };
  });
}

/* ----------------------------------------------------------- shared reads */

/** The request, if any, that currently holds an item. What stops it being edited, deleted or submitted again. */
export async function openRequestFor(contentId: string): Promise<{ id: string; status: RequestStatus; submitterId: string } | null> {
  const [row] = await db
    .select({ id: websiteChangeRequest.id, status: websiteChangeRequest.status, submitterId: websiteChangeRequest.submitterId })
    .from(websiteChangeItem)
    .innerJoin(websiteChangeRequest, eq(websiteChangeRequest.id, websiteChangeItem.requestId))
    .where(eq(websiteChangeItem.openContentId, contentId))
    .limit(1);
  return row ? { ...row, status: row.status as RequestStatus } : null;
}

export type RequestItemView = {
  id: string;
  contentId: string;
  kind: KindKey;
  slug: string;
  label: string;
  action: "add" | "edit";
  baseData: Record<string, unknown> | null;
  proposedData: Record<string, unknown>;
  changes: FieldChange[];
  mediaBefore: string[];
  mediaAfter: string[];
  submittedVersion: number;
};

export type RequestView = {
  id: string;
  status: RequestStatus;
  statusLabel: string;
  submitterId: string;
  submitterName: string;
  submittedAt: string;
  note: string | null;
  reviewerId: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
  approvedAt: string | null;
  approvalExpiresAt: string | null;
  revokedAt: string | null;
  publishedAt: string | null;
  publishedById: string | null;
  resubmissionOf: string | null;
  items: RequestItemView[];
};

export async function getRequest(requestId: string): Promise<RequestView | null> {
  const [req] = await db.select().from(websiteChangeRequest).where(eq(websiteChangeRequest.id, requestId)).limit(1);
  if (!req) return null;
  const items = await db.select().from(websiteChangeItem).where(eq(websiteChangeItem.requestId, req.id)).orderBy(asc(websiteChangeItem.kind), asc(websiteChangeItem.slug));
  const ids = [req.submitterId, req.reviewerId].filter((x): x is string => !!x);
  const names = new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
  const status = req.status as RequestStatus;
  return {
    id: req.id,
    status,
    statusLabel: STATUS_LABEL[status],
    submitterId: req.submitterId,
    submitterName: names.get(req.submitterId) ?? "Unknown",
    submittedAt: req.submittedAt.toISOString(),
    note: req.note,
    reviewerId: req.reviewerId,
    reviewerName: req.reviewerId ? (names.get(req.reviewerId) ?? "Unknown") : null,
    reviewedAt: req.reviewedAt?.toISOString() ?? null,
    rejectReason: req.rejectReason,
    approvedAt: req.approvedAt?.toISOString() ?? null,
    approvalExpiresAt: req.approvalExpiresAt?.toISOString() ?? null,
    revokedAt: req.revokedAt?.toISOString() ?? null,
    publishedAt: req.publishedAt?.toISOString() ?? null,
    publishedById: req.publishedById,
    resubmissionOf: req.resubmissionOf,
    items: items.map((i) => ({
      id: i.id,
      contentId: i.contentId,
      kind: i.kind as KindKey,
      slug: i.slug,
      label: labelOf(i.kind, i.proposedData, i.slug),
      action: i.action as "add" | "edit",
      baseData: i.baseData,
      proposedData: i.proposedData,
      changes: diffData(i.baseData, i.proposedData),
      mediaBefore: i.mediaBefore,
      mediaAfter: i.mediaAfter,
      submittedVersion: i.submittedVersion,
    })),
  };
}

/* ----------------------------------------------------- closing a request */

type Closing = "rejected" | "revoked" | "expired" | "stale" | "withdrawn";

const CLOSE_ACTION: Record<Closing, string> = {
  rejected: "website.review.rejected",
  revoked: "website.review.revoked",
  expired: "website.review.expired",
  stale: "website.review.stale",
  withdrawn: "website.review.withdrawn",
};

/**
 * THE ONE PLACE A REQUEST STOPS BEING OPEN WITHOUT BEING PUBLISHED.
 *
 * It moves the status (refusing a move the table does not allow), frees every
 * item it was holding (`open_content_id` → null), and writes the audit row — in
 * the caller's transaction, so a request is never closed with its items still
 * locked to it, and never closed without the record of why.
 */
async function closeRequest(
  tx: Tx,
  req: WebsiteChangeRequestRow,
  to: Closing,
  actorId: string | null,
  patch: Partial<typeof websiteChangeRequest.$inferInsert>,
  detail: Record<string, unknown>,
  /** What to send once the transaction has committed — never from inside it. */
  after: AfterCommit[],
): Promise<void> {
  const from = req.status as RequestStatus;
  if (!canTransition(from, to)) throw new Error(`A request cannot move from ${from} to ${to}.`);
  await tx.update(websiteChangeRequest).set({ ...patch, status: to }).where(eq(websiteChangeRequest.id, req.id));
  await tx.update(websiteChangeItem).set({ openContentId: null }).where(eq(websiteChangeItem.requestId, req.id));
  await audit(tx, actorId, CLOSE_ACTION[to], "website_change_request", req.id, {
    before: { status: from },
    after: { status: to, submitterId: req.submitterId, ...detail },
  });

  // Withdrawing is the submitter's own act; the other four are done TO them, and they are told.
  if (to !== "withdrawn") {
    const items = await tx
      .select({ kind: websiteChangeItem.kind, slug: websiteChangeItem.slug, proposed: websiteChangeItem.proposedData })
      .from(websiteChangeItem)
      .where(eq(websiteChangeItem.requestId, req.id))
      .orderBy(asc(websiteChangeItem.kind), asc(websiteChangeItem.slug));
    const labels = items.map((i) => labelOf(i.kind, i.proposed, i.slug));
    const actorName = actorId ? ((await tx.select({ name: users.name }).from(users).where(eq(users.id, actorId)).limit(1))[0]?.name ?? null) : null;
    const submitterId = req.submitterId;
    const reason = patch.rejectReason ?? null;
    after.push(() => notifyClosed({ how: to, requestId: req.id, submitterId, labels, actorName, reason }));
  }
}

/* ------------------------------------------------------------- submitting */

const MAX_ITEMS_PER_REQUEST = 50;

export type SubmittedView = { id: string; status: RequestStatus; items: number };

export async function submitChange(
  user: User,
  rawIds: unknown,
  opts: { note?: unknown; resubmissionOf?: unknown } = {},
): Promise<Result<SubmittedView>> {
  if (!Array.isArray(rawIds) || rawIds.some((i) => typeof i !== "string" || !i)) return err("Nothing was selected.", "validation");
  const ids = [...new Set(rawIds as string[])].sort();
  if (ids.length === 0) return err("Nothing was selected.", "validation");
  if (ids.length > MAX_ITEMS_PER_REQUEST) return err(`Submit at most ${MAX_ITEMS_PER_REQUEST} items at a time.`, "validation");
  const note = typeof opts.note === "string" && opts.note.trim() ? opts.note.trim().slice(0, 1000) : null;

  type Outcome = { error: Result<SubmittedView> } | { made: SubmittedView };
  let outcome: Outcome;
  const after: AfterCommit[] = [];
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      // Locked in id order: two submissions of overlapping items queue rather than deadlock, and the second sees the first's request.
      const rows = await tx.select().from(websiteContent).where(inArray(websiteContent.id, ids)).orderBy(asc(websiteContent.id)).for("update");
      if (rows.length !== ids.length) return { error: err("One of those items no longer exists.", "not_found") };

      const problems: string[] = [];
      for (const r of rows) {
        const kind = r.kind as KindKey;
        const name = `“${labelOf(r.kind, r.data, r.slug)}”`;
        if (r.state === "archived") {
          problems.push(`${name} is archived — restoring it is for whoever publishes.`);
          continue;
        }
        const checked = validateKindData(kind, r.data);
        if (!checked.ok) {
          problems.push(`${name} has fields that need attention: ${checked.issues[0].path} — ${checked.issues[0].message}`);
          continue;
        }
        const base = r.state === "published" ? r.publishedData : null;
        if (!hasRealChange(base, r.data)) problems.push(`${name} has no changes from what is live.`);
      }
      if (problems.length) {
        return { error: err(`Nothing was submitted: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""}`, "validation") };
      }

      const held = await tx
        .select({ contentId: websiteChangeItem.openContentId })
        .from(websiteChangeItem)
        .where(and(isNotNull(websiteChangeItem.openContentId), inArray(websiteChangeItem.openContentId, ids)));
      if (held.length) {
        const first = rows.find((r) => r.id === held[0].contentId);
        return {
          error: err(
            `“${first ? labelOf(first.kind, first.data, first.slug) : "An item"}” is already waiting in a review request. Withdraw that request first.`,
            "conflict",
          ),
        };
      }

      let resubmissionOf: string | null = null;
      if (typeof opts.resubmissionOf === "string" && opts.resubmissionOf) {
        const [prev] = await tx.select().from(websiteChangeRequest).where(eq(websiteChangeRequest.id, opts.resubmissionOf)).limit(1);
        // Only your own returned request can be followed: a link to somebody else's, or to one still open, would be a claim nobody made.
        if (!prev || prev.submitterId !== user.id || !isReturned(prev.status as RequestStatus)) {
          return { error: err("That is not one of your returned requests.", "validation") };
        }
        resubmissionOf = prev.id;
      }

      const requestId = newId("wr");
      await tx.insert(websiteChangeRequest).values({ id: requestId, submitterId: user.id, status: "submitted", note, resubmissionOf });
      const summary: { id: string; kind: string; slug: string; action: string }[] = [];
      for (const r of rows) {
        const live = r.state === "published" ? r.publishedData : null;
        const action = actionFor(live);
        await tx.insert(websiteChangeItem).values({
          id: newId("wi"),
          requestId,
          contentId: r.id,
          kind: r.kind,
          slug: r.slug,
          action,
          baseVersion: live ? r.publishedVersion : null,
          baseData: live,
          proposedData: r.data,
          proposedHash: proposedHash(r.data),
          submittedVersion: r.version,
          mediaBefore: mediaIdsOf(live),
          mediaAfter: mediaIdsOf(r.data),
          openContentId: r.id,
        });
        summary.push({ id: r.id, kind: r.kind, slug: r.slug, action });
      }
      await audit(tx, user.id, "website.review.submitted", "website_change_request", requestId, {
        after: { status: "submitted", items: summary, resubmissionOf, note },
      });
      after.push(() =>
        notifySubmitted({
          requestId,
          submitterId: user.id,
          submitterName: user.name,
          // Sorted: rows are locked in id order, which is random to a reader, and the same request must always read the same.
          labels: rows.map((r) => labelOf(r.kind, r.data, r.slug)).sort((x, y) => x.localeCompare(y)),
          note,
        }),
      );
      return { made: { id: requestId, status: "submitted", items: rows.length } };
    });
  } catch (e) {
    // The unique index on `open_content_id` is the backstop for a race the row locks should already have serialised.
    if (isUnique(e, "website_change_item_open_key")) {
      return err("One of those items was just submitted in another request. Withdraw that request first.", "conflict");
    }
    throw e;
  }

  if ("error" in outcome) return outcome.error;
  await runAfterCommit(after);
  const n = outcome.made.items;
  return ok(outcome.made, `${n === 1 ? "1 item" : `${n} items`} submitted for verification. Nothing changes on the live site until it is approved and you publish it.`);
}

/* -------------------------------------------------------------- deciding */

type Locked = { req: WebsiteChangeRequestRow; items: (typeof websiteChangeItem.$inferSelect)[] };

async function lockRequest(tx: Tx, requestId: string): Promise<Locked | null> {
  const [req] = await tx.select().from(websiteChangeRequest).where(eq(websiteChangeRequest.id, requestId)).for("update");
  if (!req) return null;
  const items = await tx.select().from(websiteChangeItem).where(eq(websiteChangeItem.requestId, req.id)).orderBy(asc(websiteChangeItem.contentId));
  return { req, items };
}

/** Why a request is not in the state a command needs. */
const wrongState = (req: { status: string }, wanted: string): string =>
  `This request is “${STATUS_LABEL[req.status as RequestStatus] ?? req.status}”, so it cannot be ${wanted}.`;

/**
 * Whether every item still holds EXACTLY what was frozen. The first difference
 * names the item. Rows are locked, so the answer cannot change under the caller.
 */
async function firstDrift(
  tx: Tx,
  items: Locked["items"],
): Promise<{ item: Locked["items"][number]; why: "deleted" | "version_moved" | "content_changed" } | { rows: Map<string, typeof websiteContent.$inferSelect> }> {
  const rows = new Map(
    (await tx.select().from(websiteContent).where(inArray(websiteContent.id, items.map((i) => i.contentId))).orderBy(asc(websiteContent.id)).for("update")).map((r) => [r.id, r]),
  );
  for (const item of items) {
    const row = rows.get(item.contentId);
    if (!row) return { item, why: "deleted" };
    const f = freshness({ submittedVersion: item.submittedVersion, proposedHash: item.proposedHash }, { version: row.version, data: row.data });
    if (f !== "fresh") return { item, why: f };
  }
  return { rows };
}

const driftMessage = (item: { kind: string; slug: string; proposedData: Record<string, unknown> }, why: string): string =>
  `“${labelOf(item.kind, item.proposedData, item.slug)}” ${why === "deleted" ? "no longer exists" : "has changed since it was submitted"}, so the approval cannot be used. ${
    why === "deleted" ? "" : "The employee must submit it again."
  }`.trim();

export async function approveRequest(user: User, requestId: unknown): Promise<Result<{ approvalExpiresAt: string }>> {
  if (typeof requestId !== "string" || !requestId) return err("That request no longer exists.", "not_found");
  const after: AfterCommit[] = [];
  const outcome = await db.transaction(async (tx) => {
    const locked = await lockRequest(tx, requestId);
    if (!locked) return err("That request no longer exists.", "not_found") as Result<{ approvalExpiresAt: string }>;
    const { req, items } = locked;
    if (req.submitterId === user.id) return err("You cannot approve your own submission. Somebody else holding Review must.", "not_permitted") as Result<{ approvalExpiresAt: string }>;
    if (!canTransition(req.status as RequestStatus, "approved")) return err(wrongState(req, "approved"), "conflict") as Result<{ approvalExpiresAt: string }>;

    const drift = await firstDrift(tx, items);
    if ("item" in drift) {
      // The decision would be about content that no longer exists in that form: close it and say so.
      await closeRequest(tx, req, "stale", null, {}, { item: drift.item.slug, why: drift.why, at: "approval" }, after);
      return err(driftMessage(drift.item, drift.why), "conflict") as Result<{ approvalExpiresAt: string }>;
    }

    const now = new Date();
    const expires = approvalExpiry(now);
    await tx
      .update(websiteChangeRequest)
      .set({ status: "approved", reviewerId: user.id, reviewedAt: now, approvedAt: now, approvalExpiresAt: expires })
      .where(eq(websiteChangeRequest.id, req.id));
    await audit(tx, user.id, "website.review.approved", "website_change_request", req.id, {
      before: { status: req.status },
      after: { status: "approved", submitterId: req.submitterId, reviewerId: user.id, approvalExpiresAt: expires.toISOString(), items: items.length },
    });
    after.push(() => notifyApproved({ requestId: req.id, submitterId: req.submitterId, reviewerName: user.name, labels: items.map((i) => labelOf(i.kind, i.proposedData, i.slug)), expiresAt: expires }));
    return ok({ approvalExpiresAt: expires.toISOString() }, `Permission to publish granted. It can be used for ${APPROVAL_VALID_DAYS} days, for exactly what you reviewed.`);
  });
  await runAfterCommit(after);
  return outcome;
}

export async function rejectRequest(user: User, requestId: unknown, reason: unknown): Promise<Result> {
  if (typeof requestId !== "string" || !requestId) return err("That request no longer exists.", "not_found");
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) return err("Say why the changes are rejected — the employee needs it to fix them.", "validation", [{ field: "reason", message: "A reason is required." }]);
  if (why.length > 1000) return err("Keep the reason under 1,000 characters.", "validation", [{ field: "reason", message: "Too long." }]);

  const after: AfterCommit[] = [];
  const result = await db.transaction(async (tx) => {
    const locked = await lockRequest(tx, requestId);
    if (!locked) return err("That request no longer exists.", "not_found");
    const { req } = locked;
    if (req.submitterId === user.id) return err("You cannot decide your own submission.", "not_permitted");
    if (!canTransition(req.status as RequestStatus, "rejected")) return err(wrongState(req, "rejected"), "conflict");
    await closeRequest(tx, req, "rejected", user.id, { reviewerId: user.id, reviewedAt: new Date(), rejectReason: why }, { reason: why, reviewerId: user.id }, after);
    return { ok: true as const, data: undefined, message: "Changes rejected. The employee has been told why." };
  });
  await runAfterCommit(after);
  return result;
}

export async function revokeApproval(user: User, requestId: unknown): Promise<Result> {
  if (typeof requestId !== "string" || !requestId) return err("That request no longer exists.", "not_found");
  const after: AfterCommit[] = [];
  const result = await db.transaction(async (tx) => {
    const locked = await lockRequest(tx, requestId);
    if (!locked) return err("That request no longer exists.", "not_found");
    const { req } = locked;
    if (req.submitterId === user.id) return err("You cannot revoke the approval of your own submission — withdraw it instead.", "not_permitted");
    if (req.status !== "approved") return err(wrongState(req, "revoked"), "conflict");
    await closeRequest(tx, req, "revoked", user.id, { revokedAt: new Date(), revokedById: user.id }, { revokedById: user.id }, after);
    return { ok: true as const, data: undefined, message: "Approval revoked. Nothing was published." };
  });
  await runAfterCommit(after);
  return result;
}

/** Takes a request back. The submitter's way to edit an item again; a reviewer may do it for them. */
export async function withdrawRequest(user: User, requestId: unknown, opts: { asReviewer: boolean }): Promise<Result> {
  if (typeof requestId !== "string" || !requestId) return err("That request no longer exists.", "not_found");
  const after: AfterCommit[] = [];
  const result = await db.transaction(async (tx) => {
    const locked = await lockRequest(tx, requestId);
    if (!locked) return err("That request no longer exists.", "not_found");
    const { req } = locked;
    if (req.submitterId !== user.id && !opts.asReviewer) return err("Only the person who submitted this can withdraw it.", "not_permitted");
    if (!canTransition(req.status as RequestStatus, "withdrawn")) return err(wrongState(req, "withdrawn"), "conflict");
    await closeRequest(tx, req, "withdrawn", user.id, {}, { by: user.id }, after);
    return { ok: true as const, data: undefined, message: "Request withdrawn. You can edit these items again." };
  });
  await runAfterCommit(after);
  return result;
}

/**
 * Moves every approval whose seven days have passed to `expired`, freeing its
 * items. Called when somebody tries to use one, and callable from a schedule:
 * either way an approval that has lapsed is never usable, whether or not a job
 * has got round to saying so.
 */
export async function sweepExpiredApprovals(now: Date = new Date()): Promise<number> {
  const after: AfterCommit[] = [];
  const closed = await db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(websiteChangeRequest)
      .where(and(eq(websiteChangeRequest.status, "approved"), lte(websiteChangeRequest.approvalExpiresAt, now)))
      .orderBy(asc(websiteChangeRequest.id))
      .for("update");
    for (const req of due) await closeRequest(tx, req, "expired", null, {}, { expiredAt: req.approvalExpiresAt?.toISOString() }, after);
    return due.length;
  });
  await runAfterCommit(after);
  return closed;
}

/* ------------------------------------------------------------- publishing */

/**
 * Puts the items of one APPROVED request live — exactly those, exactly as
 * reviewed.
 *
 * It is not a general way past `website.publish`: it takes no ids, only a
 * request, it refuses unless that request is approved and unexpired, and it
 * re-reads every row and compares version AND hash before touching any of them.
 * `asReviewer` says the caller holds `website.review`; otherwise the caller must
 * be the person who submitted it, and must still hold the Website module of
 * every kind in it.
 */
export async function publishApproved(user: User, requestId: unknown, opts: { asReviewer: boolean }): Promise<Result<PublishOutcome>> {
  if (typeof requestId !== "string" || !requestId) return err("That request no longer exists.", "not_found");

  const after: AfterCommit[] = [];
  type Fail = Result<PublishOutcome>;
  type Done = { touched: (typeof websiteContent.$inferSelect)[]; submitterId: string; itemCount: number };
  const result = await db.transaction(async (tx): Promise<{ error: Fail } | { done: Done }> => {
    const locked = await lockRequest(tx, requestId);
    if (!locked) return { error: err("That request no longer exists.", "not_found") };
    const { req, items } = locked;

    if (req.submitterId !== user.id && !opts.asReviewer) {
      return { error: err("Only the person who submitted this, or a reviewer, can publish it.", "not_permitted") };
    }
    if (req.status !== "approved") return { error: err(wrongState(req, "published"), "conflict") };

    if (!approvalIsLive({ status: "approved", approvalExpiresAt: req.approvalExpiresAt }, new Date())) {
      await closeRequest(tx, req, "expired", null, {}, { expiredAt: req.approvalExpiresAt?.toISOString(), at: "publish" }, after);
      return { error: err(`This approval expired after ${APPROVAL_VALID_DAYS} days and nothing was published. Submit the changes again.`, "conflict") };
    }

    // Still entitled to the kinds in it? Approval does not outlive the access it was given to somebody who has since lost it.
    if (!opts.asReviewer) {
      for (const kind of new Set(items.map((i) => i.kind as KindKey))) {
        if (!(await canOpenModule(user.id, moduleKeyFor(kind)))) {
          return { error: err(`You no longer hold the Website module for ${KINDS[kind].plural}, so you cannot publish them.`, "not_permitted") };
        }
      }
    }

    const drift = await firstDrift(tx, items);
    if ("item" in drift) {
      await closeRequest(tx, req, "stale", null, {}, { item: drift.item.slug, why: drift.why, at: "publish" }, after);
      return { error: err(`Nothing was published. ${driftMessage(drift.item, drift.why)}`, "conflict") };
    }

    // The same rule publishing always applies: all of it or none of it.
    for (const item of items) {
      const checked = validateKindData(item.kind as KindKey, item.proposedData);
      if (!checked.ok) {
        return { error: err(`Nothing was published: “${labelOf(item.kind, item.proposedData, item.slug)}” — ${checked.issues[0].path}: ${checked.issues[0].message}`, "validation") };
      }
    }

    const touched: (typeof websiteContent.$inferSelect)[] = [];
    const now = new Date();
    for (const item of items) {
      const row = drift.rows.get(item.contentId)!;
      // Already live as it stands (a publisher got there first): nothing to do for this one.
      if (row.state === "published" && row.version === row.publishedVersion) continue;
      const [updated] = await tx
        .update(websiteContent)
        .set({
          state: "published",
          publishedData: row.data,
          publishedVersion: row.version,
          // Only THIS row's own live position, and only if it has none. The kind's order is never touched here (see the header).
          publishedSort: row.publishedSort ?? row.sort,
          publishedAt: now,
          publishedById: user.id,
          updatedAt: now,
          updatedById: user.id,
        })
        .where(eq(websiteContent.id, row.id))
        .returning();
      touched.push(updated);
      await publishLog(tx, user.id, updated, `Approved change request ${req.id}.`);
    }

    await tx
      .update(websiteChangeRequest)
      .set({ status: "published", publishedAt: now, publishedById: user.id })
      .where(eq(websiteChangeRequest.id, req.id));
    await tx.update(websiteChangeItem).set({ openContentId: null }).where(eq(websiteChangeItem.requestId, req.id));
    await audit(tx, user.id, "website.review.published", "website_change_request", req.id, {
      before: { status: "approved" },
      after: {
        status: "published",
        submitterId: req.submitterId,
        reviewerId: req.reviewerId,
        items: items.map((i) => ({ id: i.contentId, kind: i.kind, slug: i.slug, action: i.action, hash: i.proposedHash })),
        published: touched.map((t) => t.id),
      },
    });
    return { done: { touched, submitterId: req.submitterId, itemCount: items.length } };
  });

  await runAfterCommit(after);
  if ("error" in result) return result.error;
  const { touched, itemCount } = result.done;
  if (touched.length === 0) {
    return ok({ changed: 0, items: [], live: null }, "Everything in this request was already live. It is marked published.");
  }
  const live = await refreshLiveSite(user.id, "publish");
  const shown = touched.map((t) => ({ id: t.id, label: labelOf(t.kind, t.data, t.slug), kind: t.kind as KindKey }));
  const subject = shown.length === 1 ? `“${shown[0].label}”` : `${shown.length} of ${itemCount} items`;
  return ok({ changed: shown.length, items: shown, live }, describeLive(`Published ${subject} in MahekOne.`, live));
}

/* ------------------------------------------------------ lists (for screens) */

export type RequestSummary = {
  id: string;
  status: RequestStatus;
  submitterId: string;
  submitterName: string;
  submittedAt: string;
  items: number;
};

/** Newest first. `submitterId` narrows to one person's own requests; omit it for the reviewer's whole queue. */
export async function listRequests(filter: { submitterId?: string; status?: RequestStatus } = {}): Promise<RequestSummary[]> {
  const conditions = [];
  if (filter.submitterId) conditions.push(eq(websiteChangeRequest.submitterId, filter.submitterId));
  if (filter.status) conditions.push(eq(websiteChangeRequest.status, filter.status));
  const reqs = await db
    .select({ r: websiteChangeRequest, name: users.name })
    .from(websiteChangeRequest)
    .innerJoin(users, eq(users.id, websiteChangeRequest.submitterId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(websiteChangeRequest.submittedAt));
  if (reqs.length === 0) return [];
  const counts = await db.select({ requestId: websiteChangeItem.requestId, contentId: websiteChangeItem.contentId }).from(websiteChangeItem).where(inArray(websiteChangeItem.requestId, reqs.map((x) => x.r.id)));
  const per = new Map<string, number>();
  for (const c of counts) per.set(c.requestId, (per.get(c.requestId) ?? 0) + 1);
  return reqs.map(({ r, name }) => ({
    id: r.id,
    status: r.status as RequestStatus,
    submitterId: r.submitterId,
    submitterName: name,
    submittedAt: r.submittedAt.toISOString(),
    items: per.get(r.id) ?? 0,
  }));
}
