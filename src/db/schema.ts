import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/* ---------------------------------------------------------------------------
 * MahekOne — shared schema.
 *
 * Every app in the suite reads and writes these tables. The Telecaller CRM is
 * the first consumer; dispatch, orders and attendance join later. Nothing here
 * is CRM-private, so nothing has to be duplicated or synced.
 *
 * Universal rules (requirements §3.1):
 *  1. Every record carries created/updated timestamps and actors.
 *  2. Nothing representing a customer interaction is ever hard-deleted.
 *     Corrections are new records plus an audit entry, never overwrites.
 *  3. Customer deactivation is a status change, never a deletion.
 *  4. Money is whole paise. Never decimal, never float, never text arithmetic.
 *  5. Business dates are evaluated in IST — see lib/business-date.ts.
 *  6. Derived values are cached here for speed, never the source of truth.
 *     Every one has a documented recompute path in lib/recompute.ts.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------- enums */

export const roleEnum = pgEnum("role", ["telecaller", "manager", "admin"]);

export const customerStatusEnum = pgEnum("customer_status", [
  "active",
  "inactive",
  "deactivated",
]);

export const callDirectionEnum = pgEnum("call_direction", ["outbound", "inbound"]);

export const connectionEnum = pgEnum("connection_status", [
  "connected",
  "no_answer",
  "busy",
  "switched_off",
  "wrong_number",
]);

export const callOutcomeEnum = pgEnum("call_outcome", [
  "order_placed",
  "will_order_later",
  "no_requirement_now",
  "payment_promised",
  "payment_dispute",
  "complaint_raised",
  "not_reachable",
  "call_back_requested",
  "refused",
]);

/**
 * What kind of interaction this was. An "order received" is NOT a call: it
 * arrived by WhatsApp or the ERP with nobody speaking to anybody, and counting
 * it as one inflates calls attempted, connect rate and every conversion metric.
 */
export const interactionTypeEnum = pgEnum("interaction_type", [
  "outbound_call",
  "inbound_call",
  "order_received",
]);

/**
 * The union of both outcome sets. Which values are legal depends on the
 * interaction type, and that is enforced in the save operation — an inbound
 * record with "not_interested" is rejected at the boundary, not just hidden
 * by the interface.
 */
export const interactionOutcomeEnum = pgEnum("interaction_outcome", [
  /* outbound */
  "order_taken",
  "no_order",
  "no_answer",
  "payment_promised",
  "follow_up",
  "not_interested",
  /* inbound (order_taken, payment_promised and follow_up are shared) */
  "complaint",
  "transport_follow_up",
  "casual_talk",
]);

/** Required attribution: reporting must tell routine calling from collections. */
export const sourceModuleEnum = pgEnum("source_module", [
  "call_queue",
  "payment_follow_up",
  "inactive_watch",
  "customer_record",
  "ad_hoc",
]);

export const orderSourceEnum = pgEnum("order_source", ["crm", "external"]);
export const orderStatusEnum = pgEnum("order_status", [
  "captured",
  "confirmed",
  "dispatched",
  "cancelled",
]);

export const billStatusEnum = pgEnum("bill_status", [
  "unpaid",
  "partially_paid",
  "paid",
]);

/** Three stored values only. "Due" and "overdue" are derived on read. */
export const reminderStatusEnum = pgEnum("reminder_status", [
  "pending",
  "completed",
  "dismissed",
]);

export const reminderTypeEnum = pgEnum("reminder_type", [
  "call_back",
  "payment_promise",
  "order_confirmation",
  "send_information",
  "check_stock",
  "other",
]);

export const complaintStatusEnum = pgEnum("complaint_status", [
  "open",
  "in_progress",
  "awaiting_customer",
  "resolved",
  "closed",
  "rejected",
]);

/**
 * Reconciled to one set covering both the old list and the categories the
 * inbound complaint outcome introduced. Existing records are mapped onto this
 * during migration rather than left pointing at values that no longer exist.
 */
export const complaintCategoryEnum = pgEnum("complaint_category", [
  "product_quality",
  "packaging_damage",
  "dispatch_delay",
  "billing_issue",
  "delivery",
  "pricing",
  "service",
  "shortage",
  "other",
]);

export const severityEnum = pgEnum("severity", ["low", "medium", "high"]);

/**
 * §6.2 — where a credit note request has got to. The CRM owns the REQUEST and
 * nothing beyond it: approving, rejecting and issuing all happen in the
 * external system, and this column only records what came back. Until there is
 * an Accounts app to route to, everything sits at "requested".
 */
export const creditNoteStatusEnum = pgEnum("credit_note_status", [
  "requested",
  "under_review",
  "approved",
  "rejected",
  "issued",
]);

export const messageStatusEnum = pgEnum("message_status", [
  "prepared",
  "copied",
  "sent_manually",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "cancelled",
]);

export const sendModeEnum = pgEnum("send_mode", ["manual", "automatic"]);
/**
 * "both" is a standing instruction on a customer, never a message: a message
 * goes to exactly one place, so a both-ways customer produces two rows. The
 * enum is shared, so read `waMessages.destKind` as personal-or-group only.
 */
export const destKindEnum = pgEnum("dest_kind", ["personal", "group", "both"]);

export const templateCategoryEnum = pgEnum("template_category", [
  "order_confirmation",
  "payment_reminder",
  "routine_check_in",
  "reactivation",
  "other",
]);

export const followUpChannelEnum = pgEnum("follow_up_channel", ["whatsapp", "call"]);

export const watchOutcomeEnum = pgEnum("watch_outcome", [
  "contacted",
  "reminder_set",
  "deactivation_requested",
  "not_actually_inactive",
]);

export const helpTypeEnum = pgEnum("help_type", [
  "sop",
  "call_script",
  "system_guide",
  "policy",
]);

export const settingTypeEnum = pgEnum("setting_type", [
  "integer",
  "decimal",
  "text",
  "boolean",
  "structured",
]);

export const runStatusEnum = pgEnum("run_status", [
  "active",
  "paused",
  "completed",
  "cancelled",
]);

/* ---------------------------------------------------------------- §4 files */

/**
 * What an attachment hangs off. An attachment is created BEFORE its parent
 * exists — the upload starts the moment a file is chosen, and the interaction
 * or complaint it belongs to is only written when the form saves — so both
 * parent columns are nullable and a row with neither is an orphan waiting to
 * be bound or swept.
 */
export const attachmentParentEnum = pgEnum("attachment_parent", [
  "interaction",
  "complaint",
  "follow_up_attempt",
]);

/**
 * Removed is a state, not a deletion. Nothing representing a customer
 * interaction is destroyed here (§3.1 rule 2), and a payment proof especially
 * may be wanted by accounts long after somebody tidied it off a screen.
 */
export const attachmentStatusEnum = pgEnum("attachment_status", [
  "uploading",
  "available",
  "failed",
  "removed",
]);

export const appIdEnum = pgEnum("app_id", [
  "crm",
  "field",
  "orders",
  "people",
  "reports",
  "admin",
]);

/* --------------------------------------------------------- §2 configuration */

/**
 * Every business threshold lives here, never as a constant in code. Values are
 * JSON so one table serves integers, decimals, text, booleans and structures.
 * Defaults and validation live in lib/config/registry.ts.
 */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  valueType: settingTypeEnum("value_type").notNull(),
  category: text("category").notNull(),
  label: text("label").notNull(),
  description: text("description").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedById: text("updated_by_id"),
});

/* ------------------------------------------------------------------ §3.2 user */

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    passwordHash: text("password_hash").notNull(),
    role: roleEnum("role").notNull().default("telecaller"),
    initials: text("initials").notNull(),
    /** The manager a telecaller reports to — drives a manager's team scope. */
    reportsToId: text("reports_to_id"),
    active: boolean("active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    uniqueIndex("users_email_key").on(t.email),
    index("users_reports_to_idx").on(t.reportsToId),
  ],
);

export const appAccess = pgTable(
  "app_access",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    app: appIdEnum("app").notNull(),
    grantedById: text("granted_by_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_access_user_app_key").on(t.userId, t.app),
    index("app_access_user_idx").on(t.userId),
  ],
);

export const attendance = pgTable(
  "attendance",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    signedInAt: timestamp("signed_in_at", { withTimezone: true }).notNull(),
    signedOutAt: timestamp("signed_out_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("attendance_user_day_key").on(t.userId, t.day),
    index("attendance_day_idx").on(t.day),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Reset links. Only the SHA-256 of the token is stored, so a copy of this table
 * cannot be turned into a working link — the same reason `users` keeps a hash
 * rather than a password. A link works once and expires; requesting a new one
 * marks every earlier link for that account used, so only the newest works.
 */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("password_resets_token_key").on(t.tokenHash),
    index("password_resets_user_idx").on(t.userId),
  ],
);

/* -------------------------------------------------------------- §3.3 customer */

/** A record is one or the other, and the difference decides what is shown. */
export const customerKindEnum = pgEnum("customer_kind", ["lead", "customer"]);

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(),

    /* identity and contact */
    externalCode: text("external_code"),
    name: text("name").notNull(),
    contactPerson: text("contact_person").notNull(),
    phone: text("phone").notNull(),
    whatsappPhone: text("whatsapp_phone"),
    whatsappDest: destKindEnum("whatsapp_dest").notNull().default("personal"),
    whatsappGroupName: text("whatsapp_group_name"),
    altPhone: text("alt_phone"),
    address: text("address"),
    city: text("city").notNull(),
    region: text("region"),

    /* ---- what kind of record this is ----
     *
     * A lead has never ordered. It has an owner, a source and a date it was
     * added, and none of the commercial machinery below applies to it: no
     * buying cycle, no outstanding, no monthly target. A customer has ordered
     * and is run by two named account managers instead of a single owner.
     *
     * ownerId stays on both rows. For a lead it IS the owner. For a customer
     * it is history — salesAmId is who the record answers to — and it is kept
     * so a converted lead still records who found them.
     */
    kind: customerKindEnum("kind").notNull().default("customer"),
    leadSource: text("lead_source"),

    /* ownership and status */
    status: customerStatusEnum("status").notNull().default("active"),
    ownerId: text("owner_id").references(() => users.id),
    /** Who the CUSTOMER answers to. Null on leads. Drives scope. */
    salesAmId: text("sales_am_id").references(() => users.id),
    /** Dispatch, billing and paperwork. Null on leads, and may be unassigned. */
    backOfficeAmId: text("back_office_am_id").references(() => users.id),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    deactivatedById: text("deactivated_by_id").references(() => users.id),
    deactivationReason: text("deactivation_reason"),
    /** Raised by a telecaller, decided by a manager. */
    deactivationRequested: boolean("deactivation_requested").notNull().default(false),

    /* commercial terms */
    gstin: text("gstin"),
    creditTermDays: integer("credit_term_days").notNull().default(30),
    /** Shown on the information tab; falls back to the configured default. */
    creditDays: integer("credit_days"),
    route: text("route"),
    customerSince: date("customer_since"),

    /* ---- derived and cached: never hand-edited, always recomputable ---- */
    /** From E1. */
    cycleDays: integer("cycle_days").notNull().default(30),
    cycleIsDefault: boolean("cycle_is_default").notNull().default(true),
    lastOrderDate: date("last_order_date"),
    lastOrderValue: bigint("last_order_value", { mode: "number" }).notNull().default(0),
    lastContactDate: date("last_contact_date"),
    /**
     * The last time somebody actually dialled — distinct from lastContactDate.
     * An unanswered call updates this but NOT contact: a ringing phone is not
     * contact, and letting it reset the check-in timer would quietly drop a
     * customer nobody has spoken to out of the queue.
     */
    lastCallDate: date("last_call_date"),
    /**
     * Set ONLY on confirmed send (manual) or actual send (automatic).
     * Never on copy — see lib/engines/queue.ts.
     */
    lastConfirmedWhatsappDate: date("last_confirmed_whatsapp_date"),
    activeInOrderSystem: boolean("active_in_order_system").notNull().default(false),
    outstanding: bigint("outstanding", { mode: "number" }).notNull().default(0),
    avgOrderValue: bigint("avg_order_value", { mode: "number" }).notNull().default(0),
    slowPayer: boolean("slow_payer").notNull().default(false),

    /* flags */
    doNotContact: boolean("do_not_contact").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    index("customers_owner_idx").on(t.ownerId),
    index("customers_name_idx").on(t.name),
    index("customers_phone_idx").on(t.phone),
    index("customers_status_idx").on(t.status),
    uniqueIndex("customers_external_code_key").on(t.externalCode),
  ],
);

/* ------------------------------------------------------------------ §3.4 call */

export const calls = pgTable(
  "calls",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    direction: callDirectionEnum("direction").notNull().default("outbound"),

    /** Outbound call, inbound call, or an order that arrived with no call. */
    interactionType: interactionTypeEnum("interaction_type")
      .notNull()
      .default("outbound_call"),
    /** Null only for order_received, where the type is the whole classification. */
    outcome: interactionOutcomeEnum("outcome"),

    /** When the record was created. Never user-editable. */
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /**
     * Order-received only, and USER-ENTERED. Somebody logging Friday's
     * WhatsApp order on Monday must be able to say so — storing the log
     * timestamp instead would silently corrupt the buying cycle, and through
     * it the queue and the inactive watch.
     */
    orderDate: date("order_date"),

    durationSeconds: integer("duration_seconds"),
    /**
     * RETIRED for new records — kept so historical rows do not lose the
     * rang/busy/switched-off detail. The EOD missed count now reads the
     * outcome, not this.
     */
    connectionStatus: connectionEnum("connection_status"),
    legacyOutcome: callOutcomeEnum("legacy_outcome"),

    notes: text("notes"),
    /**
     * The quick notes the user actually clicked, as references. The merged
     * text in `notes` is what a human reads; these are what makes "how often
     * is 'Price high' the reason we lose an order" answerable at all.
     */
    quickNoteIds: jsonb("quick_note_ids").$type<string[]>().notNull().default([]),

    sourceModule: sourceModuleEnum("source_module").notNull().default("ad_hoc"),
    /** Where in the day's queue this fell, when it came from the queue. */
    queuePosition: integer("queue_position"),

    /* what the call produced */
    orderId: text("order_id"),
    reminderId: text("reminder_id"),
    complaintId: text("complaint_id"),

    /** Guards against a double-click duplicating a call and the EOD count. */
    idempotencyKey: text("idempotency_key"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    index("calls_customer_idx").on(t.customerId),
    index("calls_user_started_idx").on(t.userId, t.startedAt),
    index("calls_started_idx").on(t.startedAt),
    uniqueIndex("calls_idempotency_key").on(t.idempotencyKey),
  ],
);

/* ----------------------------------------------------------------- §3.5 order */

/* --------------------------------------------------------------- products */

export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Where it is separable from the name — "5L", "200L". */
    packSize: text("pack_size"),
    /** Join key to the external order system. */
    externalCode: text("external_code"),
    /** Discontinued products stay for history but leave the entry list. */
    active: boolean("active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("products_active_idx").on(t.active, t.displayOrder)],
);

/** One row per product with a non-zero quantity. Blanks are not stored. */
export const interactionProductLines = pgTable(
  "interaction_product_lines",
  {
    id: text("id").primaryKey(),
    interactionId: text("interaction_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull(),
  },
  (t) => [index("interaction_lines_idx").on(t.interactionId)],
);

/**
 * Quick notes are CONFIGURATION, not constants. The lists shipped with the
 * brief are labelled "examples" — a draft, not an agreed set. A manager must
 * be able to add "Diwali stock booking" in October without a deploy.
 */
export const quickNotes = pgTable(
  "quick_notes",
  {
    id: text("id").primaryKey(),
    interactionType: interactionTypeEnum("interaction_type").notNull(),
    /** Null for order_received, which has no outcome. */
    outcome: interactionOutcomeEnum("outcome"),
    /** Shown on the chip and appended to the notes when clicked. */
    label: text("label").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    /** Incremented on use, so the list can order itself by what people pick. */
    usageCount: integer("usage_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("quick_notes_lookup_idx").on(t.interactionType, t.outcome, t.displayOrder)],
);

/** Records that could not be mapped cleanly during migration — never guessed. */
export const migrationExceptions = pgTable("migration_exceptions", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  reason: text("reason").notNull(),
  detail: jsonb("detail"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id),
    /** Kept from day one: Inactive Watch produces false positives without it. */
    source: orderSourceEnum("source").notNull().default("crm"),
    externalRef: text("external_ref"),
    orderedAt: timestamp("ordered_at", { withTimezone: true }).notNull(),
    totalAmount: bigint("total_amount", { mode: "number" }).notNull(),
    status: orderStatusEnum("status").notNull().default("captured"),
    callId: text("call_id"),
    lineItems: jsonb("line_items").$type<OrderLine[]>(),
    /**
     * The payment term agreed when the order was taken, in days from the bill
     * date. Null means nobody stated one, and the customer's own term — then
     * the configured default — applies to the bill instead.
     */
    creditDays: integer("credit_days"),
    /**
     * What that term means in dates, measured from the order. Derived, and
     * kept so the telecaller and the customer are looking at the same day
     * before any bill exists. The bill's own due date supersedes it.
     */
    paymentDueDate: date("payment_due_date"),
    expectedDispatch: date("expected_dispatch"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    index("orders_customer_idx").on(t.customerId),
    index("orders_ordered_idx").on(t.orderedAt),
    uniqueIndex("orders_external_ref_key").on(t.externalRef),
  ],
);

export type OrderLine = {
  product: string;
  quantity: number;
  /** Paise. */
  unitPrice: number;
  amount: number;
};

/* --------------------------------------------------------- §3.6 bill, payment */

export const bills = pgTable(
  "bills",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    billNo: text("bill_no").notNull(),
    billDate: date("bill_date").notNull(),
    /** Null means the default credit period applies — see E3. */
    dueDate: date("due_date"),
    amount: bigint("amount", { mode: "number" }).notNull(),
    paidAmount: bigint("paid_amount", { mode: "number" }).notNull().default(0),
    status: billStatusEnum("status").notNull().default("unpaid"),
    disputed: boolean("disputed").notNull().default(false),
    externalRef: text("external_ref"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    uniqueIndex("bills_no_key").on(t.billNo),
    index("bills_customer_idx").on(t.customerId),
    index("bills_due_idx").on(t.dueDate),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    billId: text("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    amount: bigint("amount", { mode: "number" }).notNull(),
    paidAt: date("paid_at").notNull(),
    mode: text("mode").notNull().default("Bank transfer"),
    reference: text("reference"),
    externalRef: text("external_ref"),
    recordedById: text("recorded_by_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    index("payments_customer_idx").on(t.customerId),
    index("payments_paid_idx").on(t.paidAt),
  ],
);

/* -------------------------------------------- §3.7 payment follow-up state */

/** One open record per customer. Recomputed nightly and on any payment. */
export const followUpStates = pgTable(
  "follow_up_states",
  {
    customerId: text("customer_id")
      .primaryKey()
      .references(() => customers.id, { onDelete: "cascade" }),
    stage: integer("stage").notNull(),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull(),
    oldestOverdueBillDate: date("oldest_overdue_bill_date"),
    daysOverdue: integer("days_overdue").notNull().default(0),
    totalOverdue: bigint("total_overdue", { mode: "number" }).notNull().default(0),
    overdueBillCount: integer("overdue_bill_count").notNull().default(0),
    lastChannel: followUpChannelEnum("last_channel"),
    lastFollowUpAt: timestamp("last_follow_up_at", { withTimezone: true }),
    nextChannel: followUpChannelEnum("next_channel").notNull(),
    /** True while a dispute holds the customer at their current stage. */
    held: boolean("held").notNull().default(false),
    heldReason: text("held_reason"),
    /**
     * The stage is derived from how overdue the account is, and rebuilt
     * nightly — but a customer who refuses to commit has told you something
     * their bill dates have not. This is the floor a telecaller can raise by
     * hand: the derived stage still moves, and never drops below this.
     *
     * Cleared when nothing is overdue, because the account has left the
     * worklist and the refusal no longer describes anything.
     */
    manualStageFloor: integer("manual_stage_floor"),
    floorReason: text("floor_reason"),
    floorSetAt: timestamp("floor_set_at", { withTimezone: true }),
    floorSetById: text("floor_set_by_id").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("follow_up_stage_idx").on(t.stage)],
);

export const followUpAttempts = pgTable(
  "follow_up_attempts",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    stage: integer("stage").notNull(),
    channel: followUpChannelEnum("channel").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    outcome: text("outcome"),
    promisedAmount: bigint("promised_amount", { mode: "number" }),
    promisedDate: date("promised_date"),
    reminderId: text("reminder_id"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
  },
  (t) => [
    index("follow_up_attempts_customer_idx").on(t.customerId),
    uniqueIndex("follow_up_attempts_idempotency_key").on(t.idempotencyKey),
  ],
);

/* ------------------------------------------------------------- §3.8 reminder */

export const reminders = pgTable(
  "reminders",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    assignedUserId: text("assigned_user_id")
      .notNull()
      .references(() => users.id),
    callId: text("call_id"),
    dueDate: date("due_date").notNull(),
    /** Mandatory — what was promised, in the telecaller's own words. */
    note: text("note").notNull(),
    type: reminderTypeEnum("type").notNull().default("call_back"),
    status: reminderStatusEnum("status").notNull().default("pending"),
    systemGenerated: boolean("system_generated").notNull().default(false),
    rescheduleCount: integer("reschedule_count").notNull().default(0),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedById: text("closed_by_id").references(() => users.id),
    closureNote: text("closure_note"),
    dismissReason: text("dismiss_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    index("reminders_assigned_due_idx").on(t.assignedUserId, t.dueDate),
    index("reminders_customer_idx").on(t.customerId),
    index("reminders_status_idx").on(t.status),
  ],
);

/* ------------------------------------------------------------ §3.9 complaint */

export const complaints = pgTable(
  "complaints",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    loggedByUserId: text("logged_by_user_id")
      .notNull()
      .references(() => users.id),
    callId: text("call_id"),
    category: complaintCategoryEnum("category").notNull(),
    /** Mandatory — the customer's own words. */
    description: text("description").notNull(),
    severity: severityEnum("severity").notNull().default("medium"),
    assignedTo: text("assigned_to").notNull().default("Operations"),
    status: complaintStatusEnum("status").notNull().default("open"),
    relatedBillId: text("related_bill_id"),
    relatedOrderId: text("related_order_id"),
    resolutionNotes: text("resolution_notes"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedById: text("resolved_by_id").references(() => users.id),
    customerInformed: boolean("customer_informed").notNull().default(false),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }).notNull(),
    slaEscalatedAt: timestamp("sla_escalated_at", { withTimezone: true }),

    /* ---- credit-note request, raised with the complaint ---- */

    requestCn: boolean("request_cn").notNull().default(false),
    /** The bill the credit note relates to. Required when requestCn is true. */
    billId: text("bill_id").references(() => bills.id),
    goodsDescription: text("goods_description"),
    /** Paise, and only ever set when requestCn is true. */
    cnAmount: bigint("cn_amount", { mode: "number" }),
    cnStatus: creditNoteStatusEnum("cn_status"),
    /** The external system's CN number, once it has issued one. */
    cnReference: text("cn_reference"),
    /** Whoever actually reported it — not always the customer's main number. */
    mobileNumber: text("mobile_number"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    index("complaints_customer_idx").on(t.customerId),
    index("complaints_status_idx").on(t.status),
    index("complaints_sla_idx").on(t.slaDueAt),
  ],
);

/** Photos of damaged or short goods, attached when the complaint is raised. */
export const complaintImages = pgTable("complaint_images", {
  id: text("id").primaryKey(),
  complaintId: text("complaint_id")
    .notNull()
    .references(() => complaints.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * §4 — one attachment record for every file in MahekOne, whatever it hangs
 * off. Complaint photos, payment proofs and anything a later app needs share
 * this table rather than growing a column each: the rules about size, type,
 * access and retention are the same wherever a file is attached, and three
 * implementations would be three places for them to drift.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    /** Null until the form saves and binds it. */
    parentType: attachmentParentEnum("parent_type"),
    parentId: text("parent_id"),
    /** As the customer's phone named it, for the person who reads it later. */
    filename: text("filename").notNull(),
    /** Where the bytes live. Never a public URL — see the serving route. */
    storedRef: text("stored_ref").notNull(),
    /** Sniffed from the bytes, never taken from the extension. */
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    thumbnailRef: text("thumbnail_ref"),
    status: attachmentStatusEnum("status").notNull().default("uploading"),
    uploadedById: text("uploaded_by_id")
      .notNull()
      .references(() => users.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("attachments_parent_idx").on(t.parentType, t.parentId),
    // The orphan sweep reads exactly this: unbound rows older than the window.
    index("attachments_orphan_idx").on(t.parentId, t.uploadedAt),
  ],
);

/**
 * Full status-change history: from, to, who, when, note. This supersedes the
 * earlier free-text complaint_events log — every line here is attributable and
 * carries the transition, which a plain note could not.
 */
export const complaintStatusHistory = pgTable(
  "complaint_status_history",
  {
    id: text("id").primaryKey(),
    complaintId: text("complaint_id")
      .notNull()
      .references(() => complaints.id, { onDelete: "cascade" }),
    fromStatus: complaintStatusEnum("from_status"),
    toStatus: complaintStatusEnum("to_status").notNull(),
    changedById: text("changed_by_id").references(() => users.id),
    note: text("note"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("complaint_history_idx").on(t.complaintId)],
);

/* ------------------------------------------------------------- §3.10 whatsapp */

export const waTemplates = pgTable("wa_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: templateCategoryEnum("category").notNull(),
  /** Which escalation stage this payment reminder belongs to, if any. */
  escalationStage: integer("escalation_stage"),
  body: text("body").notNull(),
  appliesTo: destKindEnum("applies_to").notNull().default("personal"),
  active: boolean("active").notNull().default(true),
  usageCount: integer("usage_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: text("created_by_id"),
  updatedById: text("updated_by_id"),
});

export const waRuns = pgTable("wa_runs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  templateId: text("template_id").references(() => waTemplates.id),
  mode: sendModeEnum("mode").notNull().default("manual"),
  /** The filter used to select recipients, kept so a run can be explained. */
  filterKey: text("filter_key").notNull(),
  totalCount: integer("total_count").notNull().default(0),
  sentCount: integer("sent_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  status: runStatusEnum("status").notNull().default("active"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdById: text("created_by_id"),
});

export const waMessages = pgTable(
  "wa_messages",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    templateId: text("template_id").references(() => waTemplates.id),
    templateName: text("template_name"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    mode: sendModeEnum("mode").notNull().default("manual"),
    destKind: destKindEnum("dest_kind").notNull().default("personal"),
    /** The actual number or group name the message went to. */
    resolvedDestination: text("resolved_destination").notNull(),
    /** Exactly as copied or sent, after merge. */
    body: text("body").notNull(),
    edited: boolean("edited").notNull().default(false),
    status: messageStatusEnum("status").notNull().default("prepared"),
    runId: text("run_id").references(() => waRuns.id, { onDelete: "set null" }),

    /* separate timestamps — the state machine is the product here */
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
    copiedAt: timestamp("copied_at", { withTimezone: true }),
    confirmedSentAt: timestamp("confirmed_sent_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    failureReason: text("failure_reason"),

    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    index("wa_messages_customer_idx").on(t.customerId),
    index("wa_messages_status_idx").on(t.status),
    index("wa_messages_run_idx").on(t.runId),
    uniqueIndex("wa_messages_idempotency_key").on(t.idempotencyKey),
  ],
);

export const waReplies = pgTable("wa_replies", {
  id: text("id").primaryKey(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
  actioned: boolean("actioned").notNull().default(false),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------- §3.11 monthly target */

export const monthlyTargets = pgTable(
  "monthly_targets",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    targetAmount: bigint("target_amount", { mode: "number" }).notNull(),
    /** The interface badges auto-applied defaults distinctly. */
    isDefault: boolean("is_default").notNull().default(true),
    setById: text("set_by_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    uniqueIndex("monthly_targets_key").on(t.customerId, t.year, t.month),
    index("monthly_targets_period_idx").on(t.year, t.month),
  ],
);

/* --------------------------------------------------------- §3.12 help article */

export const helpArticles = pgTable("help_articles", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  category: text("category").notNull(),
  type: helpTypeEnum("type").notNull().default("sop"),
  /** Which roles may see it. */
  roles: jsonb("roles").notNull().$type<string[]>(),
  scriptBody: text("script_body"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdById: text("created_by_id"),
  updatedById: text("updated_by_id"),
});

export const bugReports = pgTable("bug_reports", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id),
  description: text("description").notNull(),
  screen: text("screen"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------- §3.13 inactive watch item */

export const inactiveWatchItems = pgTable(
  "inactive_watch_items",
  {
    customerId: text("customer_id")
      .primaryKey()
      .references(() => customers.id, { onDelete: "cascade" }),
    flaggedAt: timestamp("flagged_at", { withTimezone: true }).notNull().defaultNow(),
    cyclesElapsed: text("cycles_elapsed").notNull(),
    daysSinceLastOrder: integer("days_since_last_order").notNull(),
    valueAtRisk: bigint("value_at_risk", { mode: "number" }).notNull().default(0),
    outcome: watchOutcomeEnum("outcome"),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
    outcomeById: text("outcome_by_id").references(() => users.id),
    outcomeReason: text("outcome_reason"),
    dismissedUntil: date("dismissed_until"),
  },
  (t) => [index("watch_flagged_idx").on(t.flaggedAt)],
);

/* ------------------------------------------------------------ §3.14 audit log */

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    beforeState: jsonb("before_state"),
    afterState: jsonb("after_state"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_entity_idx").on(t.entityType, t.entityId),
    index("audit_actor_idx").on(t.actorId),
    index("audit_at_idx").on(t.at),
  ],
);

/* ------------------------------------------------------------------ workspace */

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    kind: text("kind").notNull().default("info"),
    href: text("href"),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.read)],
);

export const eodReports = pgTable(
  "eod_reports",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    body: text("body").notNull(),
    metrics: jsonb("metrics").notNull(),
    /** True when the day boundary generated it because nobody finalised. */
    autoGenerated: boolean("auto_generated").notNull().default(false),
    finalisedAt: timestamp("finalised_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("eod_user_day_key").on(t.userId, t.day)],
);

/** Every scheduled task run: start, end and records affected. */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: text("id").primaryKey(),
    job: text("job").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    recordsAffected: integer("records_affected").notNull().default(0),
    ok: boolean("ok").notNull().default(true),
    detail: text("detail"),
    triggeredById: text("triggered_by_id").references(() => users.id),
  },
  (t) => [index("job_runs_job_idx").on(t.job, t.startedAt)],
);

/**
 * Who was in the calling queue when the day opened.
 *
 * The queue itself is derived on every read and never stored — that is what
 * keeps it honest. But a derived list cannot tell you what was on it
 * YESTERDAY, so "carried over" would be unanswerable without a record of the
 * list as it stood. This table is that record and nothing more: it is never
 * read to build a queue, only to compare one against the day before.
 */
export const queueSnapshots = pgTable(
  "queue_snapshots",
  {
    day: date("day").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.customerId] }),
    index("queue_snapshots_day_idx").on(t.day),
  ],
);

/* --------------------------------------------------------------- relations */

export const usersRelations = relations(users, ({ many, one }) => ({
  customers: many(customers),
  calls: many(calls),
  appAccess: many(appAccess),
  attendance: many(attendance),
  reportsTo: one(users, {
    fields: [users.reportsToId],
    references: [users.id],
    relationName: "reportsTo",
  }),
}));

export const appAccessRelations = relations(appAccess, ({ one }) => ({
  user: one(users, { fields: [appAccess.userId], references: [users.id] }),
}));

export const attendanceRelations = relations(attendance, ({ one }) => ({
  user: one(users, { fields: [attendance.userId], references: [users.id] }),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  owner: one(users, { fields: [customers.ownerId], references: [users.id] }),
  salesAm: one(users, {
    fields: [customers.salesAmId],
    references: [users.id],
    relationName: "salesAm",
  }),
  backOfficeAm: one(users, {
    fields: [customers.backOfficeAmId],
    references: [users.id],
    relationName: "backOfficeAm",
  }),
  bills: many(bills),
  calls: many(calls),
  orders: many(orders),
  reminders: many(reminders),
  complaints: many(complaints),
  messages: many(waMessages),
  followUpState: one(followUpStates, {
    fields: [customers.id],
    references: [followUpStates.customerId],
  }),
  watchItem: one(inactiveWatchItems, {
    fields: [customers.id],
    references: [inactiveWatchItems.customerId],
  }),
}));

export const callsRelations = relations(calls, ({ one }) => ({
  customer: one(customers, { fields: [calls.customerId], references: [customers.id] }),
  user: one(users, { fields: [calls.userId], references: [users.id] }),
}));

export const billsRelations = relations(bills, ({ one, many }) => ({
  customer: one(customers, { fields: [bills.customerId], references: [customers.id] }),
  payments: many(payments),
}));

export const ordersRelations = relations(orders, ({ one }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  user: one(users, { fields: [orders.userId], references: [users.id] }),
}));

export const remindersRelations = relations(reminders, ({ one }) => ({
  customer: one(customers, { fields: [reminders.customerId], references: [customers.id] }),
  assignedUser: one(users, {
    fields: [reminders.assignedUserId],
    references: [users.id],
  }),
}));

export const complaintsRelations = relations(complaints, ({ one, many }) => ({
  customer: one(customers, { fields: [complaints.customerId], references: [customers.id] }),
  loggedBy: one(users, { fields: [complaints.loggedByUserId], references: [users.id] }),
  bill: one(bills, { fields: [complaints.billId], references: [bills.id] }),
  history: many(complaintStatusHistory),
  images: many(complaintImages),
}));

export const complaintImagesRelations = relations(complaintImages, ({ one }) => ({
  complaint: one(complaints, {
    fields: [complaintImages.complaintId],
    references: [complaints.id],
  }),
}));

export const complaintStatusHistoryRelations = relations(
  complaintStatusHistory,
  ({ one }) => ({
    complaint: one(complaints, {
      fields: [complaintStatusHistory.complaintId],
      references: [complaints.id],
    }),
  }),
);

export const waMessagesRelations = relations(waMessages, ({ one }) => ({
  customer: one(customers, { fields: [waMessages.customerId], references: [customers.id] }),
  user: one(users, { fields: [waMessages.userId], references: [users.id] }),
  run: one(waRuns, { fields: [waMessages.runId], references: [waRuns.id] }),
}));

export const waRunsRelations = relations(waRuns, ({ one, many }) => ({
  user: one(users, { fields: [waRuns.userId], references: [users.id] }),
  messages: many(waMessages),
}));

export const followUpStatesRelations = relations(followUpStates, ({ one }) => ({
  customer: one(customers, {
    fields: [followUpStates.customerId],
    references: [customers.id],
  }),
}));

export const inactiveWatchItemsRelations = relations(inactiveWatchItems, ({ one }) => ({
  customer: one(customers, {
    fields: [inactiveWatchItems.customerId],
    references: [customers.id],
  }),
}));

/* ------------------------------------------------------------------- types */

export type User = typeof users.$inferSelect;
export type AppAccess = typeof appAccess.$inferSelect;
export type Attendance = typeof attendance.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Call = typeof calls.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Bill = typeof bills.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type FollowUpState = typeof followUpStates.$inferSelect;
export type FollowUpAttempt = typeof followUpAttempts.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type Complaint = typeof complaints.$inferSelect;
export type Product = typeof products.$inferSelect;
export type InteractionProductLine = typeof interactionProductLines.$inferSelect;
export type QuickNote = typeof quickNotes.$inferSelect;
export type Interaction = typeof calls.$inferSelect;
export type ComplaintImage = typeof complaintImages.$inferSelect;
export type ComplaintStatusHistory = typeof complaintStatusHistory.$inferSelect;
export type MonthlyTarget = typeof monthlyTargets.$inferSelect;
export type WaTemplate = typeof waTemplates.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type WaMessage = typeof waMessages.$inferSelect;
export type WaRun = typeof waRuns.$inferSelect;
export type WaReply = typeof waReplies.$inferSelect;
export type InactiveWatchItem = typeof inactiveWatchItems.$inferSelect;
export type HelpArticle = typeof helpArticles.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type EodReport = typeof eodReports.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
