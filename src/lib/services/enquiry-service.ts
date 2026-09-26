import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  customers,
  enquiries,
  enquiryActivity,
  enquiryOrders,
  orders,
  reminders,
  users,
} from "@/db/schema";

import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import type { AppId } from "@/lib/apps";
import { err, ok, okVoid, type Err, type Result } from "@/lib/result";
import type { User } from "@/db/schema";
import {
  readSubmissionFields,
  phoneDigits,
  buildEnquirySearchText,
  readLeadPrefill,
  type LeadPrefill,
} from "@/lib/enquiry-submission";
import { leadConvertibility, sourceFormLabel } from "@/lib/enquiry-labels";
import type {
  EnquiryCursor,
  EnquiryPriority,
  EnquiryReminderType,
  EnquirySource,
  EnquiryStage,
} from "@/lib/enquiry-labels";
import { createReminder as createSharedReminder } from "./worklist-services";
import { notifyUser } from "@/lib/notify";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * This module's own identity in the shared app registry (`lib/apps.ts`,
 * `app_id` in schema.ts) — typed against `AppId` rather than left as a bare
 * string repeated at every call site, so a rename of the app id anywhere in
 * that registry is a compile error here instead of five literals quietly
 * drifting from it. It is a fixed identifier, not a client-supplied value:
 * nothing in `WebsiteEnquiryInput` carries a workspace field for a caller to
 * override this with, and it never varies by request.
 */
const ENQUIRY_WORKSPACE: AppId = "enquiries";

/**
 * The one source this public endpoint has ever written — typed against the
 * existing `EnquirySource` vocabulary (`enquiry-labels.ts`) rather than a
 * second, disconnected literal. Also fixed rather than client-supplied: the
 * website ingestion payload (`enquiry-ingest-validation.ts`) carries no
 * `source` field at all, so there is nothing for a caller to send instead of
 * it. `EnquirySource` already provisions `instagram`/`whatsapp`/`indiamart`/
 * etc. for whenever a second ingestion path is actually built — this constant
 * does not need to "become dynamic" to support that; a second path would
 * define its own constant the same way, from the same shared type.
 */
const ENQUIRY_SOURCE_WEBSITE: EnquirySource = "website";

/* ---------------------------------------------------------------------------
 * Website Enquiries is its own app, so its own grant is what authorises
 * every read and write here — not a role, and not any of the CRM's
 * capabilities, which have nothing to say about a workspace they do not
 * know exists. The same "one function, checked by every action" shape
 * `requireHrms()` uses in `lib/actions/org.ts`.
 * ------------------------------------------------------------------------- */
async function requireEnquiriesAccess(): Promise<
  { user: User; error: null } | { user: null; error: Err }
> {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes(ENQUIRY_WORKSPACE)) {
    return {
      user: null,
      error: err("Only somebody with Website Enquiries access can do that.", "not_permitted"),
    };
  }
  return { user, error: null };
}

async function writeActivity(
  enquiryId: string,
  kind: string,
  actorUserId: string | null,
  note?: string | null,
  meta?: Record<string, unknown> | null,
) {
  await db.insert(enquiryActivity).values({
    id: id("act"),
    enquiryId,
    kind,
    actorUserId,
    note: note ?? null,
    meta: meta ?? null,
  });
}

/* ---------------------------------------------------------- public ingestion */

export type WebsiteEnquiryInput = {
  /** e.g. "CONTACT", "PRODUCT_ENQUIRY" — the website's own stable form identifier, reused verbatim as `sourceForm`. */
  sourceForm: string;
  /**
   * e.g. "GENERAL", "SALES" — the website's own coarse classification,
   * reused verbatim as `category`. Optional: an older producer, or a
   * submission that never sent one, passes null/undefined and the column
   * stays null rather than a guessed value.
   */
  category?: string | null;
  /** The website's own enquiry id (a UUID it generated for this submission) — the idempotency key. Not a phone number, not a timestamp. */
  externalRef: string;
  /** When the website's own backend received it, not a browser-supplied time. */
  receivedAt: Date;
  /** The validated common + form-specific fields, stored exactly as the website's own validation produced them. */
  submission: Record<string, unknown>;
};

export type WebsiteEnquiryResult = { id: string; duplicate: boolean };

/**
 * The one door a website submission comes through. No session, no
 * capability — the caller (the public route) has already proven it holds
 * the shared ingest secret, and that is the whole of this boundary's
 * authority: create an enquiry, nothing else. `customerId` is deliberately
 * never set here — Phase 4's matching workflow is what turns a phone number
 * into a confirmed link, and duplicating that here would be a second,
 * divergent way to reach the same decision.
 *
 * Idempotent on (`source`, `externalRef`): a genuine retransmission of the
 * same website submission returns the row that already exists rather than
 * creating a second one. This is NOT the same question as "did this
 * customer already enquire" — that one stays a warning, on the Phase 4
 * detail page, and is never enforced here.
 *
 * BOTH columns, because that is what the unique index is on. An id from a
 * future source is a different id space and may legitimately collide with a
 * website ref — matched on the ref alone, the second source's submission
 * would be answered with the WEBSITE's enquiry, reported as a duplicate, and
 * never stored, with the sender receiving a 200 for a row that does not
 * exist.
 */
export async function createEnquiryFromWebsite(
  input: WebsiteEnquiryInput,
): Promise<WebsiteEnquiryResult> {
  const [existing] = await db
    .select({ id: enquiries.id })
    .from(enquiries)
    .where(and(eq(enquiries.source, ENQUIRY_SOURCE_WEBSITE), eq(enquiries.externalRef, input.externalRef)));
  if (existing) return { id: existing.id, duplicate: true };

  const enquiryId = id("enq");
  try {
    await db.transaction(async (tx) => {
      await tx.insert(enquiries).values({
        id: enquiryId,
        workspace: ENQUIRY_WORKSPACE,
        customerId: null,
        source: ENQUIRY_SOURCE_WEBSITE,
        sourceForm: input.sourceForm,
        category: input.category ?? null,
        rawSubmission: input.submission,
        searchText: buildEnquirySearchText(input.submission),
        stage: "new",
        priority: "normal",
        assignedToId: null,
        receivedAt: input.receivedAt,
        externalRef: input.externalRef,
        // No human created this — the website's own backend did, and nothing
        // in this schema requires a real user id here (see schema.ts).
        createdById: null,
        updatedById: null,
      });
      await tx.insert(enquiryActivity).values({
        id: id("act"),
        enquiryId,
        kind: "received",
        actorUserId: null,
        note: "Enquiry received from the website.",
        meta: { sourceForm: input.sourceForm },
      });
    });
  } catch (e) {
    // A concurrent retry that lost the race above hits the unique index on
    // (source, external_ref) here instead — same outcome, resolved the same
    // way: return the row that won, not an error to a caller that did nothing
    // wrong.
    if (e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === "23505") {
      const [row] = await db
        .select({ id: enquiries.id })
        .from(enquiries)
        .where(and(eq(enquiries.source, ENQUIRY_SOURCE_WEBSITE), eq(enquiries.externalRef, input.externalRef)));
      if (row) return { id: row.id, duplicate: true };
    }
    throw e;
  }

  return { id: enquiryId, duplicate: false };
}

/* ------------------------------------------------------------- assignable */

export type AssignableUser = { id: string; name: string };

/**
 * Who is a valid assignee — read from the grant, never hardcoded. Anybody
 * holding the Website Enquiries app, and active, exactly the same rule the
 * Admin Console's own candidate lists already follow.
 */
export async function assignableUsers(): Promise<AssignableUser[]> {
  const { error } = await requireEnquiriesAccess();
  if (error) throw new Error(error.error);

  return db
    .selectDistinct({ id: users.id, name: users.name })
    .from(users)
    .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, ENQUIRY_WORKSPACE)))
    .where(eq(users.active, true))
    .orderBy(users.name);
}

/* --------------------------------------------------------------- dashboard */

export type EnquiryDashboardCounts = {
  total: number;
  byStage: Record<EnquiryStage, number>;
  unassigned: number;
  highOrUrgent: number;
};

export async function enquiryDashboardCounts(): Promise<EnquiryDashboardCounts> {
  const { error } = await requireEnquiriesAccess();
  if (error) throw new Error(error.error);

  const [row] = await db.execute<{
    total: number;
    new: number;
    contacted: number;
    follow_up: number;
    qualified: number;
    converted: number;
    closed: number;
    unassigned: number;
    high_or_urgent: number;
  }>(sql`
    select
      count(*)::int as total,
      count(*) filter (where stage = 'new')::int as new,
      count(*) filter (where stage = 'contacted')::int as contacted,
      count(*) filter (where stage = 'follow_up')::int as follow_up,
      count(*) filter (where stage = 'qualified')::int as qualified,
      count(*) filter (where stage = 'converted')::int as converted,
      count(*) filter (where stage = 'closed')::int as closed,
      count(*) filter (where assigned_to_id is null)::int as unassigned,
      count(*) filter (where priority in ('high','urgent'))::int as high_or_urgent
    from enquiries
    where workspace = 'enquiries'
  `);

  return {
    total: row?.total ?? 0,
    byStage: {
      new: row?.new ?? 0,
      contacted: row?.contacted ?? 0,
      follow_up: row?.follow_up ?? 0,
      qualified: row?.qualified ?? 0,
      converted: row?.converted ?? 0,
      closed: row?.closed ?? 0,
    },
    unassigned: row?.unassigned ?? 0,
    highOrUrgent: row?.high_or_urgent ?? 0,
  };
}

/* -------------------------------------------------------------------- list */

export type EnquiryListItem = {
  id: string;
  name: string | null;
  phone: string | null;
  company: string | null;
  source: string;
  sourceForm: string | null;
  category: string | null;
  stage: EnquiryStage;
  priority: EnquiryPriority;
  assignedToId: string | null;
  assignedToName: string | null;
  receivedAt: string;
  customerId: string | null;
  customerName: string | null;
};

export type EnquiryFilters = {
  q?: string;
  stage?: EnquiryStage;
  priority?: EnquiryPriority;
  source?: string;
  assignedToId?: string | "unassigned";
  linked?: "linked" | "unlinked";
  sort?: "received_desc" | "received_asc";
  /**
   * A KEYSET, not an offset — the `(receivedAt, id)` of the last row of the
   * PREVIOUS page. Null/omitted asks for the first page. `customerTimeline`
   * already proves this shape out for the same reason: an offset re-reads and
   * re-sorts everything skipped, and shifts under a write — an enquiry
   * received while somebody reads page two pushes a row they have already
   * seen onto page three.
   */
  cursor?: EnquiryCursor | null;
  pageSize?: number;
};

export async function listEnquiries(
  filters: EnquiryFilters,
): Promise<{ items: EnquiryListItem[]; total: number; cursor: EnquiryCursor | null; more: boolean }> {
  const { error } = await requireEnquiriesAccess();
  if (error) throw new Error(error.error);

  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));
  // received_at alone cannot break a tie between two enquiries the website
  // posted in the same millisecond — id, the primary key, always can.
  const descending = filters.sort !== "received_asc";

  const conditions = [eq(enquiries.workspace, ENQUIRY_WORKSPACE)];
  if (filters.stage) conditions.push(eq(enquiries.stage, filters.stage));
  if (filters.priority) conditions.push(eq(enquiries.priority, filters.priority));
  if (filters.source) conditions.push(eq(enquiries.source, filters.source));
  if (filters.assignedToId === "unassigned") {
    conditions.push(sql`${enquiries.assignedToId} is null`);
  } else if (filters.assignedToId) {
    conditions.push(eq(enquiries.assignedToId, filters.assignedToId));
  }
  if (filters.linked === "linked") conditions.push(sql`${enquiries.customerId} is not null`);
  if (filters.linked === "unlinked") conditions.push(sql`${enquiries.customerId} is null`);
  /*
   * A search term matches `search_text` — the submitted name/phone/email/
   * company/message VALUES, joined at write time — or the customer name once
   * linked. Never `rawSubmission::text`: that cast serialises the whole
   * JSON object, key names included, so searching "email" or "phone" matched
   * every enquiry that HAD one rather than none. `search_text` is trigram-
   * indexed (`enquiries_search_text_trgm_idx`), the same way `customers.name`
   * already is, so this is no longer a sequential scan of the raw JSON.
   */
  if (filters.q && filters.q.trim().length >= 2) {
    const like = `%${filters.q.trim()}%`;
    conditions.push(
      sql`(${enquiries.searchText} ilike ${like} or exists (
        select 1 from customers c where c.id = ${enquiries.customerId} and c.name ilike ${like}
      ))`,
    );
  }

  // Counted against the FILTERS alone, never the cursor — a page break must
  // not change how many enquiries the header says are in view.
  const countWhere = and(...conditions);

  /*
   * `(received_at, id)` compared as a TUPLE, exactly as `customerTimeline`
   * does for `(at, id)` — a thousand enquiries could in principle share one
   * `received_at`, so the single-column version leaves their order to the
   * planner. That is invisible until it is paged, and then it is a row
   * appearing on two pages while another appears on none.
   */
  if (filters.cursor) {
    const { receivedAt, id: cursorId } = filters.cursor;
    conditions.push(
      descending
        ? sql`(${enquiries.receivedAt}, ${enquiries.id}) < (${receivedAt}::timestamptz, ${cursorId})`
        : sql`(${enquiries.receivedAt}, ${enquiries.id}) > (${receivedAt}::timestamptz, ${cursorId})`,
    );
  }
  const where = and(...conditions);

  const [rows, [{ count }]] = await Promise.all([
    db
      .select({
        id: enquiries.id,
        rawSubmission: enquiries.rawSubmission,
        source: enquiries.source,
        sourceForm: enquiries.sourceForm,
        category: enquiries.category,
        stage: enquiries.stage,
        priority: enquiries.priority,
        assignedToId: enquiries.assignedToId,
        assignedToName: users.name,
        receivedAt: enquiries.receivedAt,
        customerId: enquiries.customerId,
        customerName: customers.name,
      })
      .from(enquiries)
      .leftJoin(users, eq(users.id, enquiries.assignedToId))
      .leftJoin(customers, eq(customers.id, enquiries.customerId))
      .where(where)
      .orderBy(
        descending ? desc(enquiries.receivedAt) : enquiries.receivedAt,
        descending ? desc(enquiries.id) : enquiries.id,
      )
      // One more than asked for, purely to know whether there is a next page
      // — the same trick `customerTimeline` uses, and for the same reason: a
      // "Next" button that turns out to load nothing is worse than one that
      // was never enabled.
      .limit(pageSize + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(enquiries).where(countWhere),
  ]);

  const more = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);

  const items: EnquiryListItem[] = pageRows.map((r) => {
    const fields = readSubmissionFields(r.rawSubmission);
    return {
      id: r.id,
      name: r.customerName ?? fields.name,
      phone: fields.phone,
      company: fields.company,
      source: r.source,
      sourceForm: r.sourceForm,
      category: r.category,
      stage: r.stage as EnquiryStage,
      priority: r.priority as EnquiryPriority,
      assignedToId: r.assignedToId,
      assignedToName: r.assignedToName,
      receivedAt: r.receivedAt.toISOString(),
      customerId: r.customerId,
      customerName: r.customerName,
    };
  });

  const lastItem = items[items.length - 1];
  const cursor: EnquiryCursor | null = lastItem
    ? { receivedAt: lastItem.receivedAt, id: lastItem.id }
    : null;

  return { items, total: count, cursor, more };
}

/* ------------------------------------------------------------------ detail */

export type EnquiryActivityEntry = {
  id: string;
  kind: string;
  at: string;
  actorName: string | null;
  note: string | null;
  meta: Record<string, unknown> | null;
};

export type EnquiryReminder = {
  id: string;
  dueDate: string;
  note: string;
  type: string;
  status: string;
  assignedToName: string | null;
};

export type EnquiryLinkedOrder = {
  linkId: string;
  orderId: string;
  orderNo: string | null;
  orderedAt: string;
  totalAmount: number;
  status: string;
};

export type EnquiryDetail = {
  id: string;
  source: string;
  sourceForm: string | null;
  category: string | null;
  rawSubmission: Record<string, unknown>;
  stage: EnquiryStage;
  priority: EnquiryPriority;
  assignedToId: string | null;
  assignedToName: string | null;
  receivedAt: string;
  externalRef: string | null;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerCity: string | null;
  /** `lead` while the linked account has never ordered — the desk's own word for what it is. */
  customerKind: string | null;
  /** Who owns the linked lead, so an enquiry turned into a lead says whether anybody has it yet. */
  customerOwnerName: string | null;
  activity: EnquiryActivityEntry[];
  remindersList: EnquiryReminder[];
  linkedOrders: EnquiryLinkedOrder[];
};

export async function getEnquiry(enquiryId: string): Promise<EnquiryDetail | null> {
  const { error } = await requireEnquiriesAccess();
  if (error) throw new Error(error.error);

  const [row] = await db
    .select({
      id: enquiries.id,
      source: enquiries.source,
      sourceForm: enquiries.sourceForm,
      category: enquiries.category,
      rawSubmission: enquiries.rawSubmission,
      stage: enquiries.stage,
      priority: enquiries.priority,
      assignedToId: enquiries.assignedToId,
      assignedToName: users.name,
      receivedAt: enquiries.receivedAt,
      externalRef: enquiries.externalRef,
      customerId: enquiries.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerCity: customers.city,
      customerKind: customers.kind,
      customerOwnerName: sql<string | null>`(select name from users where users.id = customers.owner_id)`,
    })
    .from(enquiries)
    .leftJoin(users, eq(users.id, enquiries.assignedToId))
    .leftJoin(customers, eq(customers.id, enquiries.customerId))
    .where(eq(enquiries.id, enquiryId))
    .limit(1);

  if (!row) return null;

  const [activityRows, reminderRows, orderRows] = await Promise.all([
    db
      .select({
        id: enquiryActivity.id,
        kind: enquiryActivity.kind,
        at: enquiryActivity.at,
        note: enquiryActivity.note,
        meta: enquiryActivity.meta,
        actorName: users.name,
      })
      .from(enquiryActivity)
      .leftJoin(users, eq(users.id, enquiryActivity.actorUserId))
      .where(eq(enquiryActivity.enquiryId, enquiryId))
      .orderBy(desc(enquiryActivity.at)),
    db
      .select({
        id: reminders.id,
        dueDate: reminders.dueDate,
        note: reminders.note,
        type: reminders.type,
        status: reminders.status,
        assignedToName: users.name,
      })
      .from(reminders)
      .leftJoin(users, eq(users.id, reminders.assignedUserId))
      .where(eq(reminders.enquiryId, enquiryId))
      .orderBy(desc(reminders.dueDate)),
    db
      .select({
        linkId: enquiryOrders.id,
        orderId: orders.id,
        orderNo: orders.orderNo,
        // Converted to the business's own calendar date IN SQL, the same way
        // `customer-record-service.ts` already does for this exact column —
        // `orders.ordered_at` is a timestamptz, and serialising it with
        // `.toISOString()` in JS answers in UTC. For any order placed between
        // midnight and ~5:30am IST, that reads as the PREVIOUS calendar day
        // once it reaches `shortDateWithYear`, which only ever looks at a
        // string's own leading `YYYY-MM-DD`.
        orderedAt: sql<string>`to_char(${orders.orderedAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`,
        totalAmount: orders.totalAmount,
        status: orders.status,
      })
      .from(enquiryOrders)
      .innerJoin(orders, eq(orders.id, enquiryOrders.orderId))
      .where(eq(enquiryOrders.enquiryId, enquiryId))
      .orderBy(desc(orders.orderedAt)),
  ]);

  return {
    id: row.id,
    source: row.source,
    sourceForm: row.sourceForm,
    category: row.category,
    rawSubmission: (row.rawSubmission as Record<string, unknown>) ?? {},
    stage: row.stage as EnquiryStage,
    priority: row.priority as EnquiryPriority,
    assignedToId: row.assignedToId,
    assignedToName: row.assignedToName,
    receivedAt: row.receivedAt.toISOString(),
    externalRef: row.externalRef,
    customerId: row.customerId,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    customerCity: row.customerCity,
    customerKind: row.customerKind,
    customerOwnerName: row.customerOwnerName,
    activity: activityRows.map((a) => ({
      id: a.id,
      kind: a.kind,
      at: a.at.toISOString(),
      actorName: a.actorName,
      note: a.note,
      meta: (a.meta as Record<string, unknown>) ?? null,
    })),
    remindersList: reminderRows.map((r) => ({
      id: r.id,
      dueDate: r.dueDate,
      note: r.note,
      type: r.type,
      status: r.status,
      assignedToName: r.assignedToName,
    })),
    linkedOrders: orderRows.map((o) => ({
      linkId: o.linkId,
      orderId: o.orderId,
      orderNo: o.orderNo,
      orderedAt: o.orderedAt,
      totalAmount: o.totalAmount,
      status: o.status,
    })),
  };
}

/**
 * The first person to open it gets the `viewed` event; nobody else does.
 * Best-effort — a failure here must never stop the page rendering, which is
 * why the caller wraps this rather than this wrapping itself.
 */
export async function markEnquiryViewedIfFirst(enquiryId: string, userId: string): Promise<void> {
  const { error } = await requireEnquiriesAccess();
  if (error) throw new Error(error.error);

  const [already] = await db
    .select({ id: enquiryActivity.id })
    .from(enquiryActivity)
    .where(and(eq(enquiryActivity.enquiryId, enquiryId), eq(enquiryActivity.kind, "viewed")))
    .limit(1);
  if (already) return;
  await writeActivity(enquiryId, "viewed", userId);
}

/* ------------------------------------------------------------ mutations */

export async function assignEnquiry(
  enquiryId: string,
  assignToId: string | null,
): Promise<Result> {
  const { user, error } = await requireEnquiriesAccess();
  if (error) return error;

  const [before] = await db
    .select({ assignedToId: enquiries.assignedToId })
    .from(enquiries)
    .where(eq(enquiries.id, enquiryId));
  if (!before) return err("That enquiry no longer exists.", "not_found");
  // The same no-op guard `changeStage` and `changePriority` keep below: naming
  // the person who already holds it — or unassigning what nobody holds — is
  // not a transition, and an activity trail that records one reads as work
  // having moved when none did.
  if (before.assignedToId === assignToId) return okVoid();

  let assignedName: string | null = null;
  if (assignToId) {
    const [target] = await db.select({ name: users.name }).from(users).where(eq(users.id, assignToId));
    if (!target) return err("That person could not be found.", "not_found");
    // `assignableUsers()` already offers only people holding this app in the
    // UI's own dropdown; this is the same defense-in-depth this file already
    // applies elsewhere (Medium #15) — a direct service call must not be able
    // to assign an enquiry to somebody who can never open it to see it.
    const targetApps = await listUserApps(assignToId);
    if (!targetApps.includes(ENQUIRY_WORKSPACE)) {
      return err("That person does not have Website Enquiries access.", "rule_violation");
    }
    assignedName = target.name;
  }

  await db
    .update(enquiries)
    .set({ assignedToId: assignToId, updatedAt: new Date(), updatedById: user.id })
    .where(eq(enquiries.id, enquiryId));

  // Read off the transition that actually happened rather than off the BEFORE
  // alone: with no previous assignee, `!before.assignedToId` called an
  // unassignment "assigned", and the trail printed "Assigned · Unassigned."
  const kind = !assignToId ? "unassigned" : before.assignedToId ? "reassigned" : "assigned";
  await writeActivity(
    enquiryId,
    kind,
    user.id,
    assignToId ? `Assigned to ${assignedName}.` : "Unassigned.",
    { from: before.assignedToId, to: assignToId },
  );

  /*
   * Told because work has moved onto (or off) somebody's queue without them
   * asking — the same reasoning `account-manager.ts`/`sales-manager.ts`
   * already apply to reassigning an account (Senior finding #21). A no-op
   * (the same person named again) tells nobody, and the actor is never told
   * about their own action, matching `order-approval-service.ts`'s
   * `tellTheAuthor`. Best-effort, on top of the write above: `notifyUser`'s
   * own insert failing must never undo an assignment that has already
   * committed, so its failure is swallowed exactly as the two other
   * `notifyUser(...).catch(() => {})` call sites in this codebase do.
   */
  const previousAssigneeId = before.assignedToId;
  if (assignToId !== previousAssigneeId) {
    if (assignToId && assignToId !== user.id) {
      await notifyUser({
        userId: assignToId,
        title: "Website enquiry assigned to you",
        body: `${user.name} assigned you a website enquiry to follow up.`,
        kind: "info",
        href: `/enquiries/list/${enquiryId}`,
      }).catch(() => {});
    }
    if (previousAssigneeId && previousAssigneeId !== user.id) {
      await notifyUser({
        userId: previousAssigneeId,
        title: assignToId ? "Website enquiry moved from you" : "Website enquiry unassigned",
        body: assignToId
          ? `${user.name} reassigned your enquiry to ${assignedName}.`
          : `${user.name} unassigned an enquiry that was yours.`,
        kind: "info",
        href: `/enquiries/list/${enquiryId}`,
      }).catch(() => {});
    }
  }

  return okVoid("Assignment updated.");
}

export async function changeStage(enquiryId: string, stage: EnquiryStage): Promise<Result> {
  const { user, error } = await requireEnquiriesAccess();
  if (error) return error;

  const [before] = await db.select({ stage: enquiries.stage }).from(enquiries).where(eq(enquiries.id, enquiryId));
  if (!before) return err("That enquiry no longer exists.", "not_found");
  if (before.stage === stage) return okVoid();

  await db
    .update(enquiries)
    .set({ stage, updatedAt: new Date(), updatedById: user.id })
    .where(eq(enquiries.id, enquiryId));

  await writeActivity(enquiryId, "stage_changed", user.id, null, { from: before.stage, to: stage });
  return okVoid("Stage updated.");
}

export async function changePriority(enquiryId: string, priority: EnquiryPriority): Promise<Result> {
  const { user, error } = await requireEnquiriesAccess();
  if (error) return error;

  const [before] = await db.select({ priority: enquiries.priority }).from(enquiries).where(eq(enquiries.id, enquiryId));
  if (!before) return err("That enquiry no longer exists.", "not_found");
  if (before.priority === priority) return okVoid();

  await db
    .update(enquiries)
    .set({ priority, updatedAt: new Date(), updatedById: user.id })
    .where(eq(enquiries.id, enquiryId));

  await writeActivity(enquiryId, "priority_changed", user.id, null, { from: before.priority, to: priority });
  return okVoid("Priority updated.");
}

/* ----------------------------------------------------- customer matching */

export type CustomerMatch = {
  id: string;
  name: string;
  phone: string;
  city: string;
  kind: string;
};

/** Every customer, not scoped to the caller's own book — matching an enquiry to the right person matters more than whose book they are in. Still gated on Website Enquiries access: this is a phone-number lookup across the whole customer book, exposed as a server action, and it is not the CRM's own scoped search. */
export async function findCustomersByPhone(phone: string): Promise<Result<CustomerMatch[]>> {
  const { error } = await requireEnquiriesAccess();
  if (error) return error;

  const digits = phoneDigits(phone);
  if (!digits) return ok([]);
  const rows = await db
    .select({ id: customers.id, name: customers.name, phone: customers.phone, city: customers.city, kind: customers.kind })
    .from(customers)
    .where(ilike(customers.phone, `%${digits}%`))
    .limit(10);
  return ok(rows);
}

export async function linkCustomer(enquiryId: string, customerId: string): Promise<Result> {
  const { user, error } = await requireEnquiriesAccess();
  if (error) return error;

  const [enquiry] = await db.select({ id: enquiries.id }).from(enquiries).where(eq(enquiries.id, enquiryId));
  if (!enquiry) return err("That enquiry no longer exists.", "not_found");

  const [customer] = await db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.id, customerId));
  if (!customer) return err("That customer could not be found.", "not_found");

  /*
   * SET ONCE, and the WHERE clause is the guard rather than a read
   * beforehand. Two requests racing to link the same unlinked enquiry both
   * pass the existence checks above; only one UPDATE can actually match
   * `customer_id is null` once Postgres has taken the row's lock for it — the
   * loser's own UPDATE re-evaluates the WHERE clause against the now-
   * committed value and matches nothing, rather than silently overwriting
   * the winner. A confirmed match only ever sets the pointer — nothing about
   * the customer row itself is read back and written; the enquiry adapts to
   * the customer, never the other way round.
   */
  const [linked] = await db
    .update(enquiries)
    .set({ customerId, updatedAt: new Date(), updatedById: user.id })
    .where(and(eq(enquiries.id, enquiryId), isNull(enquiries.customerId)))
    .returning({ id: enquiries.id });

  if (!linked) {
    // The enquiry was confirmed to exist above, so a zero-row update here
    // means exactly one thing: it already has a customer, linked either
    // moments ago by a concurrent request or at any time before this one —
    // never overwritten, whether the request named the same customer again
    // or a different one.
    return err("This enquiry is already linked to a customer.", "conflict");
  }

  await writeActivity(enquiryId, "customer_linked", user.id, `Linked to ${customer.name}.`, { customerId });
  return okVoid("Customer linked.");
}

/* ------------------------------------------------------------ duplicates */

export type PossibleDuplicate = {
  id: string;
  receivedAt: string;
  source: string;
  stage: EnquiryStage;
  assignedToName: string | null;
};

/**
 * A plain substring match against `search_text` — there is no phone column to
 * index against, by design (§7 of the design phase), and a customer
 * legitimately raising a second enquiry is the ordinary case, not the error.
 * This is a WARNING, never a block.
 *
 * It matches `search_text` and NOT `raw_submission::text`, for the three
 * reasons `listEnquiries` already gives above. A cast of every row's jsonb to
 * text is a sequential scan of the whole table, on a query that runs each time
 * somebody opens a detail page, and it cannot use the trigram index the search
 * box was given. It also matches the digits ANYWHERE in the JSON, so a GSTIN,
 * an order reference or a pincode carrying that run of ten reads as somebody's
 * phone number. And it is the half that made the warning silently useless: a
 * submission is stored exactly as sent, so `%9820011001%` never matched a
 * visitor who typed `+91 98200 11001` — which `buildEnquirySearchText` now
 * normalises at write time.
 */
export async function findPossibleDuplicateEnquiries(
  enquiryId: string,
  phone: string | null,
): Promise<PossibleDuplicate[]> {
  const { error } = await requireEnquiriesAccess();
  if (error) throw new Error(error.error);

  const digits = phoneDigits(phone);
  if (!digits) return [];

  const rows = await db
    .select({
      id: enquiries.id,
      // The detail screen shows this via `shortDateWithYear`, which reads
      // only a string's own leading `YYYY-MM-DD` — so, exactly like
      // `orderedAt` above, this has to be the IST calendar date rather than
      // a UTC instant serialised with `.toISOString()`.
      receivedAt: sql<string>`to_char(${enquiries.receivedAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`,
      source: enquiries.source,
      stage: enquiries.stage,
      assignedToName: users.name,
    })
    .from(enquiries)
    .leftJoin(users, eq(users.id, enquiries.assignedToId))
    .where(
      and(
        eq(enquiries.workspace, ENQUIRY_WORKSPACE),
        sql`${enquiries.id} <> ${enquiryId}`,
        sql`${enquiries.searchText} ilike ${"%" + digits + "%"}`,
      ),
    )
    .orderBy(desc(enquiries.receivedAt))
    .limit(5);

  return rows.map((r) => ({
    id: r.id,
    receivedAt: r.receivedAt,
    source: r.source,
    stage: r.stage as EnquiryStage,
    assignedToName: r.assignedToName,
  }));
}

/* ----------------------------------------------------------------- notes */

export async function addNote(enquiryId: string, note: string): Promise<Result> {
  const { user, error } = await requireEnquiriesAccess();
  if (error) return error;
  const trimmed = note.trim();
  if (!trimmed) return err("Write something first.", "validation");

  const [enquiry] = await db.select({ id: enquiries.id }).from(enquiries).where(eq(enquiries.id, enquiryId));
  if (!enquiry) return err("That enquiry no longer exists.", "not_found");

  await writeActivity(enquiryId, "note", user.id, trimmed);
  await db.update(enquiries).set({ updatedAt: new Date() }).where(eq(enquiries.id, enquiryId));
  return okVoid("Note added.");
}

/* ------------------------------------------------------------- reminders */

export async function createEnquiryReminder(input: {
  enquiryId: string;
  dueDate: string;
  note: string;
  type: EnquiryReminderType;
  assignedUserId: string;
}): Promise<Result> {
  const { user, error } = await requireEnquiriesAccess();
  if (error) return error;
  if (!input.note.trim()) return err("Say what the follow-up is for.", "validation");
  if (!input.dueDate) return err("Pick a date.", "validation");

  const [enquiry] = await db
    .select({ id: enquiries.id, customerId: enquiries.customerId })
    .from(enquiries)
    .where(eq(enquiries.id, input.enquiryId));
  if (!enquiry) return err("That enquiry no longer exists.", "not_found");
  if (!enquiry.customerId) {
    return err("Link a customer to this enquiry before scheduling a follow-up.", "rule_violation");
  }

  const [assignee] = await db.select({ id: users.id }).from(users).where(eq(users.id, input.assignedUserId));
  if (!assignee) return err("That person could not be found.", "not_found");
  // Same defense-in-depth as assignEnquiry: a direct call must not be able to
  // hand a follow-up to somebody who cannot open Website Enquiries to see it.
  const assigneeApps = await listUserApps(input.assignedUserId);
  if (!assigneeApps.includes(ENQUIRY_WORKSPACE)) {
    return err("That person does not have Website Enquiries access.", "rule_violation");
  }

  /*
   * The actual write goes through the shared reminder service — the same
   * Zod validation, working-day roll-forward and insert every other reminder
   * in the CRM gets, rather than a second, divergent path into the same
   * table (Senior finding #3). `skipCustomerScope` is the one deliberate
   * difference: the shared service's `assertCustomerInScope` encodes the
   * CRM's own "mine/team/all" book, which has no meaning for Website
   * Enquiries' flat, company-wide app grant (Senior finding #21 audit,
   * "Finding #1") — the enquiry's own `requireEnquiriesAccess()` check above,
   * plus the `enquiry.customerId` lookup just above that, are this call's
   * own, independently-sufficient authorization for exactly this customer.
   */
  const created = await createSharedReminder(
    {
      customerId: enquiry.customerId,
      dueDate: input.dueDate,
      note: input.note,
      type: input.type,
      assignedUserId: input.assignedUserId,
      enquiryId: input.enquiryId,
    },
    { skipCustomerScope: true },
  );
  if (!created.ok) return created;

  await writeActivity(input.enquiryId, "reminder_created", user.id, input.note.trim(), {
    reminderId: created.data.id,
    dueDate: input.dueDate,
  });
  return okVoid("Follow-up scheduled.");
}

/* ---------------------------------------------------------------- orders */

export type OrderCandidate = {
  id: string;
  orderNo: string | null;
  orderedAt: string;
  totalAmount: number;
  status: string;
};

/** Only the linked customer's own orders — linking somebody else's order to this enquiry would not mean anything. */
export async function ordersForLinking(enquiryId: string): Promise<OrderCandidate[]> {
  const { error } = await requireEnquiriesAccess();
  if (error) throw new Error(error.error);

  const [enquiry] = await db.select({ customerId: enquiries.customerId }).from(enquiries).where(eq(enquiries.id, enquiryId));
  if (!enquiry?.customerId) return [];

  const alreadyLinked = db.select({ orderId: enquiryOrders.orderId }).from(enquiryOrders).where(eq(enquiryOrders.enquiryId, enquiryId));

  const rows = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      // Same fix as getEnquiry's linkedOrders, and for the same reason: this
      // is a timestamptz, and converting it to a calendar date has to name
      // the zone rather than let `.toISOString()` answer in UTC.
      orderedAt: sql<string>`to_char(${orders.orderedAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`,
      totalAmount: orders.totalAmount,
      status: orders.status,
    })
    .from(orders)
    .where(and(eq(orders.customerId, enquiry.customerId), notInArray(orders.id, alreadyLinked)))
    .orderBy(desc(orders.orderedAt))
    .limit(20);

  return rows.map((r) => ({ id: r.id, orderNo: r.orderNo, orderedAt: r.orderedAt, totalAmount: r.totalAmount, status: r.status }));
}

export async function linkOrder(enquiryId: string, orderId: string): Promise<Result> {
  const { user, error } = await requireEnquiriesAccess();
  if (error) return error;

  const [enquiry] = await db.select({ id: enquiries.id, customerId: enquiries.customerId }).from(enquiries).where(eq(enquiries.id, enquiryId));
  if (!enquiry) return err("That enquiry no longer exists.", "not_found");

  const [order] = await db.select({ id: orders.id, customerId: orders.customerId, orderNo: orders.orderNo }).from(orders).where(eq(orders.id, orderId));
  if (!order) return err("That order could not be found.", "not_found");

  // An unlinked enquiry has no customer to check an order against — the old
  // `enquiry.customerId && ...` guard short-circuited to false here and let
  // ANY order in the company through. `customerId === customerId` is the
  // only relationship an order-link may ever assert; it never runs the other
  // way (inferring or assigning a customer from the order), which is what
  // would have turned this into a back door around product decision #8.
  if (!enquiry.customerId) {
    return err("This enquiry must be linked to a customer before an order can be linked.", "rule_violation");
  }
  if (order.customerId !== enquiry.customerId) {
    return err("That order belongs to a different customer than this enquiry is linked to.", "rule_violation");
  }

  const [existing] = await db.select({ id: enquiryOrders.id }).from(enquiryOrders).where(and(eq(enquiryOrders.enquiryId, enquiryId), eq(enquiryOrders.orderId, orderId)));
  if (existing) return okVoid("Already linked.");

  await db.insert(enquiryOrders).values({ id: id("eno"), enquiryId, orderId, createdById: user.id });
  await writeActivity(enquiryId, "order_linked", user.id, order.orderNo ? `Linked order ${order.orderNo}.` : "Linked an order.", { orderId });
  return okVoid("Order linked.");
}

export async function unlinkOrder(enquiryId: string, orderId: string): Promise<Result> {
  const { user, error } = await requireEnquiriesAccess();
  if (error) return error;

  const [link] = await db.select({ id: enquiryOrders.id }).from(enquiryOrders).where(and(eq(enquiryOrders.enquiryId, enquiryId), eq(enquiryOrders.orderId, orderId)));
  if (!link) return okVoid();

  // Removes only the LINK row — the order itself is never touched.
  await db.delete(enquiryOrders).where(eq(enquiryOrders.id, link.id));
  await writeActivity(enquiryId, "order_unlinked", user.id, null, { orderId });
  return okVoid("Order unlinked.");
}

/* ------------------------------------------------- an enquiry becomes a lead */

/**
 * THE ENQUIRY → LEAD BRIDGE, and it is deliberately not a second way to make a
 * lead. The lead itself is raised by `captureLead` — the one writer, with its
 * own duplicate guard, source check and Suspect rung — and this file supplies
 * only the two things that writer cannot know about an enquiry: whether THIS
 * one may become a lead and what it already tells us, and the link back, made
 * inside the SAME transaction as the lead so there is no state in which a lead
 * exists and its enquiry does not say so.
 *
 * Manual by design. Nothing here runs on receipt: a person reads the enquiry,
 * decides it is worth a call, and asks for the lead.
 */
export type EnquiryForLead = {
  id: string;
  /** The `leads.sources` code the lead is raised under — the enquiry's own source, which is always the website today. */
  leadSource: string;
  /** What the enquiry was — kept on the lead as its source detail. */
  sourceDetail: string;
  form: string;
  formLabel: string;
  prefill: LeadPrefill;
  receivedAt: string;
};

export async function enquiryForLeadConversion(enquiryId: string): Promise<Result<EnquiryForLead>> {
  const { error } = await requireEnquiriesAccess();
  if (error) return error;

  const [row] = await db
    .select({
      id: enquiries.id,
      source: enquiries.source,
      sourceForm: enquiries.sourceForm,
      category: enquiries.category,
      rawSubmission: enquiries.rawSubmission,
      customerId: enquiries.customerId,
      customerName: customers.name,
      receivedAt: enquiries.receivedAt,
    })
    .from(enquiries)
    .leftJoin(customers, eq(customers.id, enquiries.customerId))
    .where(eq(enquiries.id, enquiryId));
  if (!row) return err("That enquiry no longer exists.", "not_found");

  const may = leadConvertibility(row);
  if (!may.ok) return err(may.reason, "rule_violation");

  if (row.customerId) {
    return err(
      `This enquiry already has ${row.customerName ? `a lead — ${row.customerName}` : "a customer"}. It cannot be turned into a second one.`,
      "conflict",
    );
  }

  const formLabel = sourceFormLabel(row.sourceForm) ?? "Enquiry";
  return ok({
    id: row.id,
    leadSource: ENQUIRY_SOURCE_WEBSITE,
    sourceDetail: `${formLabel} form on the website`,
    form: row.sourceForm ?? "",
    formLabel,
    prefill: readLeadPrefill(row.rawSubmission),
    receivedAt: row.receivedAt.toISOString(),
  });
}

/** Thrown from inside the lead's transaction, so the lead rolls back with it. */
export class EnquiryLeadConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnquiryLeadConflict";
  }
}

/**
 * Point the enquiry at the lead just created, in the caller's transaction.
 *
 * The WHERE CLAUSE IS THE GUARD, not a read beforehand — the same rule
 * `linkCustomer` follows: two people pressing Create lead on one enquiry both
 * pass the pre-check, and only one UPDATE can match `customer_id is null` once
 * Postgres has taken the row's lock. The loser matches nothing, throws, and its
 * whole transaction — its lead included — is undone, so a second lead never
 * exists for the same enquiry.
 */
export async function linkEnquiryToNewLead(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { enquiryId: string; customerId: string; leadName: string; actorId: string },
): Promise<void> {
  const [linked] = await tx
    .update(enquiries)
    .set({ customerId: input.customerId, updatedAt: new Date(), updatedById: input.actorId })
    .where(and(eq(enquiries.id, input.enquiryId), isNull(enquiries.customerId)))
    .returning({ id: enquiries.id });
  if (!linked) {
    throw new EnquiryLeadConflict(
      "This enquiry was just turned into a lead by somebody else, so nothing was created.",
    );
  }
  await tx.insert(enquiryActivity).values({
    id: id("act"),
    enquiryId: input.enquiryId,
    kind: "lead_created",
    actorUserId: input.actorId,
    note: `Lead created from this enquiry: ${input.leadName}.`,
    meta: { customerId: input.customerId },
  });
}
