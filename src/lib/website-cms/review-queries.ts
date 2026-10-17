import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  auditLog,
  users,
  websiteAssignment,
  websiteChangeItem,
  websiteChangeRequest,
  websiteContent,
} from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { activeAssignments, assignmentsEnforced, isDirectEditor } from "./access";
import { KINDS, KIND_KEYS, moduleKeyFor, type KindKey } from "./kinds";
import { filterToScope, makeScope, type ItemScope, type ScopeKind } from "./review-scope";
import { sweepExpiredApprovals } from "./review-service";
import {
  QUEUE_TABS,
  RETURNED_STATUSES,
  effectiveStatus,
  type QueueTab,
  type RequestStatus,
} from "./review-status";
import { listItems, type ItemView } from "./service";

/* ---------------------------------------------------------------------------
 * WHAT THE REVIEW SCREENS READ. Every list, count and entry point on the Website
 * screens comes through here, so what a person is shown and what the server will
 * let them do cannot drift apart:
 *
 *   - `scopeFor` is the one place that decides what somebody may SEE, from the
 *     same rule `gateEdit` uses to decide what they may DO;
 *   - an approval whose seven days have passed is moved to `expired` before it
 *     is listed, so a lapsed approval never looks usable for the minutes before a
 *     job would have said so.
 *
 * Nothing here writes except that sweep, and nothing here is authorisation: the
 * pages ask the commands' own gates first, and the commands check again.
 * ------------------------------------------------------------------------- */

/** What this person may see of the Website's content. */
export async function scopeFor(userId: string): Promise<ItemScope> {
  if (!(await assignmentsEnforced())) return makeScope({ enforced: false, direct: true, assignments: [] });
  const direct = await isDirectEditor(userId);
  return makeScope({ enforced: true, direct, assignments: direct ? [] : await activeAssignments(userId) });
}

/** A list's rows, narrowed to what this person was assigned. */
export async function visibleItems(kind: KindKey, scope: ItemScope): Promise<ItemView[]> {
  return filterToScope(scope, await listItems(kind));
}

async function sweep() {
  try {
    await sweepExpiredApprovals();
  } catch {
    /* listing never fails because a courtesy sweep did */
  }
}

/* ------------------------------------------------------ one item's review */

export type ItemReview = {
  requestId: string;
  status: RequestStatus;
  /** The signed-in person submitted it. Only they are told more than "waiting". */
  mine: boolean;
  reason: string | null;
  approvalExpiresAt: string | null;
};

/**
 * Where each item stands in review, for the list it is drawn in:
 *   - an item held by an OPEN request (anybody's) says so — the editor is locked;
 *   - otherwise, YOUR most recent request for it, if it came back to you
 *     (rejected, revoked, expired or stale) and nothing since has superseded it.
 * Other people's returned requests are not shown: that is their work.
 */
export async function reviewByItem(userId: string, itemIds: readonly string[]): Promise<Record<string, ItemReview>> {
  if (itemIds.length === 0) return {};
  await sweep();
  const out: Record<string, ItemReview> = {};

  const open = await db
    .select({ contentId: websiteChangeItem.openContentId, r: websiteChangeRequest })
    .from(websiteChangeItem)
    .innerJoin(websiteChangeRequest, eq(websiteChangeRequest.id, websiteChangeItem.requestId))
    .where(and(isNotNull(websiteChangeItem.openContentId), inArray(websiteChangeItem.openContentId, [...itemIds])));
  for (const o of open) {
    out[o.contentId!] = {
      requestId: o.r.id,
      status: o.r.status as RequestStatus,
      mine: o.r.submitterId === userId,
      reason: null,
      approvalExpiresAt: o.r.approvalExpiresAt?.toISOString() ?? null,
    };
  }

  const rest = itemIds.filter((i) => !out[i]);
  if (rest.length) {
    const mine = await db
      .select({ contentId: websiteChangeItem.contentId, r: websiteChangeRequest })
      .from(websiteChangeItem)
      .innerJoin(websiteChangeRequest, eq(websiteChangeRequest.id, websiteChangeItem.requestId))
      .where(and(inArray(websiteChangeItem.contentId, rest), eq(websiteChangeRequest.submitterId, userId)))
      .orderBy(desc(websiteChangeRequest.submittedAt));
    const seen = new Set<string>();
    for (const m of mine) {
      if (seen.has(m.contentId)) continue;
      seen.add(m.contentId); // the newest one decides; older ones are history
      const status = m.r.status as RequestStatus;
      if (status === "withdrawn" || !(RETURNED_STATUSES as readonly string[]).includes(status)) continue;
      out[m.contentId] = { requestId: m.r.id, status, mine: true, reason: m.r.rejectReason, approvalExpiresAt: null };
    }
  }
  return out;
}

/* ----------------------------------------------------------------- queue */

export type RequestRow = {
  id: string;
  status: RequestStatus;
  submitterId: string;
  submitterName: string;
  submittedAt: string;
  items: number;
  itemLabels: string[];
  rejectReason: string | null;
  approvalExpiresAt: string | null;
  resubmissionOf: string | null;
  reviewerName: string | null;
};

async function rowsFor(where: ReturnType<typeof and> | undefined): Promise<RequestRow[]> {
  const reqs = await db
    .select({ r: websiteChangeRequest, name: users.name })
    .from(websiteChangeRequest)
    .innerJoin(users, eq(users.id, websiteChangeRequest.submitterId))
    .where(where)
    .orderBy(desc(websiteChangeRequest.submittedAt));
  if (reqs.length === 0) return [];
  const items = await db
    .select()
    .from(websiteChangeItem)
    .where(inArray(websiteChangeItem.requestId, reqs.map((x) => x.r.id)))
    .orderBy(asc(websiteChangeItem.kind), asc(websiteChangeItem.slug));
  const labels = new Map<string, string[]>();
  for (const i of items) {
    const label = KINDS[i.kind as KindKey]?.labelOf(i.proposedData) ?? i.slug;
    labels.set(i.requestId, [...(labels.get(i.requestId) ?? []), label]);
  }
  const reviewerIds = [...new Set(reqs.map((x) => x.r.reviewerId).filter((x): x is string => !!x))];
  const reviewers = reviewerIds.length ? new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, reviewerIds))).map((u) => [u.id, u.name])) : new Map<string, string>();
  return reqs.map(({ r, name }) => {
    const ls = labels.get(r.id) ?? [];
    return {
      id: r.id,
      status: effectiveStatus({ status: r.status as RequestStatus, approvalExpiresAt: r.approvalExpiresAt }, new Date()),
      submitterId: r.submitterId,
      submitterName: name,
      submittedAt: r.submittedAt.toISOString(),
      items: ls.length,
      itemLabels: ls.slice(0, 4),
      rejectReason: r.rejectReason,
      approvalExpiresAt: r.approvalExpiresAt?.toISOString() ?? null,
      resubmissionOf: r.resubmissionOf,
      reviewerName: r.reviewerId ? (reviewers.get(r.reviewerId) ?? null) : null,
    };
  });
}

export type Queue = { counts: Record<QueueTab, number>; rows: RequestRow[]; tab: QueueTab };

/** The reviewer's whole queue: a count per tab, and the rows of the one being looked at. */
export async function reviewQueue(tab: QueueTab): Promise<Queue> {
  await sweep();
  const grouped = await db
    .select({ status: websiteChangeRequest.status, n: sql<number>`count(*)::int` })
    .from(websiteChangeRequest)
    .groupBy(websiteChangeRequest.status);
  const counts = Object.fromEntries(QUEUE_TABS.map((t) => [t.key, 0])) as Record<QueueTab, number>;
  for (const g of grouped) {
    const t = QUEUE_TABS.find((x) => (x.statuses as readonly string[]).includes(g.status));
    if (t) counts[t.key] += g.n;
  }
  const wanted = QUEUE_TABS.find((t) => t.key === tab)!;
  const rows = await rowsFor(inArray(websiteChangeRequest.status, [...wanted.statuses]));
  return { counts, rows, tab };
}

/** How many requests are waiting for a decision — the figure beside "Review" in the sidebar. */
export async function pendingReviewCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(websiteChangeRequest)
    .where(eq(websiteChangeRequest.status, "submitted"));
  return row?.n ?? 0;
}

/* --------------------------------------------------------------- my work */

export type AssignedTo = {
  id: string;
  kind: ScopeKind;
  kindLabel: string;
  contentId: string | null;
  itemLabel: string | null;
  scopeNote: string | null;
  assignedAt: string;
};

export type ReadyItem = { id: string; kind: KindKey; label: string; why: "changes" | "new" };

export type MyWork = {
  enforced: boolean;
  assignments: AssignedTo[];
  /** Approved and waiting for the person to publish them. */
  toPublish: RequestRow[];
  /** Came back: rejected, revoked, expired or stale, and not yet resubmitted. */
  returned: RequestRow[];
  /** Waiting for a reviewer. */
  waiting: RequestRow[];
  /** Edited, not submitted, not held by a request — the work to hand in. */
  ready: ReadyItem[];
  /** The last few that went live. */
  published: RequestRow[];
};

const kindLabel = (k: ScopeKind) => (k === "media" ? "Media library" : KINDS[k].plural.replace(/^./, (c) => c.toUpperCase()));

export async function myWork(userId: string, scope: ItemScope): Promise<MyWork> {
  await sweep();
  const enforced = !scope.everything;

  const mine = await db
    .select({ a: websiteAssignment, item: websiteContent })
    .from(websiteAssignment)
    .leftJoin(websiteContent, eq(websiteContent.id, websiteAssignment.contentId))
    .where(and(eq(websiteAssignment.employeeId, userId), isNull(websiteAssignment.revokedAt)))
    .orderBy(desc(websiteAssignment.assignedAt));
  const assignments: AssignedTo[] = mine.map(({ a, item }) => ({
    id: a.id,
    kind: a.kind as ScopeKind,
    kindLabel: kindLabel(a.kind as ScopeKind),
    contentId: a.contentId,
    itemLabel: item ? (KINDS[item.kind as KindKey]?.labelOf(item.data) ?? item.slug) : null,
    scopeNote: a.scopeNote,
    assignedAt: a.assignedAt.toISOString(),
  }));

  const own = await rowsFor(eq(websiteChangeRequest.submitterId, userId));
  const followed = new Set(own.map((r) => r.resubmissionOf).filter((x): x is string => !!x));
  const toPublish = own.filter((r) => r.status === "approved");
  const waiting = own.filter((r) => r.status === "submitted");
  const returned = own
    .filter((r) => (["rejected", "revoked", "expired", "stale"] as RequestStatus[]).includes(r.status) && !followed.has(r.id))
    .slice(0, 20);
  const published = own.filter((r) => r.status === "published").slice(0, 5);

  // Work to hand in: unpublished changes or never-published drafts, in the person's scope and the kinds they hold, and not already in a request.
  const held = new Set(
    (await db.select({ c: websiteChangeItem.openContentId }).from(websiteChangeItem).where(isNotNull(websiteChangeItem.openContentId))).map((x) => x.c as string),
  );
  const heldKinds = new Set<KindKey>();
  for (const k of KIND_KEYS) if (await canOpenModule(userId, moduleKeyFor(k))) heldKinds.add(k);
  const rows = await db.select().from(websiteContent).where(inArray(websiteContent.state, ["draft", "published"]));
  const ready: ReadyItem[] = [];
  for (const r of rows) {
    const kind = r.kind as KindKey;
    if (!heldKinds.has(kind) || held.has(r.id) || !scope.covers(kind, r.id)) continue;
    const changed = r.state === "published" && r.version !== r.publishedVersion;
    const isNew = r.state === "draft" && r.publishedAt === null;
    if (!changed && !isNew) continue;
    ready.push({ id: r.id, kind, label: KINDS[kind].labelOf(r.data), why: isNew ? "new" : "changes" });
  }
  ready.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));

  return { enforced, assignments, toPublish, returned, waiting, ready: ready.slice(0, 200), published };
}

/* ----------------------------------------------------------- assigning */

export type AssignmentRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  kind: ScopeKind;
  kindLabel: string;
  contentId: string | null;
  itemLabel: string | null;
  scopeNote: string | null;
  assignedAt: string;
  assignedByName: string;
};

/** `direct` holds Publish or Review, so assignments never restrict them. */
export type Employee = { id: string; name: string; kinds: ScopeKind[]; direct: boolean };

export type AssignScreenData = {
  enforced: boolean;
  assignments: AssignmentRow[];
  employees: Employee[];
  items: { id: string; kind: KindKey; label: string }[];
};

/** Everything the assign screen draws. For reviewers, who see every item — never call it for anybody else. */
export async function assignScreen(): Promise<AssignScreenData> {
  const enforced = await assignmentsEnforced();
  const rows = await db
    .select({ a: websiteAssignment, item: websiteContent })
    .from(websiteAssignment)
    .leftJoin(websiteContent, eq(websiteContent.id, websiteAssignment.contentId))
    .where(isNull(websiteAssignment.revokedAt))
    .orderBy(desc(websiteAssignment.assignedAt));
  const ids = [...new Set(rows.flatMap(({ a }) => [a.employeeId, a.assignedById]))];
  const names = ids.length ? new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name])) : new Map<string, string>();
  const assignments = rows.map(({ a, item }) => ({
    id: a.id,
    employeeId: a.employeeId,
    employeeName: names.get(a.employeeId) ?? "Unknown",
    kind: a.kind as ScopeKind,
    kindLabel: kindLabel(a.kind as ScopeKind),
    contentId: a.contentId,
    itemLabel: item ? (KINDS[item.kind as KindKey]?.labelOf(item.data) ?? item.slug) : null,
    scopeNote: a.scopeNote,
    assignedAt: a.assignedAt.toISOString(),
    assignedByName: names.get(a.assignedById) ?? "Unknown",
  }));

  const holders = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "website")))
    .where(eq(users.active, true))
    .orderBy(asc(users.name));
  const employees: Employee[] = [];
  for (const u of holders) {
    const kinds: ScopeKind[] = [];
    for (const k of KIND_KEYS) if (await canOpenModule(u.id, moduleKeyFor(k))) kinds.push(k);
    if (await canOpenModule(u.id, "website.media")) kinds.push("media");
    employees.push({ id: u.id, name: u.name, kinds, direct: await isDirectEditor(u.id) });
  }

  const content = await db.select().from(websiteContent).where(inArray(websiteContent.state, ["draft", "published"]));
  const items = content
    .map((r) => ({ id: r.id, kind: r.kind as KindKey, label: KINDS[r.kind as KindKey]?.labelOf(r.data) ?? r.slug }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  return { enforced, assignments, employees, items };
}

/* --------------------------------------------------------------- history */

export type HistoryEntry = { at: string; action: string; actorName: string | null; detail: string | null };

const HISTORY_SENTENCE: Record<string, string> = {
  "website.review.submitted": "Submitted for verification",
  "website.review.approved": "Permission to publish granted",
  "website.review.rejected": "Changes rejected",
  "website.review.revoked": "Approval revoked",
  "website.review.withdrawn": "Withdrawn by the employee",
  "website.review.expired": "Approval expired",
  "website.review.stale": "Approval voided — the content changed",
  "website.review.published": "Published",
};

const STALE_WHY: Record<string, string> = {
  version_moved: "was saved again after it was submitted",
  content_changed: "no longer matches what was submitted",
  deleted: "no longer exists",
};

/** Who did what to a request, and when. Read from the audit log, which is where each step was written. */
export async function requestHistory(requestId: string): Promise<HistoryEntry[]> {
  const rows = await db
    .select({ a: auditLog, name: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(eq(auditLog.entityType, "website_change_request"), eq(auditLog.entityId, requestId)))
    .orderBy(asc(auditLog.at));
  return rows.map(({ a, name }) => {
    const after = (a.afterState ?? {}) as { reason?: string; why?: string; item?: string };
    return {
      at: a.at.toISOString(),
      action: HISTORY_SENTENCE[a.action] ?? a.action,
      actorName: name ?? null,
      // A rejection says why in the reviewer's own words; a voided approval says which item moved and how.
      detail: after.reason ?? (a.action === "website.review.stale" && after.why ? `${after.item ?? "An item"} ${STALE_WHY[after.why] ?? "changed"}.` : null),
    };
  });
}

/* ---------------------------------------------------------------- launcher */

export type LauncherCounts = {
  /** Requests waiting for a decision — drawn only for somebody who holds `website.review`. */
  waiting: number;
  /** The person's own approved requests, ready for them to publish. */
  toPublish: number;
  /** The person's own requests that came back: rejected, revoked, expired, stale — and not yet submitted again. */
  returned: number;
};

/**
 * What the Website tile on the launcher counts, and what its sentence says —
 * the same three things, so the badge is never a number the words do not
 * describe. Three cheap counts, no sweep and no rows: this is the home screen.
 *
 * An approval whose seven days have passed but which no job has yet moved is
 * counted as returned, not as ready: the tile must not tell somebody to publish
 * what the server would refuse.
 */
export async function launcherCounts(userId: string, isReviewer: boolean): Promise<LauncherCounts> {
  const now = new Date();
  const [waiting] = isReviewer
    ? await db.select({ n: sql<number>`count(*)::int` }).from(websiteChangeRequest).where(eq(websiteChangeRequest.status, "submitted"))
    : [{ n: 0 }];
  const [ready] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(websiteChangeRequest)
    .where(and(eq(websiteChangeRequest.submitterId, userId), eq(websiteChangeRequest.status, "approved"), sql`${websiteChangeRequest.approvalExpiresAt} > ${now.toISOString()}`));
  const [back] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(websiteChangeRequest)
    .where(
      and(
        eq(websiteChangeRequest.submitterId, userId),
        sql`(${websiteChangeRequest.status} in ('rejected', 'revoked', 'expired', 'stale')
          or (${websiteChangeRequest.status} = 'approved' and ${websiteChangeRequest.approvalExpiresAt} <= ${now.toISOString()}))`,
        // Submitted again since: it is no longer waiting on this person. (Qualified by hand — Drizzle would render a bare "id" that binds to the inner table.)
        sql`not exists (select 1 from website_change_request nxt where nxt.resubmission_of = website_change_request.id)`,
      ),
    );
  return { waiting: waiting?.n ?? 0, toPublish: ready?.n ?? 0, returned: back?.n ?? 0 };
}
