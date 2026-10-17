import { KIND_KEYS, type KindKey } from "./kinds";

/* ---------------------------------------------------------------------------
 * THE WEBSITE REVIEW WORKFLOW'S VOCABULARY AND ITS RULES THAT NEED NO DATABASE.
 *
 * PURE and client-safe, like `kinds.ts` beside it: the review screens run in a
 * browser and the server enforces the same list. It is the one place that says
 *
 *   - which statuses a change request can be in, and which move to which;
 *   - how long an approval lasts, and when it has lapsed;
 *   - what an assignment covers.
 *
 * The same sets are written as CHECK constraints in
 * `drizzle/0274_website_review_workflow.sql`; `review-logic.test.ts` reads that
 * file and fails if the two drift, because a status the code allows and the
 * database refuses is a request nobody can move.
 * ------------------------------------------------------------------------- */

export const REQUEST_STATUSES = [
  "submitted",
  "approved",
  "rejected",
  "revoked",
  "expired",
  "stale",
  "published",
  "withdrawn",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** A request that still holds its items: nobody else may submit them. */
export const OPEN_STATUSES = ["submitted", "approved"] as const satisfies readonly RequestStatus[];

export function isOpen(status: RequestStatus): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether an item is HELD by a request, from where the editor stands: it is, if
 * the request that names it is open. One word for "cannot be changed", used by
 * both editors, the lists and the lock notice — so they cannot disagree about
 * which items a person may type into.
 */
export function isHeldByRequest(review: { status: RequestStatus } | undefined | null): boolean {
  return review !== undefined && review !== null && isOpen(review.status);
}

/**
 * Every allowed move. Anything not listed is refused, and the terminal states
 * list nothing: a rejected, revoked, expired, stale, withdrawn or published
 * request is history, and what the employee does next is a NEW request linked
 * to it (`resubmission_of`), never a reopening — so what a reviewer decided on
 * is never edited afterwards.
 *
 *   submitted → approved   the reviewer's decision
 *   submitted → rejected   the reviewer's decision, with a reason
 *   submitted → withdrawn  the employee takes it back (the way to edit again)
 *   submitted → stale      the content moved before anybody decided
 *   approved  → published  the approved items go live
 *   approved  → revoked    the reviewer takes the approval back before it is used
 *   approved  → expired    seven days passed
 *   approved  → stale      the content moved after approval
 *   approved  → withdrawn  the employee takes it back (the way to edit again)
 */
export const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  submitted: ["approved", "rejected", "withdrawn", "stale"],
  approved: ["published", "revoked", "expired", "stale", "withdrawn"],
  rejected: [],
  revoked: [],
  expired: [],
  stale: [],
  published: [],
  withdrawn: [],
};

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isRequestStatus(v: unknown): v is RequestStatus {
  return typeof v === "string" && (REQUEST_STATUSES as readonly string[]).includes(v);
}

/** The states in which the employee has something to fix and may submit again. */
export const RETURNED_STATUSES = ["rejected", "revoked", "expired", "stale", "withdrawn"] as const satisfies readonly RequestStatus[];

export function isReturned(status: RequestStatus): boolean {
  return (RETURNED_STATUSES as readonly string[]).includes(status);
}

/* ------------------------------------------------------------------ expiry */

/** How long an approval can be used. A number of days, not a setting: it is the rule the brief states. */
export const APPROVAL_VALID_DAYS = 7;

export function approvalExpiry(approvedAt: Date, days: number = APPROVAL_VALID_DAYS): Date {
  return new Date(approvedAt.getTime() + days * 86_400_000);
}

/**
 * Whether an approval can still be used at `now`. The instant of expiry itself
 * is already too late — "expires after 7 days" means it is not usable AT the
 * seven-day mark, and a boundary that is inclusive is one nobody can test.
 */
export function approvalIsLive(request: { status: RequestStatus; approvalExpiresAt: Date | null }, now: Date): boolean {
  return request.status === "approved" && request.approvalExpiresAt !== null && now.getTime() < request.approvalExpiresAt.getTime();
}

/**
 * What to SHOW for a request whose approval has lapsed but which no job has
 * yet moved to `expired`. Commands persist the move; a screen reads this so a
 * lapsed approval never looks usable for the minutes before they do.
 */
export function effectiveStatus(request: { status: RequestStatus; approvalExpiresAt: Date | null }, now: Date): RequestStatus {
  if (request.status === "approved" && !approvalIsLive(request, now)) return "expired";
  return request.status;
}

/* ------------------------------------------------------------- assignments */

/** What an assignment can be for: a content kind, or the media library. */
export const ASSIGNABLE_KINDS = [...KIND_KEYS, "media"] as const;
export type AssignableKind = (typeof ASSIGNABLE_KINDS)[number];

export function isAssignableKind(v: unknown): v is AssignableKind {
  return typeof v === "string" && (ASSIGNABLE_KINDS as readonly string[]).includes(v);
}

export type AssignmentLike = {
  kind: string;
  /** Null = every item of the kind. */
  contentId: string | null;
  revokedAt: Date | null;
};

/**
 * Whether ONE assignment covers a target.
 *
 * `target.contentId` is null for an item that does not exist yet — a new
 * product — and only a kind-wide assignment can cover that: a per-item
 * assignment names a row, and there is none to name. That is also the whole
 * reason "creating new items needs a kind-wide assignment" is a rule rather
 * than a special case.
 */
export function assignmentCovers(a: AssignmentLike, target: { kind: KindKey | "media"; contentId: string | null }): boolean {
  if (a.revokedAt !== null) return false;
  if (a.kind !== target.kind) return false;
  return a.contentId === null || a.contentId === target.contentId;
}

/** Whether any of a person's assignments covers a target. */
export function anyAssignmentCovers(
  assignments: readonly AssignmentLike[],
  target: { kind: KindKey | "media"; contentId: string | null },
): boolean {
  return assignments.some((a) => assignmentCovers(a, target));
}

/** Whether somebody holds a kind-wide assignment — what creating, and reordering, need. */
export function hasKindWideAssignment(assignments: readonly AssignmentLike[], kind: KindKey | "media"): boolean {
  return assignments.some((a) => a.revokedAt === null && a.kind === kind && a.contentId === null);
}

/* ------------------------------------------------------------------- words */

export const STATUS_LABEL: Record<RequestStatus, string> = {
  submitted: "Waiting for review",
  approved: "Approved — ready to publish",
  rejected: "Changes rejected",
  revoked: "Approval revoked",
  expired: "Approval expired",
  stale: "Content changed after submission",
  published: "Published",
  withdrawn: "Withdrawn",
};

/** What the employee is told when the request is not usable, and what to do. */
export const STATUS_HELP: Partial<Record<RequestStatus, string>> = {
  rejected: "Fix what the reviewer asked for, then submit again.",
  revoked: "The reviewer took the approval back before it was published. Submit again to ask for it afresh.",
  expired: "An approval lasts 7 days. Submit again to ask for it afresh.",
  stale: "The content is no longer what the reviewer saw, so the approval cannot be used. Submit again.",
  withdrawn: "You took this back. Submit again when you are ready.",
};

/* ------------------------------------------------------------------- queue */

/**
 * The reviewer's queue, one tab per question somebody asks of it. The tabs are
 * a partition: every status is in exactly one of them, so a count never
 * double-counts a request and no request is on no tab.
 */
export const QUEUE_TABS = [
  { key: "pending", label: "Waiting for review", statuses: ["submitted"] },
  { key: "approved", label: "Approved — awaiting publication", statuses: ["approved"] },
  { key: "published", label: "Published", statuses: ["published"] },
  { key: "rejected", label: "Rejected", statuses: ["rejected"] },
  { key: "closed", label: "Withdrawn, revoked, expired or stale", statuses: ["withdrawn", "revoked", "expired", "stale"] },
] as const satisfies readonly { key: string; label: string; statuses: readonly RequestStatus[] }[];

export type QueueTab = (typeof QUEUE_TABS)[number]["key"];

export function isQueueTab(v: unknown): v is QueueTab {
  return typeof v === "string" && QUEUE_TABS.some((t) => t.key === v);
}

export function tabOf(status: RequestStatus): QueueTab {
  return QUEUE_TABS.find((t) => (t.statuses as readonly string[]).includes(status))!.key;
}

/** A tone for a status badge: what it means to the person reading it, not how far along it is. */
export const STATUS_TONE: Record<RequestStatus, "brand" | "success" | "warn" | "danger" | "muted" | "neutral"> = {
  submitted: "brand",
  approved: "success",
  rejected: "danger",
  revoked: "warn",
  expired: "warn",
  stale: "warn",
  published: "success",
  withdrawn: "muted",
};
