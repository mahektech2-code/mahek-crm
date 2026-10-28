import "server-only";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  users,
  websiteAssignment,
  websiteChangeItem,
  websiteChangeRequest,
  websiteContent,
  websiteMedia,
  type User,
  type WebsiteContentRow,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import {
  assignmentsEnforced,
  gateEdit,
  gatePublish,
  gateReview,
  gateWorkflow,
  holdsReview,
  isDirectEditor,
  type Gate,
} from "@/lib/website-cms/access";
import { gateMediaWrite } from "@/lib/website-cms/commands";
import { isKind, KINDS, type KindKey } from "@/lib/website-cms/kinds";
import { mediaDeleteRefusal } from "@/lib/website-cms/media-service";
import { diffData } from "@/lib/website-cms/review-diff";
import { openRequestFor, wrongState } from "@/lib/website-cms/review-service";
import { canTransition, STATUS_LABEL, type RequestStatus } from "@/lib/website-cms/review-status";
import { deleteDraftRefusal } from "@/lib/website-cms/service";
import type { ImpactItem } from "../types";
import type { ImpactBody, ImpactSource } from "../registry";

/* ---------------------------------------------------------------------------
 * WHAT A WEBSITE CHANGE REACHES — mahekindia.com, the editors' own work, and
 * the review queue between them.
 *
 * The CMS keeps two copies of every item: the working copy an editor saves and
 * the live copy visitors are served. So the question each of these acts
 * answers is different. Deleting a draft and discarding changes never touch
 * what a visitor sees; unpublishing and archiving take a page down, and a
 * product taken down disappears from every live industry that lists it. The
 * review acts move nothing on the site at all — they hand items back to be
 * edited, and tell whoever they were done to.
 *
 * Every source asks the same gate its command asks, read from the row, so the
 * modal is no wider a window than the act.
 * ------------------------------------------------------------------------- */

const WEBSITE = "Website";
const LIVE = "mahekindia.com";

/** Throw the gate's own sentence, the way `requireCapability` throws; hand back who passed. */
function pass(gate: Gate): User {
  if (gate.error) throw new Error(gate.error.error);
  return gate.user;
}

async function contentRow(id: string): Promise<WebsiteContentRow | null> {
  const [row] = await db.select().from(websiteContent).where(eq(websiteContent.id, id)).limit(1);
  return row && isKind(row.kind) ? row : null;
}

const labelOf = (row: Pick<WebsiteContentRow, "kind" | "data" | "slug">) =>
  isKind(row.kind) ? KINDS[row.kind].labelOf(row.data) || row.slug : row.slug;

/** The item's own name where somebody can type it; the verb otherwise. */
const typeable = (name: string, verb: string) => (name.trim() && name.length <= 40 ? name : verb);

/** An item's own edit gate — the one every editing command asks, scoped to the item. */
async function authorizeItem(id: string) {
  const row = await contentRow(id);
  if (!row) return;
  pass(await gateEdit(row.kind as KindKey, { item: id }));
}

/** "This item is waiting in a review request" — the command refuses it before anything else. */
async function heldBlocker(id: string): Promise<string | null> {
  const open = await openRequestFor(id);
  return open
    ? `This item is waiting in a review request (${STATUS_LABEL[open.status]}). Withdraw that request before changing it.`
    : null;
}

/* ---------------------------------------------------------- a draft deleted */

/** `site-content-delete` — `deleteContentDraft`. */
export const contentDeleteImpact: ImpactSource = {
  authorize: authorizeItem,
  async report(id) {
    const row = await contentRow(id);
    if (!row) return null;
    const label = labelOf(row);
    const [assigned, requests] = await Promise.all([
      db
        .select({ name: users.name, revokedAt: websiteAssignment.revokedAt })
        .from(websiteAssignment)
        .innerJoin(users, eq(users.id, websiteAssignment.employeeId))
        .where(eq(websiteAssignment.contentId, id)),
      db.execute<{ n: number }>(sql`select count(distinct request_id)::int as n from website_change_item where content_id = ${id}`),
    ]);
    const active = assigned.filter((a) => !a.revokedAt);
    const past = assigned.filter((a) => a.revokedAt);
    const blockers = [deleteDraftRefusal(row), await heldBlocker(id)].filter((b): b is string => !!b);

    /* The assignment rows go with the item — the foreign key cascades — so an
       editor given only this draft is left with nothing assigned. */
    const items: ImpactItem[] = [
      {
        app: WEBSITE,
        label: active.length === 1 ? "assignment to work on it" : "assignments to work on it",
        effect: "deleted",
        count: active.length,
        examples: active.slice(0, 5).map((a) => a.name),
        note: "Where assignments are enforced, whoever held only this one can no longer edit anything in it.",
      },
      {
        app: WEBSITE,
        label: past.length === 1 ? "record of an assignment already taken away" : "records of assignments already taken away",
        effect: "deleted",
        count: past.length,
      },
      {
        app: WEBSITE,
        label: Number(requests[0]?.n) === 1 ? "past review request that included it" : "past review requests that included it",
        effect: "kept",
        count: Number(requests[0]?.n ?? 0),
        note: "A request is history and keeps its own copy of what was submitted.",
      },
      {
        app: LIVE,
        label: "what visitors see",
        effect: "kept",
        count: 0,
        note: "It was never published, so nothing on the live site changes. The images it uses stay in the media library.",
      },
    ];
    return { title: label, verb: "Delete", confirmWord: typeable(label, "DELETE"), items, blockers };
  },
};

/* ----------------------------------------------------- changes thrown away */

/** `site-content-discard` — `discardContentChanges`. */
export const contentDiscardImpact: ImpactSource = {
  authorize: authorizeItem,
  async report(id) {
    const row = await contentRow(id);
    if (!row) return null;
    const label = labelOf(row);
    const live = row.state === "published" && row.publishedData;
    const changes = live && row.version !== row.publishedVersion ? diffData(row.publishedData, row.data) : [];
    const blockers = [
      live ? null : "Only an item that is live has a published version to go back to.",
      await heldBlocker(id),
    ].filter((b): b is string => !!b);
    const items: ImpactItem[] = [
      {
        app: WEBSITE,
        label: changes.length === 1 ? "unpublished edit to it" : "unpublished edits to it",
        effect: "deleted",
        count: changes.length,
        examples: changes.slice(0, 5).map((c) => c.path || "the whole item"),
        note: "The working copy goes back to exactly what is live now. There is no copy of these edits anywhere else.",
      },
      {
        app: LIVE,
        label: "what visitors see",
        effect: "kept",
        count: 0,
        note: "Nothing on the live site moves — it already shows the published version.",
      },
    ];
    return { title: `the unpublished changes to ${label}`, verb: "Discard", confirmWord: typeable(label, "DISCARD"), items, blockers };
  },
};

/* ------------------------------------------------- taken off the live site */

/**
 * What going down does on the live site, for the rows that are live. A product
 * is the one kind other content points at: every live industry that lists it
 * stops showing it, and its own address answers "not found".
 */
async function takenDown(rows: WebsiteContentRow[], action: "unpublish" | "archive"): Promise<ImpactItem[]> {
  const live = rows.filter((r) => r.state === "published");
  const items: ImpactItem[] = [];
  const pages = live.filter((r) => KINDS[r.kind as KindKey].singleton || r.kind === "page");
  const others = live.filter((r) => !pages.includes(r));
  items.push({
    app: LIVE,
    label: others.length === 1 ? "live item taken off the site" : "live items taken off the site",
    effect: "deleted",
    count: others.length,
    examples: others.slice(0, 5).map((r) => `${labelOf(r)} (${KINDS[r.kind as KindKey].noun})`),
    note: "Visitors stop seeing it as soon as the site refreshes, which publishing asks it to do straight away.",
  });
  items.push({
    app: LIVE,
    label: pages.length === 1 ? "page going back to the version built into the site" : "pages going back to the version built into the site",
    effect: "changed",
    count: pages.length,
    examples: pages.slice(0, 5).map(labelOf),
    note: "It stops coming from MahekOne; mahekindia.com shows the content it shipped with.",
  });

  const products = live.filter((r) => r.kind === "product");
  if (products.length) {
    const slugs = products.map((p) => String((p.data as { slug?: string }).slug ?? p.slug));
    const industries = await db
      .select({ data: websiteContent.data, publishedData: websiteContent.publishedData, slug: websiteContent.slug })
      .from(websiteContent)
      .where(and(eq(websiteContent.kind, "industry"), eq(websiteContent.state, "published")));
    const listing = industries.filter((i) =>
      ((i.publishedData as { productSlugs?: string[] } | null)?.productSlugs ?? []).some((s) => slugs.includes(s)),
    );
    items.push(
      {
        app: LIVE,
        label: products.length === 1 ? "product address that will show “not found”" : "product addresses that will show “not found”",
        effect: "changed",
        count: products.length,
        examples: slugs.slice(0, 5).map((s) => `/products/${s}`),
        note: "Anybody following a link, a search result or a printed QR code to it lands on the not-found page.",
      },
      {
        app: LIVE,
        label: listing.length === 1 ? "live industry that lists it" : "live industries that list it",
        effect: "changed",
        count: listing.length,
        examples: listing.slice(0, 5).map((i) => KINDS.industry.labelOf(i.data) || i.slug),
        note: "They go on being shown, without this product among theirs.",
      },
    );
  }

  items.push({
    app: WEBSITE,
    label: rows.length === 1 ? "its text and pictures" : "their text and pictures",
    effect: "kept",
    count: 0,
    note:
      action === "archive"
        ? "Moved to Archived, not deleted. Restore it as a draft and publish it to bring it back."
        : "The working copy stays exactly as it is and can be published again.",
  });
  return items;
}

async function transitionReport(id: string, action: "unpublish" | "archive"): Promise<ImpactBody | null> {
  const ids = [...new Set(id.split(",").filter(Boolean))];
  if (!ids.length) return null;
  const rows = (await db.select().from(websiteContent).where(inArray(websiteContent.id, ids))).filter((r) => isKind(r.kind));
  if (rows.length !== ids.length) return null;

  const blockers: string[] = [];
  if (action === "archive" && rows.some((r) => KINDS[r.kind as KindKey].singleton || r.kind === "page")) {
    blockers.push("This cannot be archived. Unpublish it to go back to the content built into the site.");
  }
  const one = rows.length === 1 ? rows[0] : null;
  const title = one ? labelOf(one) : `${rows.length} items`;
  const verb = action === "archive" ? "Archive" : "Unpublish";
  return {
    title,
    verb,
    confirmWord: one ? typeable(title, verb.toUpperCase()) : verb.toUpperCase(),
    items: await takenDown(rows, action),
    blockers,
  };
}

/** Publishing is its own right, and it does not reach a kind the person cannot edit — as `transitionContent` asks. */
async function authorizeTransition(id: string) {
  pass(await gatePublish());
  for (const one of id.split(",").filter(Boolean)) await authorizeItem(one);
}

/** `site-content-unpublish` — `transitionContent(ids, "unpublish")`. The id is the ids joined by commas. */
export const contentUnpublishImpact: ImpactSource = {
  authorize: authorizeTransition,
  report: (id) => transitionReport(id, "unpublish"),
};

/** `site-content-archive` — `transitionContent(ids, "archive")`. The id is the ids joined by commas. */
export const contentArchiveImpact: ImpactSource = {
  authorize: authorizeTransition,
  report: (id) => transitionReport(id, "archive"),
};

/* --------------------------------------------------------------- an image */

/** `site-media` — `removeMedia`. */
export const mediaImpact: ImpactSource = {
  async authorize(id) {
    pass(await gateMediaWrite(id));
  },
  async report(id) {
    const [row] = await db.select().from(websiteMedia).where(and(eq(websiteMedia.id, id), isNull(websiteMedia.deletedAt))).limit(1);
    if (!row) return null;
    const refused = await mediaDeleteRefusal(row);
    /* A closed request is history: its before-and-after pictures are read
       from the library, so one deleted from under it shows as a gap. */
    const [shown] = await db.execute<{ n: number }>(sql`
      select count(distinct i.request_id)::int as n
        from website_change_item i
       where i.open_content_id is null
         and (i.media_before @> jsonb_build_array(${id}::text) or i.media_after @> jsonb_build_array(${id}::text))
    `);
    const items: ImpactItem[] = [
      {
        app: WEBSITE,
        label: "image in the media library",
        effect: "deleted",
        count: 1,
        examples: [row.filename],
        note: "Its address stops answering, and it can no longer be picked. The file itself is kept, so an administrator can bring it back.",
      },
      {
        app: WEBSITE,
        label: Number(shown?.n) === 1 ? "past review request that showed it" : "past review requests that showed it",
        effect: "changed",
        count: Number(shown?.n ?? 0),
        note: "Their before-and-after pictures show a gap where it was.",
      },
    ];
    return {
      title: row.filename,
      verb: "Delete",
      confirmWord: typeable(row.filename, "DELETE"),
      items,
      blockers: refused ? [refused] : [],
    };
  },
};

/* ---------------------------------------------------- an assignment taken away */

/** `site-assignment` — `revokeAssignment`. */
export const assignmentImpact: ImpactSource = {
  async authorize() {
    pass(await gateReview());
  },
  async report(id) {
    const [row] = await db
      .select({
        employeeId: websiteAssignment.employeeId,
        kind: websiteAssignment.kind,
        contentId: websiteAssignment.contentId,
        revokedAt: websiteAssignment.revokedAt,
        name: users.name,
      })
      .from(websiteAssignment)
      .innerJoin(users, eq(users.id, websiteAssignment.employeeId))
      .where(eq(websiteAssignment.id, id))
      .limit(1);
    if (!row) return null;

    const kindLabel = row.kind === "media" ? "the media library" : isKind(row.kind) ? KINDS[row.kind].plural : row.kind;
    const [scope, enforced, direct, open] = await Promise.all([
      row.contentId
        ? db.select().from(websiteContent).where(eq(websiteContent.id, row.contentId))
        : row.kind === "media"
          ? Promise.resolve([] as WebsiteContentRow[])
          : db.select().from(websiteContent).where(eq(websiteContent.kind, row.kind)),
      assignmentsEnforced(),
      isDirectEditor(row.employeeId),
      db
        .select({ requestId: websiteChangeItem.requestId })
        .from(websiteChangeItem)
        .innerJoin(websiteChangeRequest, eq(websiteChangeRequest.id, websiteChangeItem.requestId))
        .where(
          and(
            isNotNull(websiteChangeItem.openContentId),
            eq(websiteChangeRequest.submitterId, row.employeeId),
            row.contentId ? eq(websiteChangeItem.contentId, row.contentId) : eq(websiteChangeItem.kind, row.kind),
          ),
        ),
    ]);
    const what = row.contentId ? (scope[0] ? labelOf(scope[0]) : "one item") : `every item in ${kindLabel}`;

    const items: ImpactItem[] = [];
    const reach = row.kind === "media" ? 0 : scope.length;
    if (enforced && !direct) {
      items.push({
        app: WEBSITE,
        label: reach === 1 ? `item ${row.name} can no longer edit` : `items ${row.name} can no longer edit`,
        effect: "changed",
        count: row.kind === "media" ? 1 : reach,
        examples: row.kind === "media" ? ["Images they did not upload themselves"] : scope.slice(0, 5).map(labelOf),
        note: "Assignments are enforced, so from now on they cannot change these — unless another assignment of theirs covers them.",
      });
    } else {
      items.push({
        app: WEBSITE,
        label: `what ${row.name} can edit`,
        effect: "kept",
        count: 0,
        note: direct
          ? "They hold Publish or Review, which reach everything regardless of assignments."
          : "Assignments are not enforced right now, so nothing changes today — it matters the day they are.",
      });
    }
    const requests = new Set(open.map((o) => o.requestId)).size;
    if (requests) {
      items.push({
        app: WEBSITE,
        label: requests === 1 ? "request of theirs waiting for review" : "requests of theirs waiting for review",
        effect: "kept",
        count: requests,
        note: "Stays for a reviewer to decide.",
      });
    }
    return {
      title: `${row.name}'s assignment — ${what}`,
      verb: "Take away",
      confirmWord: typeable(row.name, "REVOKE"),
      items,
      blockers: row.revokedAt ? ["That assignment was already taken away."] : [],
    };
  },
};

/* --------------------------------------------- a request, revoked or withdrawn */

async function requestFacts(id: string) {
  const [req] = await db
    .select({
      id: websiteChangeRequest.id,
      status: websiteChangeRequest.status,
      submitterId: websiteChangeRequest.submitterId,
      submitter: users.name,
    })
    .from(websiteChangeRequest)
    .innerJoin(users, eq(users.id, websiteChangeRequest.submitterId))
    .where(eq(websiteChangeRequest.id, id))
    .limit(1);
  if (!req) return null;
  const items = await db
    .select({ kind: websiteChangeItem.kind, slug: websiteChangeItem.slug, proposed: websiteChangeItem.proposedData })
    .from(websiteChangeItem)
    .where(eq(websiteChangeItem.requestId, id));
  const labels = items.map((i) => labelOf({ kind: i.kind, data: i.proposed, slug: i.slug }));
  return { req, labels };
}

/** The items a closed request lets go of — the one thing both acts certainly do. */
function freed(labels: string[]): ImpactItem {
  return {
    app: WEBSITE,
    label: labels.length === 1 ? "item that can be edited again" : "items that can be edited again",
    effect: "changed",
    count: labels.length,
    examples: labels.slice(0, 5),
    note: "No longer held by this request. To go live they have to be submitted and reviewed again.",
  };
}

const nothingLive: ImpactItem = {
  app: LIVE,
  label: "what visitors see",
  effect: "kept",
  count: 0,
  note: "Nothing from this request was published, so nothing on the live site changes.",
};

/** `site-approval-revoke` — `revokeApproval`. */
export const approvalRevokeImpact: ImpactSource = {
  async authorize() {
    pass(await gateReview());
  },
  async report(id) {
    const facts = await requestFacts(id);
    if (!facts) return null;
    const { req, labels } = facts;
    const me = await requireUser();
    const blockers: string[] = [];
    if (req.submitterId === me.id) blockers.push("You cannot revoke the approval of your own submission — withdraw it instead.");
    else if (req.status !== "approved") blockers.push(wrongState(req, "revoked"));
    return {
      title: `the approval of ${req.submitter}'s request`,
      verb: "Revoke",
      confirmWord: "REVOKE",
      items: [
        {
          app: WEBSITE,
          label: "approval given back",
          effect: "deleted",
          count: 1,
          note: "Its seven days to publish end now. Nothing in it can go live until it is reviewed again.",
        },
        freed(labels),
        {
          app: "MahekOne",
          label: "notification to the person who submitted it",
          effect: "changed",
          count: 1,
          examples: [req.submitter],
          note: "They are told it was revoked, and by whom.",
        },
        nothingLive,
      ],
      blockers,
    };
  },
};

/** `site-request-withdraw` — `withdrawRequest`. The submitter, or a reviewer for them — as `readRequest` lets in. */
export const requestWithdrawImpact: ImpactSource = {
  async authorize(id) {
    const me = pass(await gateWorkflow());
    const [req] = await db
      .select({ submitterId: websiteChangeRequest.submitterId })
      .from(websiteChangeRequest)
      .where(eq(websiteChangeRequest.id, id))
      .limit(1);
    if (req && req.submitterId !== me.id && !(await holdsReview(me.id))) {
      throw new Error("Only the person who submitted this can withdraw it.");
    }
  },
  async report(id) {
    const facts = await requestFacts(id);
    if (!facts) return null;
    const { req, labels } = facts;
    const status = req.status as RequestStatus;
    const items: ImpactItem[] = [freed(labels)];
    if (status === "approved") {
      items.push({
        app: WEBSITE,
        label: "approval given up",
        effect: "deleted",
        count: 1,
        note: "It was approved and not yet published. Withdrawn, it needs a fresh review before any of it can go live.",
      });
    } else if (status === "submitted") {
      items.push({
        app: WEBSITE,
        label: "request waiting in the reviewers' queue",
        effect: "deleted",
        count: 1,
        note: "Reviewers stop seeing it.",
      });
    }
    items.push(nothingLive);
    return {
      title: `${req.submitter}'s request`,
      verb: "Withdraw",
      confirmWord: "WITHDRAW",
      items,
      blockers: canTransition(status, "withdrawn") ? [] : [wrongState(req, "withdrawn")],
    };
  },
};
