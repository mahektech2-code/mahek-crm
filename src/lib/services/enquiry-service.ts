import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, notInArray, sql } from "drizzle-orm";
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

/** The reminder types this enquiry form offers — the same six the rest of the CRM's reminders already use. */
type ReminderType =
  | "call_back"
  | "payment_promise"
  | "order_confirmation"
  | "send_information"
  | "check_stock"
  | "other";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { err, ok, okVoid, type Result } from "@/lib/result";
import type { User } from "@/db/schema";
import { readSubmissionFields, phoneDigits } from "@/lib/enquiry-submission";
import type { EnquiryPriority, EnquiryStage } from "@/lib/enquiry-labels";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ---------------------------------------------------------------------------
 * Website Enquiries is its own app, so its own grant is what authorises
 * every read and write here — not a role, and not any of the CRM's
 * capabilities, which have nothing to say about a workspace they do not
 * know exists. The same "one function, checked by every action" shape
 * `requireHrms()` uses in `lib/actions/org.ts`.
 * ------------------------------------------------------------------------- */
async function requireEnquiriesAccess(): Promise<
  { user: User; error: null } | { user: null; error: Result<never> }
> {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("enquiries")) {
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
 * Idempotent on `externalRef`: a genuine retransmission of the same
 * website submission returns the row that already exists rather than
 * creating a second one. This is NOT the same question as "did this
 * customer already enquire" — that one stays a warning, on the Phase 4
 * detail page, and is never enforced here.
 */
export async function createEnquiryFromWebsite(
  input: WebsiteEnquiryInput,
): Promise<WebsiteEnquiryResult> {
  const [existing] = await db
    .select({ id: enquiries.id })
    .from(enquiries)
    .where(eq(enquiries.externalRef, input.externalRef));
  if (existing) return { id: existing.id, duplicate: true };

  const enquiryId = id("enq");
  try {
    await db.transaction(async (tx) => {
      await tx.insert(enquiries).values({
        id: enquiryId,
        workspace: "enquiries",
        customerId: null,
        source: "website",
        sourceForm: input.sourceForm,
        rawSubmission: input.submission,
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
    // externalRef here instead — same outcome, resolved the same way: return
    // the row that won, not an error to a caller that did nothing wrong.
    if (e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === "23505") {
      const [row] = await db.select({ id: enquiries.id }).from(enquiries).where(eq(enquiries.externalRef, input.externalRef));
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
  return db
    .selectDistinct({ id: users.id, name: users.name })
    .from(users)
    .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "enquiries")))
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
  page?: number;
  pageSize?: number;
};

export async function listEnquiries(
  filters: EnquiryFilters,
): Promise<{ items: EnquiryListItem[]; total: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));

  const conditions = [eq(enquiries.workspace, "enquiries")];
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
  // A search term matches the raw submission text (name/phone/email/company all live there)
  // or the customer name once linked — a plain substring match, same spirit as globalSearch's.
  if (filters.q && filters.q.trim().length >= 2) {
    const like = `%${filters.q.trim()}%`;
    conditions.push(
      sql`(${enquiries.rawSubmission}::text ilike ${like} or exists (
        select 1 from customers c where c.id = ${enquiries.customerId} and c.name ilike ${like}
      ))`,
    );
  }

  const where = and(...conditions);
  const orderBy =
    filters.sort === "received_asc" ? enquiries.receivedAt : desc(enquiries.receivedAt);

  const [rows, [{ count }]] = await Promise.all([
    db
      .select({
        id: enquiries.id,
        rawSubmission: enquiries.rawSubmission,
        source: enquiries.source,
        sourceForm: enquiries.sourceForm,
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
      .orderBy(orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ count: sql<number>`count(*)::int` }).from(enquiries).where(where),
  ]);

  const items: EnquiryListItem[] = rows.map((r) => {
    const fields = readSubmissionFields(r.rawSubmission);
    return {
      id: r.id,
      name: r.customerName ?? fields.name,
      phone: fields.phone,
      company: fields.company,
      source: r.source,
      sourceForm: r.sourceForm,
      stage: r.stage as EnquiryStage,
      priority: r.priority as EnquiryPriority,
      assignedToId: r.assignedToId,
      assignedToName: r.assignedToName,
      receivedAt: r.receivedAt.toISOString(),
      customerId: r.customerId,
      customerName: r.customerName,
    };
  });

  return { items, total: count };
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
  activity: EnquiryActivityEntry[];
  remindersList: EnquiryReminder[];
  linkedOrders: EnquiryLinkedOrder[];
};

export async function getEnquiry(enquiryId: string): Promise<EnquiryDetail | null> {
  const [row] = await db
    .select({
      id: enquiries.id,
      source: enquiries.source,
      sourceForm: enquiries.sourceForm,
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
        orderedAt: orders.orderedAt,
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
      orderedAt: o.orderedAt.toISOString(),
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

  let assignedName: string | null = null;
  if (assignToId) {
    const [target] = await db.select({ name: users.name }).from(users).where(eq(users.id, assignToId));
    if (!target) return err("That person could not be found.", "not_found");
    assignedName = target.name;
  }

  await db
    .update(enquiries)
    .set({ assignedToId: assignToId, updatedAt: new Date(), updatedById: user.id })
    .where(eq(enquiries.id, enquiryId));

  const kind = !before.assignedToId ? "assigned" : assignToId ? "reassigned" : "unassigned";
  await writeActivity(
    enquiryId,
    kind,
    user.id,
    assignToId ? `Assigned to ${assignedName}.` : "Unassigned.",
    { from: before.assignedToId, to: assignToId },
  );

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

  // A confirmed match only ever sets the pointer — nothing about the customer
  // row itself is read back and written; the enquiry adapts to the customer,
  // never the other way round.
  await db
    .update(enquiries)
    .set({ customerId, updatedAt: new Date(), updatedById: user.id })
    .where(eq(enquiries.id, enquiryId));

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
 * A plain substring match against the stored submission text — there is no
 * phone column to index against, by design (§7 of the design phase), and a
 * customer legitimately raising a second enquiry is the ordinary case, not
 * the error. This is a WARNING, never a block.
 */
export async function findPossibleDuplicateEnquiries(
  enquiryId: string,
  phone: string | null,
): Promise<PossibleDuplicate[]> {
  const digits = phoneDigits(phone);
  if (!digits) return [];

  const rows = await db
    .select({
      id: enquiries.id,
      receivedAt: enquiries.receivedAt,
      source: enquiries.source,
      stage: enquiries.stage,
      assignedToName: users.name,
    })
    .from(enquiries)
    .leftJoin(users, eq(users.id, enquiries.assignedToId))
    .where(
      and(
        eq(enquiries.workspace, "enquiries"),
        sql`${enquiries.id} <> ${enquiryId}`,
        sql`${enquiries.rawSubmission}::text ilike ${"%" + digits + "%"}`,
      ),
    )
    .orderBy(desc(enquiries.receivedAt))
    .limit(5);

  return rows.map((r) => ({
    id: r.id,
    receivedAt: r.receivedAt.toISOString(),
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
  type: ReminderType;
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

  const reminderId = id("rem");
  await db.insert(reminders).values({
    id: reminderId,
    customerId: enquiry.customerId,
    enquiryId: input.enquiryId,
    createdByUserId: user.id,
    assignedUserId: input.assignedUserId,
    dueDate: input.dueDate,
    note: input.note.trim(),
    type: input.type,
    createdById: user.id,
    updatedById: user.id,
  });

  await writeActivity(input.enquiryId, "reminder_created", user.id, input.note.trim(), {
    reminderId,
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
  const [enquiry] = await db.select({ customerId: enquiries.customerId }).from(enquiries).where(eq(enquiries.id, enquiryId));
  if (!enquiry?.customerId) return [];

  const alreadyLinked = db.select({ orderId: enquiryOrders.orderId }).from(enquiryOrders).where(eq(enquiryOrders.enquiryId, enquiryId));

  const rows = await db
    .select({ id: orders.id, orderNo: orders.orderNo, orderedAt: orders.orderedAt, totalAmount: orders.totalAmount, status: orders.status })
    .from(orders)
    .where(and(eq(orders.customerId, enquiry.customerId), notInArray(orders.id, alreadyLinked)))
    .orderBy(desc(orders.orderedAt))
    .limit(20);

  return rows.map((r) => ({ id: r.id, orderNo: r.orderNo, orderedAt: r.orderedAt.toISOString(), totalAmount: r.totalAmount, status: r.status }));
}

export async function linkOrder(enquiryId: string, orderId: string): Promise<Result> {
  const { user, error } = await requireEnquiriesAccess();
  if (error) return error;

  const [enquiry] = await db.select({ id: enquiries.id, customerId: enquiries.customerId }).from(enquiries).where(eq(enquiries.id, enquiryId));
  if (!enquiry) return err("That enquiry no longer exists.", "not_found");

  const [order] = await db.select({ id: orders.id, customerId: orders.customerId, orderNo: orders.orderNo }).from(orders).where(eq(orders.id, orderId));
  if (!order) return err("That order could not be found.", "not_found");
  if (enquiry.customerId && order.customerId !== enquiry.customerId) {
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
