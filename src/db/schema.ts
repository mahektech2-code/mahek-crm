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
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

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

/**
 * Accounts approve orders and nothing else about them is special. Kept a role
 * rather than a capability on the Orders app, so that being able to OPEN the
 * app and being able to ACCEPT an order stay separable.
 */
export const roleEnum = pgEnum("role", [
  "telecaller",
  "manager",
  "accounts",
  "admin",
]);

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
/**
 * An order taken on a call is not yet an order the business has agreed to:
 * accounts check the customer first. New CRM orders start at
 * `pending_approval` and become `confirmed` when approved, or `declined`.
 *
 * `captured` remains for the orders written before approval existed — they
 * were accepted at the time, and moving them into "pending" would rewrite
 * history that already settled. See lib/order-status.ts for which of these
 * count as a sale.
 */
export const orderStatusEnum = pgEnum("order_status", [
  "captured",
  "pending_approval",
  "declined",
  "confirmed",
  "dispatched",
  "cancelled",
]);

export const billStatusEnum = pgEnum("bill_status", [
  "unpaid",
  "partially_paid",
  "paid",
]);

/**
 * Money the customer says arrived is not money the business has seen. A
 * receipt reported by a telecaller on a collections call sits at `reported`
 * until accounts find it in the bank; only `confirmed` moves the ledger.
 *
 * Rejecting is not deleting. A transfer that never landed is a fact about the
 * account — the telecaller has to ring back and say something — so the row
 * stays and carries the reason.
 */
export const receiptStatusEnum = pgEnum("receipt_status", [
  "reported",
  "confirmed",
  "rejected",
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
  /** Proof of payment: a transfer screenshot, a cheque, a deposit slip. */
  "payment_receipt",
  /**
   * A screenshot of the fault, sent with the report itself. The first two
   * parents behind a file that has no customer at all — which is why
   * `canRead` asks who may see the THREAD rather than falling through to a
   * customer's scope.
   */
  "feedback",
  /** A screenshot attached to one reply in the thread, either direction. */
  "feedback_message",
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
  "accounts",
  "people",
  "reports",
  "hrms",
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
    /**
     * The salesperson the customer master names, as text.
     *
     * Who actually sells to this account is a fact the Sales Party tab holds,
     * and most of those people have no MahekOne login — several are not people
     * at all ("Western Line Sale", "Company Own", "JAIPUR"). `salesAmId` can
     * only hold somebody with a `users` row, so the projection linked the few
     * that matched and dropped the rest on the floor; every screen then fell
     * back to the owner and showed a telecaller's name as the salesperson.
     *
     * This is a mirror of the sheet and a derived cache: it is never typed on
     * a screen, and `recomputeSalesPeople()` rebuilds it. `salesAmId` keeps
     * its job — it is what decides whose book a customer is in, and a name
     * with no account cannot be given a book.
     */
    salesPersonName: text("sales_person_name"),
    /** Dispatch, billing and paperwork. Null on leads, and may be unassigned. */
    backOfficeAmId: text("back_office_am_id").references(() => users.id),
    /**
     * The back office person the party master names, whether or not they hold
     * a MahekOne login — the mirror of `salesPersonName` beside it, and for
     * the same reason. None of the four in the sheet have an account, so
     * storing only the id left every screen saying "Unassigned" against a
     * customer the sheet names somebody for.
     */
    backOfficeName: text("back_office_name"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    deactivatedById: text("deactivated_by_id").references(() => users.id),
    deactivationReason: text("deactivation_reason"),
    /** Raised by a telecaller, decided by a manager. */
    deactivationRequested: boolean("deactivation_requested").notNull().default(false),
    /**
     * The same pair, in the other direction. A deactivated customer who wants
     * to come back is a decision somebody has to take deliberately —
     * `recomputeInactivity` will not do it on the strength of an order — so
     * the ask needs somewhere to live while it waits for a manager.
     */
    reactivationRequested: boolean("reactivation_requested").notNull().default(false),
    reactivationReason: text("reactivation_reason"),

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

/* ---------------------------------------------------------------------------
 * The catalogue is four levels, and only the bottom one can be ordered.
 *
 *   formulation → brand line → finished good → SKU
 *
 * A formulation is the actual liquid, and a customer never hears its name. A
 * brand line is what they ask for — the same liquid sells as Nano, Astar Nano
 * and M5x4 Thinner, which is exactly why search has to reach all three. A
 * finished good is brand plus pack size, and is what most people mean by "a
 * product". A SKU is a finished good in one packing configuration, and it is
 * the ONLY level an order line may point at: "Nano Thinner - 5 Liter
 * (6 Can/Box)" and "… (Loose)" are two SKUs of one finished good, and picking
 * between them is the order, not a detail of it.
 *
 * The three upper levels are grouping. Deleting one would orphan the SKUs
 * underneath, so they deactivate instead, the same way everything else here
 * that history refers to does.
 * ------------------------------------------------------------------------- */

export const productFormulations = pgTable(
  "product_formulations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Lowercased, punctuation stripped — the match key, unique. */
    slug: text("slug").notNull(),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("product_formulations_slug_key").on(t.slug)],
);

export const productBrands = pgTable(
  "product_brands",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    formulationId: text("formulation_id")
      .notNull()
      .references(() => productFormulations.id),
    active: boolean("active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("product_brands_slug_key").on(t.slug),
    index("product_brands_formulation_idx").on(t.formulationId),
  ],
);

export const finishedGoods = pgTable(
  "finished_goods",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    brandId: text("brand_id")
      .notNull()
      .references(() => productBrands.id),
    formulationId: text("formulation_id")
      .notNull()
      .references(() => productFormulations.id),
    /** Millilitres. 0.5 L and 0.8 L are both real sizes, so litres cannot be an integer. */
    millilitres: integer("millilitres").notNull(),
    active: boolean("active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("finished_goods_slug_key").on(t.slug),
    index("finished_goods_brand_idx").on(t.brandId),
  ],
);

/** Per box where there is a box, per can where there is not. Never both. */
export const weightBasisEnum = pgEnum("weight_basis", ["box", "can"]);

/**
 * Where a SKU stands. `ok` is orderable; the other two are not, and both say
 * why on the screen rather than quietly vanishing.
 *
 *  - `needs_canonical_id` — more than one legacy Product ID carries this name,
 *    and order lines reference the NAME. Somebody picks which ID is the real
 *    one; the import will not, because getting it wrong silently rewrites
 *    which product a year of orders was for.
 *  - `held` — the legacy row has a packing configuration but no sellable name,
 *    so there is nothing a telecaller could put on an order.
 */
export const skuStatusEnum = pgEnum("sku_status", ["ok", "needs_canonical_id", "held"]);

export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey(),
    /**
     * Normalised: spacing and casing fixed, "Can/box" standardised. Unique,
     * and the join key to legacy orders and bills, which reference the
     * description text rather than any ID.
     */
    name: text("name").notNull(),
    /** As the source spells it, for reconciling against records that kept the original string. */
    rawName: text("raw_name"),
    /** Where it is separable from the name — "5L", "200L". */
    packSize: text("pack_size"),
    /** Join key to the external order system. */
    externalCode: text("external_code"),

    /* ---- the levels above, null only on rows that predate the catalogue ---- */
    finishedGoodId: text("finished_good_id").references(() => finishedGoods.id),
    brandId: text("brand_id").references(() => productBrands.id),
    formulationId: text("formulation_id").references(() => productFormulations.id),

    /* ---- packing configuration ---- */
    /** "6 Can/Box", "Loose", "Drum" — as printed on the name. */
    packing: text("packing"),
    /** Millilitres in one can. Quantity is entered in cans; litres are derived from this. */
    millilitresPerCan: integer("millilitres_per_can"),
    /** 1 for loose and for drums, which are one container rather than a box of them. */
    cansPerBox: integer("cans_per_box").notNull().default(1),
    /**
     * The empty box or drum, in paise. This is a COST, not a price — a loose
     * SKU has no box and so has none. Nothing may value an order with it.
     */
    packingCostPaise: integer("packing_cost_paise"),
    /** Transport, not pricing. Read `weightBasis` before comparing two of these. */
    weightGrams: integer("weight_grams"),
    weightBasis: weightBasisEnum("weight_basis").notNull().default("box"),
    /**
     * Paise, and null until a price source is agreed. The catalogue document
     * carries no price at all, and an order valued from a packing cost would
     * be wrong in a way nobody would notice for a month.
     */
    sellingPricePaise: bigint("selling_price_paise", { mode: "number" }),

    status: skuStatusEnum("status").notNull().default("ok"),
    /**
     * Legacy Product IDs carrying this name. More than one is what
     * `needs_canonical_id` means; the chosen one lands in `externalCode`.
     * Reference only — the primary key is ours.
     */
    externalIds: jsonb("external_ids").$type<number[]>(),

    /** Discontinued products stay for history but leave the entry list. */
    active: boolean("active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("products_active_idx").on(t.active, t.displayOrder),
    // Partial: unique across the catalogue, which is what the join key needs,
    // without breaking rows that predate it and distinguish themselves by pack
    // size rather than by name.
    uniqueIndex("products_name_key")
      .on(t.name)
      .where(sql`finished_good_id is not null`),
    index("products_finished_good_idx").on(t.finishedGoodId),
    index("products_status_idx").on(t.status),
  ],
);

/**
 * A name that resolves to a SKU without being its name: the losing IDs of a
 * duplicate, and whatever the legacy system spelled differently. Aliases are
 * how an old order line still finds its product after a rename — they are read
 * on the way in and never offered on an order form.
 */
export const productAliases = pgTable(
  "product_aliases",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** The name or the legacy ID this alias answers to. */
    name: text("name").notNull(),
    externalId: integer("external_id"),
    /** Why it exists — a duplicate ID that lost, or a spelling seen in the wild. */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
  },
  (t) => [
    uniqueIndex("product_aliases_name_key").on(t.name),
    index("product_aliases_product_idx").on(t.productId),
  ],
);

/**
 * A legacy row that could not become a SKU, kept where somebody will see it.
 * Two kinds: packing configuration with no sellable name, and packaging
 * material that is not a product at all. Dropping either on the floor at
 * import time is how a catalogue quietly loses rows nobody can account for.
 */
export const catalogueExceptions = pgTable(
  "catalogue_exceptions",
  {
    id: text("id").primaryKey(),
    externalId: integer("external_id").notNull(),
    /** What the source called it, where it called it anything. */
    label: text("label"),
    reason: text("reason").notNull(),
    /** `held` — awaiting a name; `excluded` — deliberately not a product. */
    kind: text("kind").notNull().default("held"),
    /** Set when somebody names it and it becomes a SKU. */
    resolvedProductId: text("resolved_product_id").references(() => products.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedById: text("resolved_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("catalogue_exceptions_external_key").on(t.externalId)],
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
    /**
     * CANS. The can is what a telecaller counts and what the customer says, so
     * it is what gets stored; litres and boxes are derived from the SKU's own
     * packing configuration in lib/catalogue.ts. Storing litres instead would
     * make "six" unrecoverable the moment a pack size changed.
     */
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
    /* ---- approval, §order-approval ---- */
    approvedById: text("approved_by_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Required when declining — a refusal the telecaller cannot read is a row nobody can act on. */
    declineReason: text("decline_reason"),
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
    /**
     * The order this bill was raised against, where it is known. Orders carry
     * no human-facing number of their own, so this is what lets accounts find
     * a bill by the order number the customer quotes — previously the two were
     * joined only by matching `SHEET-n` against `SHEETPAY-n` by hand.
     */
    orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
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
    index("bills_order_idx").on(t.orderId),
  ],
);

/**
 * One receipt is one arrival of money: a transfer, a cheque, a cash payment.
 * Which bills it settles is a separate question with a separate answer, and
 * `payments` below holds that answer as one row per bill. Fusing the two —
 * which is what a payment pinned to a single bill was — makes part payment,
 * a transfer covering three bills, and money received in advance all
 * impossible to record honestly.
 */
export const paymentReceipts = pgTable(
  "payment_receipts",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    amount: bigint("amount", { mode: "number" }).notNull(),
    receivedAt: date("received_at").notNull(),
    mode: text("mode").notNull().default("Bank transfer"),
    /** UTR, cheque number, or whatever names this money in the bank. */
    reference: text("reference"),
    note: text("note"),
    status: receiptStatusEnum("status").notNull().default("reported"),
    /** Where it came from: accounts, a collections call, the bills screen, the sheet. */
    source: text("source").notNull().default("accounts"),
    reportedById: text("reported_by_id").references(() => users.id),
    confirmedById: text("confirmed_by_id").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    rejectReason: text("reject_reason"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    uniqueIndex("payment_receipts_key").on(t.idempotencyKey),
    index("payment_receipts_customer_idx").on(t.customerId),
    index("payment_receipts_status_idx").on(t.status),
    index("payment_receipts_received_idx").on(t.receivedAt),
  ],
);

/**
 * An allocation line: this much of that receipt settles this bill. A null
 * `billId` is money received with no bill to put it against yet — an advance,
 * or the remainder of a round-figure transfer — which sits on account and is
 * offered against the next bill rather than being refused at the door.
 *
 * A line counts against a bill only when its receipt is `confirmed`. That one
 * rule is what keeps `bills.paidAmount` — and therefore outstanding, aging and
 * the collections worklist — a statement about money the business has seen.
 */
export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => paymentReceipts.id, { onDelete: "cascade" }),
    billId: text("bill_id").references(() => bills.id, { onDelete: "cascade" }),
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
    index("payments_receipt_idx").on(t.receiptId),
    index("payments_bill_idx").on(t.billId),
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

/**
 * Superseded by `feedback`, which is where anything the team sends in now
 * lands. Nothing has ever written to this table and no screen reads it; it is
 * left in place rather than dropped so a migration is a decision somebody
 * takes deliberately. Do not start writing to it — two tables meaning "what
 * somebody reported" is one table too many.
 */
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

/* ------------------------------------------------------------------ feedback */

/**
 * What the person is telling us, in their own words. Four kinds and no more:
 * a list long enough to need reading is a list somebody picks the first item
 * from, and the difference between "suggestion" and "feature request" is
 * already finer than most people mid-shift will care about.
 */
export const feedbackKindEnum = pgEnum("feedback_kind", [
  "bug",
  "suggestion",
  "feature",
  "question",
]);

/**
 * Where it got to. `new` until somebody has read it — which is the only
 * status a submitter ever sees change without being told, so it is worth
 * moving off it promptly.
 */
export const feedbackStatusEnum = pgEnum("feedback_status", [
  "new",
  "in_progress",
  "done",
  "declined",
]);

/**
 * One report from somebody using MahekOne.
 *
 * Not a customer interaction, so it does not belong on the timeline; not
 * configuration, so it does not belong in `app_settings`. It is the team
 * talking to whoever builds this, and it is stored rather than sent, because
 * a message in somebody's WhatsApp is a message nobody can triage.
 *
 * Where they were standing is CAPTURED, never typed: "it broke" plus the
 * screen it broke on is a bug report, and "it broke" on its own is not. The
 * same reason `userAgent` is here — a fault that only happens on one browser
 * costs an afternoon to find and one column to explain.
 *
 * Nothing here is ever hard-deleted. A report somebody declined is a decision
 * that was made, and the person who wrote it is entitled to see it stand.
 */
export const feedback = pgTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    /** Who wrote it. Never anonymous — the reply goes back to a person. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    kind: feedbackKindEnum("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** The path they were on, e.g. `/crm/queue`. Captured by the form. */
    path: text("path"),
    /** Which app that path belongs to, derived from it on the way in. */
    app: text("app"),
    userAgent: text("user_agent"),
    status: feedbackStatusEnum("status").notNull().default("new"),
    /**
     * Who last said something on the thread from the triage side, and when.
     * The reply itself is a row in `feedback_messages` — this pair is what the
     * list needs to say "answered by X" without reading every message.
     */
    handledById: text("handled_by_id").references(() => users.id),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    /**
     * When the person who wrote it last opened the thread. Anything said after
     * this is a reply they have not seen, which is what the dot on the Feedback
     * button counts. Null until they open it once.
     */
    submitterReadAt: timestamp("submitter_read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("feedback_status_idx").on(t.status, t.createdAt),
    index("feedback_user_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * One line of the conversation about a report — from either side.
 *
 * This replaces `feedback.admin_note`, which was a single overwritable cell:
 * a second answer erased the first, the person who wrote the report could not
 * say anything back, and "what did we tell them" had no answer beyond the
 * latest edit. A report is a conversation between two people who work here,
 * and a conversation is rows.
 *
 * A status change is a line of it too. Being told "not doing" is the message
 * that matters most, and a thread that showed the reply but not the decision
 * would make somebody read both screens to learn what happened. So `statusTo`
 * carries the transition where there was one — a reply, a status change, or
 * one of each in a single line — and the check constraint refuses a row that
 * says neither, because an empty message is a notification nobody can read.
 *
 * Nothing here is edited or deleted. The submitter sees what was said to them,
 * and it stands.
 */
export const feedbackMessages = pgTable(
  "feedback_messages",
  {
    id: text("id").primaryKey(),
    feedbackId: text("feedback_id")
      .notNull()
      .references(() => feedback.id, { onDelete: "cascade" }),
    /** Whoever wrote this line. Compare with `feedback.userId` for which side. */
    authorId: text("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body"),
    /** Set where this line also moved the report along. */
    statusTo: feedbackStatusEnum("status_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("feedback_messages_idx").on(t.feedbackId, t.createdAt),
    check(
      "feedback_messages_say_something",
      sql`${t.body} is not null or ${t.statusTo} is not null`,
    ),
  ],
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

/* ------------------------------------------------- imported sheet: orders
 *
 * The order history lives in a Google Sheet that somebody else maintains, and
 * it arrives with the defects any long-lived spreadsheet has: product names
 * that are brand families rather than SKUs, a salesman column carrying people
 * and sales channels and one city, columns that are entirely empty, and the
 * occasional row whose Final Amount does not follow from its own Amount.
 *
 * So the landing is deliberately dumb. Every column arrives as the sheet gave
 * it and NOTHING is rejected: a row that cannot be understood is still a row
 * we hold, and the reason it could not be understood is recorded beside it.
 * Interpretation is a separate, re-runnable pass over rows already stored,
 * which is what makes fixing the sheet tomorrow a re-parse rather than a
 * re-fetch — and what stops a bad row from costing us the other 19,999.
 * ------------------------------------------------------------------------- */

export const sheetSyncStatusEnum = pgEnum("sheet_sync_status", [
  "running",
  "ok",
  "failed",
]);

/**
 * How much of the sheet a sync looked at.
 *
 * Google offers no "changed since" for a spreadsheet, so there is no such
 * thing as a cheap correct read — only a cheap read and a correct one, and the
 * schedule runs both:
 *
 *  - `append` reads only past the highest row seen before. At 30,000 rows of
 *    order history that is a few hundred cells instead of two million, so it
 *    can run every few minutes. It cannot see an edit to an existing row.
 *  - `reconcile` reads the whole tab and compares hashes. It catches edits,
 *    corrections and deletions, and runs nightly.
 *  - `reparse` touches Google not at all: it re-reads the stored `raw` and
 *    parses it again. That is the one to run after fixing a parsing rule, and
 *    it is why the raw column exists.
 */
export const sheetSyncModeEnum = pgEnum("sheet_sync_mode", [
  "append",
  "reconcile",
  "reparse",
]);

/**
 * Whether the row is still in the sheet.
 *
 * A row that disappears is marked, never deleted. Somebody sorting a
 * spreadsheet badly, or a filter left on during an export, should not silently
 * erase order history we have already shown people.
 */
export const sheetRowStatusEnum = pgEnum("sheet_row_status", [
  "present",
  "withdrawn",
]);

/**
 * One row per sync. Kept as history rather than overwritten: when a figure on
 * a screen looks wrong, the first question is which pull it came from.
 */
export const sheetSyncRuns = pgTable(
  "sheet_sync_runs",
  {
    id: text("id").primaryKey(),
    /** Which sheet+tab. One row per source, so a second import gets its own. */
    source: text("source").notNull(),
    spreadsheetId: text("spreadsheet_id").notNull(),
    tabTitle: text("tab_title").notNull(),
    mode: sheetSyncModeEnum("mode").notNull().default("reconcile"),
    status: sheetSyncStatusEnum("status").notNull().default("running"),
    rowsRead: integer("rows_read").notNull().default(0),
    rowsCreated: integer("rows_created").notNull().default(0),
    rowsUpdated: integer("rows_updated").notNull().default(0),
    /**
     * Rows whose hash was unchanged, so nothing was written for them. At 30k
     * rows this is nearly all of them, and it is the number that shows the
     * sync is doing work proportional to what changed rather than to size.
     */
    rowsUnchanged: integer("rows_unchanged").notNull().default(0),
    rowsWithdrawn: integer("rows_withdrawn").notNull().default(0),
    rowsWithIssues: integer("rows_with_issues").notNull().default(0),
    /**
     * The highest sheet row this source has ever seen, carried forward so the
     * next `append` run knows where to start reading.
     */
    highestRow: integer("highest_row").notNull().default(1),
    /**
     * Where a chunked run got to. A sync that dies at row 24,000 of 30,000
     * resumes from here instead of starting the whole read again.
     */
    cursorRow: integer("cursor_row"),
    /** Populated on failure. A sync that died halfway says so on the screen. */
    error: text("error"),
    /**
     * Whether this batch is allowed to feed the CRM's derived state — buying
     * cycles, outstanding, lastOrderDate, targets.
     *
     * It starts FALSE and that is the point. Those values are caches the whole
     * application trusts, and data imported from a sheet nobody has corrected
     * yet must be visible without being believed. Turning it on is a decision
     * somebody makes about a specific batch, after looking at the exceptions.
     */
    feedsCrm: boolean("feeds_crm").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    triggeredById: text("triggered_by_id").references(() => users.id),
  },
  (t) => [index("sheet_sync_runs_source_idx").on(t.source, t.startedAt)],
);

export const sheetMatchStatusEnum = pgEnum("sheet_match_status", [
  /** Not looked at yet. */
  "pending",
  /** Exactly one candidate. */
  "matched",
  /** More than one candidate — held for a person, never auto-picked. */
  "ambiguous",
  /** No candidate at all. */
  "unmatched",
]);

/**
 * The raw landing table for the Order Details tab. One row per SHEET row,
 * which is one order LINE — the sheet repeats the order-level columns across
 * every line of an order, so 99 rows are 47 orders.
 *
 * `raw` holds all 55 columns whatever they are called; the typed columns below
 * are a best-effort reading of them and every one is nullable. A null here
 * means "could not be read", never "zero" — and `issues` says why.
 */
export const sheetOrderRows = pgTable(
  "sheet_order_rows",
  {
    id: text("id").primaryKey(),
    syncId: text("sync_id")
      .notNull()
      .references(() => sheetSyncRuns.id, { onDelete: "cascade" }),
    /** 1-based row in the sheet, header included — what you scroll to. */
    rowNumber: integer("row_number").notNull(),

    /**
     * The sheet's own per-line identifier (its "Order ID", e.g. ODID-89BBFA6B).
     * Unique, and the key the import is idempotent on: re-running after the
     * sheet is corrected updates the row in place instead of duplicating it.
     */
    lineKey: text("line_key").notNull(),
    /** The sheet's "Order Number" — shared by every line of one order. */
    orderNumber: text("order_number"),

    /**
     * Every column, exactly as the sheet gave it, keyed by header text.
     *
     * Never selected by a list query. It is the biggest thing on the row and a
     * table of 30,000 of them would drag hundreds of megabytes through the
     * pool to render a screen — the same reason attachment bytes live in their
     * own table rather than as a column on `attachments`.
     */
    raw: jsonb("raw").$type<Record<string, string>>().notNull(),

    /**
     * SHA-256 of the raw row. The whole of incremental sync rests on this: a
     * reconcile read hashes each row and writes only the ones that differ, so
     * a nightly pass over 30,000 unchanged rows performs 30,000 comparisons
     * and zero writes.
     */
    rowHash: text("row_hash").notNull(),

    /** Whether the row is still in the sheet. Disappearance is a status. */
    status: sheetRowStatusEnum("status").notNull().default("present"),
    /** Which sync last saw this row present — what marks the rest withdrawn. */
    lastSeenSyncId: text("last_seen_sync_id"),

    /* ---- order-level, best effort. Consistent across an order's lines. ---- */
    orderDate: date("order_date"),
    dispatchDate: date("dispatch_date"),
    billingPartyName: text("billing_party_name"),
    area: text("area"),
    transportName: text("transport_name"),
    paymentType: text("payment_type"),
    paymentStatus: text("payment_status"),
    paymentReceivedDate: date("payment_received_date"),
    segmentCounterType: text("segment_counter_type"),
    /** Free text. Holds people, sales channels and at least one city. */
    salesMan: text("sales_man"),
    creditDays: integer("credit_days"),
    orderFulfillDays: integer("order_fulfill_days"),
    /** Basis points: 18% is 1800. Percentages are never floats here. */
    gstBp: integer("gst_bp"),

    /* ---------------------------- line-level ---------------------------- */
    description: text("description"),
    /** The sheet's "Type" — Can or Drums. */
    packType: text("pack_type"),
    cans: integer("cans"),
    /** Millilitres, so litres survive as integers: 12.50 L is 12500. */
    volumeMl: bigint("volume_ml", { mode: "number" }),
    /** Paise, and per CAN — the sheet's Rate is not per litre. */
    ratePaise: bigint("rate_paise", { mode: "number" }),
    amountPaise: bigint("amount_paise", { mode: "number" }),
    finalAmountPaise: bigint("final_amount_paise", { mode: "number" }),
    /** Basis points. The sheet's Discount is a PERCENTAGE, not an amount. */
    discountBp: integer("discount_bp"),
    /** Line-level: one order's lines can carry different bill numbers. */
    tallyBillNo: text("tally_bill_no"),

    /* ------------------------------ matching ------------------------------
     * Resolved ids stay null until something resolves unambiguously. Nothing
     * here guesses: "MELODY" names five brand lines in the catalogue and
     * picking one would silently attribute an order to the wrong product.
     */
    matchedCustomerId: text("matched_customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    customerMatchStatus: sheetMatchStatusEnum("customer_match_status")
      .notNull()
      .default("pending"),
    matchedProductId: text("matched_product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    productMatchStatus: sheetMatchStatusEnum("product_match_status")
      .notNull()
      .default("pending"),
    /** Why a match was refused: the candidates it could not choose between. */
    matchNote: text("match_note"),

    /**
     * Everything that could not be read, one entry per column. A row with
     * issues still imports — this is a note for whoever fixes the sheet, not
     * a rejection.
     */
    issues: jsonb("issues").$type<SheetRowIssue[]>().notNull().default([]),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sheet_order_rows_line_key").on(t.lineKey),
    index("sheet_order_rows_sync_idx").on(t.syncId),
    index("sheet_order_rows_order_idx").on(t.orderNumber),
    index("sheet_order_rows_party_idx").on(t.billingPartyName),
    index("sheet_order_rows_customer_idx").on(t.matchedCustomerId),
    /**
     * The admin table's default order, and its keyset pagination key. Date
     * alone is not unique — three hundred orders share one day — so the id
     * rides along to make the cursor stable.
     */
    index("sheet_order_rows_date_idx").on(t.orderDate, t.id),
    index("sheet_order_rows_row_number_idx").on(t.rowNumber),
    /** Drives the exceptions screen without scanning the whole table. */
    index("sheet_order_rows_product_match_idx").on(t.productMatchStatus),
  ],
);

export type SheetRowIssue = {
  /** The sheet column header the problem is in. */
  column: string;
  /** What the cell actually held, so the screen can show it without a re-read. */
  value: string;
  problem: string;
  /**
   * How much of somebody's attention this deserves. Optional, because the
   * order sheet's issues predate it and are all `unreadable` in effect.
   *
   * The distinction earns its place on the employee sheet, where two thirds of
   * the rows carry a date that could be read two ways. A note saying "we took
   * 5/1/2021 as the 5th of January" is worth surfacing, and it is not the same
   * kind of thing as a leaving date before a joining date. Counting them
   * together would put 66 of 71 people under "needs attention", which is the
   * same as putting nobody there.
   */
  kind?: "unreadable" | "ambiguous" | "contradiction";
};

/* ------------------------------------------------------------------- §HRMS
 * The employee master.
 *
 * Imported from the Employee Details tab of the same workbook the order sheet
 * comes from, and read-only here for the same reason: the spreadsheet is where
 * HR maintains it, so a screen that let you edit a value would create two
 * answers to one question and the spreadsheet would win at the next sync.
 * ------------------------------------------------------------------------ */

export const employmentStatusEnum = pgEnum("employment_status", [
  "active",
  "inactive",
  /** The cell held something that is neither. Never guessed into one. */
  "unknown",
]);

export const employees = pgTable(
  "employees",
  {
    id: text("id").primaryKey(),
    /** Which import last wrote this row. */
    syncId: text("sync_id").references(() => sheetSyncRuns.id, { onDelete: "set null" }),
    /** 1-based row in the sheet — what somebody scrolls to when a cell is wrong. */
    rowNumber: integer("row_number").notNull(),

    /**
     * The sheet's own `employee_id`, e.g. EMP-1692. Unique, and the key the
     * import is idempotent on: a re-run updates the person in place, and a
     * row that moves up the sheet when somebody deletes a line above it is
     * still the same employee rather than a new one.
     */
    employeeCode: text("employee_code").notNull(),

    name: text("name").notNull(),
    gender: text("gender"),
    officeName: text("office_name"),
    /** The sheet's `report_to`. A position, not a person — it is not a link. */
    reportsTo: text("reports_to"),
    /** The sheet's `department` column, whose header reads "Position Type". */
    department: text("department"),
    position: text("position"),
    areaAllocated: text("area_allocated"),

    status: employmentStatusEnum("status").notNull().default("unknown"),
    /** What the cell literally said. "ACTIVE" and "Active" are one status and
     *  two spellings, and the second is worth keeping for whoever tidies it. */
    statusRaw: text("status_raw"),

    dateOfJoining: date("date_of_joining"),
    dateOfBirth: date("date_of_birth"),
    dateOfLeaving: date("date_of_leaving"),
    marriageAnniversary: date("marriage_anniversary"),
    child1Birthday: date("child1_birthday"),
    child2Birthday: date("child2_birthday"),

    email: text("email"),
    personalMobile: text("personal_mobile"),
    alternateMobile: text("alternate_mobile"),
    companyMobile: text("company_mobile"),
    emergencyContact: text("emergency_contact"),
    address: text("address"),
    permanentAddress: text("permanent_address"),

    /** Paise, like every other amount in MahekOne. The sheet holds rupees. */
    netSalaryPaise: bigint("net_salary_paise", { mode: "number" }),
    conveyancePaise: bigint("conveyance_paise", { mode: "number" }),
    otherSalaryPaise: bigint("other_salary_paise", { mode: "number" }),

    monthlyPaidLeave: integer("monthly_paid_leave"),
    yearlyMaximumLeave: integer("yearly_maximum_leave"),

    pfEsicApplicable: boolean("pf_esic_applicable"),
    uanNo: text("uan_no"),
    esicNo: text("esic_no"),

    /* --------------------------------------------------------------------
     * Identity and banking.
     *
     * The bank account and the Aadhaar number are the two things on this sheet
     * that are worth stealing, so the row carries only what a person needs to
     * RECOGNISE the account — the bank, the IFSC, the last four digits. The
     * full numbers stay in `raw`, which no screen and no list query reads.
     * Putting the whole account number in a column is how it ends up in a
     * CSV export somebody mails themselves.
     * ------------------------------------------------------------------ */
    bankName: text("bank_name"),
    ifscCode: text("ifsc_code"),
    accountNumberLast4: text("account_number_last4"),
    aadhaarLast4: text("aadhaar_last4"),
    panNumber: text("pan_number"),

    /** The sheet's own path into its images folder. Not a URL we can serve. */
    photoPath: text("photo_path"),

    /**
     * Every column exactly as the sheet gave it, keyed by header — minus the
     * `passwoard` column, which is redacted on the way in. That column holds
     * plaintext credentials to a different system; MahekOne has no use for it
     * and storing it would make this table a password dump.
     */
    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    /** SHA-256 of the row as the sheet gave it. Unchanged rows cost no writes. */
    rowHash: text("row_hash").notNull(),

    /** Whether the person is still a row in the sheet. Disappearance is a
     *  status, not a delete — an employee removed from the sheet is somebody
     *  whose record still has to be findable. */
    sheetStatus: sheetRowStatusEnum("sheet_status").notNull().default("present"),
    lastSeenSyncId: text("last_seen_sync_id"),

    /** Cells that could not be read, or dates that could be read two ways.
     *  A row with issues still imports — this is a note for whoever maintains
     *  the sheet, never a rejection. */
    issues: jsonb("issues").$type<SheetRowIssue[]>().notNull().default([]),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("employees_code_key").on(t.employeeCode),
    index("employees_name_idx").on(t.name),
    index("employees_status_idx").on(t.status),
    index("employees_department_idx").on(t.department),
    index("employees_office_idx").on(t.officeName),
    index("employees_row_number_idx").on(t.rowNumber),
  ],
);

/**
 * The Payment Status tab: one row per ORDER, not per line and not per bill.
 *
 * It is a separate table rather than columns on `sheet_order_rows` because the
 * grain differs — 23,619 order lines against 10,510 payment rows — and because
 * the two tabs are maintained by different people and arrive at different
 * times. Folding them together would make a payment update rewrite order rows
 * that did not change.
 *
 * The key is Order Number. The Tally bill number cannot be one: 113 of them
 * repeat across 539 rows, some hold placeholders like "1" against a zero
 * amount, and `bills.bill_no` is unique.
 */
export const sheetPaymentRows = pgTable(
  "sheet_payment_rows",
  {
    id: text("id").primaryKey(),
    syncId: text("sync_id")
      .notNull()
      .references(() => sheetSyncRuns.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    /** The idempotency key. Unique across the tab, and 1:1 with an order. */
    orderNumber: text("order_number").notNull(),

    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    rowHash: text("row_hash").notNull(),
    status: sheetRowStatusEnum("status").notNull().default("present"),
    lastSeenSyncId: text("last_seen_sync_id"),

    billingPartyName: text("billing_party_name"),
    tallyBillNo: text("tally_bill_no"),
    dispatchDate: date("dispatch_date"),
    /** Paise. The sheet writes whole rupees here. */
    billAmountPaise: bigint("bill_amount_paise", { mode: "number" }),
    /**
     * Filled on 13% of rows. Null is not a gap to fill in: a bill with no due
     * date of its own resolves one from the order's term, then the customer's,
     * then the configured default — which is the existing rule, and better
     * than inventing a date here.
     */
    dueDate: date("due_date"),
    /** "Received", "Pending", or absent — and absent is its own answer. */
    paymentStatus: text("payment_status"),
    paymentReceivedDate: date("payment_received_date"),
    messageDate: date("message_date"),
    nextMessageDate: date("next_message_date"),
    backOffice: text("back_office"),

    issues: jsonb("issues").$type<SheetRowIssue[]>().notNull().default([]),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sheet_payment_rows_order_key").on(t.orderNumber),
    index("sheet_payment_rows_sync_idx").on(t.syncId),
    index("sheet_payment_rows_party_idx").on(t.billingPartyName),
    index("sheet_payment_rows_status_idx").on(t.paymentStatus),
  ],
);

/* -------------------------------------------------- imported sheet: parties
 *
 * The customer master, from the Sales Party tab of the Master workbook. One
 * row per party, keyed on the name — which is the same name the order sheet
 * calls Billing Party Name, and matches 555 of the 557 customers the orders
 * created.
 *
 * This is where the CRM finally gets a phone number. Everything imported from
 * the order sheet arrived unreachable: an order records what somebody bought,
 * never how to ring them.
 *
 * 1,191 parties against 557 who have ordered, so roughly half of this list has
 * never bought anything. Those are prospects, and the schema already has a
 * word for them — but landing a row and deciding it is a lead worth calling
 * are two different acts, so this table holds all of them and the projection
 * chooses.
 * ------------------------------------------------------------------------- */

export const sheetPartyRows = pgTable(
  "sheet_party_rows",
  {
    id: text("id").primaryKey(),
    syncId: text("sync_id")
      .notNull()
      .references(() => sheetSyncRuns.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),

    /** The key, and the join to customers.name. Unique across the tab. */
    partyName: text("party_name").notNull(),
    /** Folded for whitespace and case — what the join actually compares. */
    partyKey: text("party_key").notNull(),

    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    rowHash: text("row_hash").notNull(),
    status: sheetRowStatusEnum("status").notNull().default("present"),
    lastSeenSyncId: text("last_seen_sync_id"),

    /* ---- where they are ---- */
    area: text("area"),
    location: text("location"),
    state: text("state"),

    /* ---- how to reach them. The reason this tab matters. ---- */
    /** Ten digits, normalised. Null when the sheet's value is not a mobile. */
    mobileNo: text("mobile_no"),
    whatsappNo: text("whatsapp_no"),
    email: text("email"),

    /* ---- who works them ----
     *
     * Names, not ids. These are people in the Employee Details tab rather than
     * MahekOne accounts, and most have never signed in — so the name is stored
     * as written and the projection links to a user only where one genuinely
     * matches. An unlinked name is still worth having: it says who owns the
     * account even when the system has no login for them.
     */
    salesPersonName: text("sales_person_name"),
    backOfficeName: text("back_office_name"),

    /* ---- commercial ---- */
    creditDays: integer("credit_days"),
    gstNumber: text("gst_number"),
    grade: text("grade"),
    /** Paise. The sheet writes whole rupees. */
    monthlyTargetPaise: bigint("monthly_target_paise", { mode: "number" }),
    tagPricelist: text("tag_pricelist"),
    segment: text("segment"),
    counterType: text("counter_type"),
    standingInstructions: text("standing_instructions"),
    callingInstructions: text("calling_instructions"),

    /* ---- dispatch defaults ---- */
    transportDetail: text("transport_detail"),
    paymentType: text("payment_type"),
    deliveryType: text("delivery_type"),
    weightType: text("weight_type"),

    /** "Active" / "Deactive" as the sheet spells it. */
    partyStatus: text("party_status"),
    companyName: text("company_name"),
    allocateEmail: text("allocate_email"),
    sinceDate: date("since_date"),

    issues: jsonb("issues").$type<SheetRowIssue[]>().notNull().default([]),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sheet_party_rows_key").on(t.partyKey),
    index("sheet_party_rows_sync_idx").on(t.syncId),
    index("sheet_party_rows_name_idx").on(t.partyName),
    index("sheet_party_rows_status_idx").on(t.partyStatus),
  ],
);

/* ---------------------------------------------- imported sheet: taken orders
 *
 * The Taken Order tab, which is where an order lands FIRST — typed as the
 * customer gives it, before it is dispatched, billed, or written to the Order
 * Details tab this database already imports.
 *
 * One row per SHEET row, which is one order LINE: the tab repeats the
 * order-level columns down every line, so 106 rows are 47 orders.
 *
 * It is imported for one reason, and the reason is a column: while any line of
 * an order is still open, the customer has already ordered and the Call Log
 * must stop chasing them for another. `open` is that judgement, made once in
 * `lib/taken-order-parse.ts`, and `recomputeOrderSystemHolds()` is what turns
 * it into `customers.activeInOrderSystem`. Nothing reads the two status
 * columns directly.
 * ------------------------------------------------------------------------- */

export const sheetTakenOrderRows = pgTable(
  "sheet_taken_order_rows",
  {
    id: text("id").primaryKey(),
    syncId: text("sync_id")
      .notNull()
      .references(() => sheetSyncRuns.id, { onDelete: "cascade" }),
    /** 1-based row in the sheet, header included — what you scroll to. */
    rowNumber: integer("row_number").notNull(),

    /**
     * The tab's own per-line identifier, e.g. ODID-09108D. Unique, and the key
     * the import is idempotent on: a re-read after a correction updates the
     * row in place rather than landing a second copy of it.
     */
    lineKey: text("line_key").notNull(),
    /** The tab's "Order number" — shared by every line of one order. */
    orderNumber: text("order_number"),

    /** Every column as the sheet gave it. Never selected by a list query. */
    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    rowHash: text("row_hash").notNull(),

    /** Whether the row is still in the sheet. Disappearance is a status. */
    status: sheetRowStatusEnum("status").notNull().default("present"),
    lastSeenSyncId: text("last_seen_sync_id"),

    /* ---- order-level. Repeated across an order's lines. ---- */
    orderDate: date("order_date"),
    location: text("location"),
    billingPartyName: text("billing_party_name"),
    deliveryPartyName: text("delivery_party_name"),
    /** Free text, and a concatenation: "Discount 4% - Door Delivery - To Pay". */
    standingInstructions: text("standing_instructions"),
    area: text("area"),
    transporterName: text("transporter_name"),
    /** Who typed the row. A name from the sheet, not a MahekOne account. */
    userName: text("user_name"),
    /** When it was typed, read as a wall clock in Asia/Kolkata. */
    takenAt: timestamp("taken_at", { withTimezone: true }),
    transportationCostPaise: bigint("transportation_cost_paise", { mode: "number" }),
    remark: text("remark"),
    /** The sheet's own "Party Status" — "Pending" on a handful of rows. */
    partyStatus: text("party_status"),

    /* ---------------------------- line-level ---------------------------- */
    description: text("description"),
    cans: integer("cans"),
    boxes: integer("boxes"),
    /** Paise, and per CAN — this tab's Rate is not a line total. */
    ratePaise: bigint("rate_paise", { mode: "number" }),
    /** Basis points. The sheet's Discount is a PERCENTAGE: "4.00%" is 400. */
    discountBp: integer("discount_bp"),
    tallyBillNo: text("tally_bill_no"),
    /** Grams, so a half-kilo survives. The sheet writes kilograms. */
    weightGrams: bigint("weight_grams", { mode: "number" }),

    /* ------------------------------ the rule ------------------------------
     * The two cells the whole import exists for, kept exactly as the sheet
     * spells them — "Ready", "Hold From Office", "Done", "Not Done" — because
     * a status is worth showing to a person in their own words, and because
     * the vocabulary is not fully known and an unrecognised value must survive
     * the round trip rather than being folded into something we do recognise.
     */
    officeStatus: text("office_status"),
    entryStatus: text("entry_status"),
    /**
     * Derived from those two, and the only one anything downstream reads.
     * TRUE means the order is still owed to the customer, so they are held
     * back from order-chasing calls. Indexed with the party name because
     * "which customers have an open line" is the one question asked of this
     * table on every sync.
     */
    open: boolean("open").notNull().default(true),

    /* ------------------------------ matching ------------------------------ */
    matchedCustomerId: text("matched_customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    customerMatchStatus: sheetMatchStatusEnum("customer_match_status")
      .notNull()
      .default("pending"),

    issues: jsonb("issues").$type<SheetRowIssue[]>().notNull().default([]),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sheet_taken_order_rows_line_key").on(t.lineKey),
    index("sheet_taken_order_rows_sync_idx").on(t.syncId),
    index("sheet_taken_order_rows_order_idx").on(t.orderNumber),
    /** The hold query: open rows, by party. */
    index("sheet_taken_order_rows_open_idx").on(t.open, t.billingPartyName),
    index("sheet_taken_order_rows_customer_idx").on(t.matchedCustomerId),
    index("sheet_taken_order_rows_date_idx").on(t.orderDate, t.id),
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
  order: one(orders, { fields: [bills.orderId], references: [orders.id] }),
  payments: many(payments),
}));

export const paymentReceiptsRelations = relations(paymentReceipts, ({ one, many }) => ({
  customer: one(customers, {
    fields: [paymentReceipts.customerId],
    references: [customers.id],
  }),
  lines: many(payments),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  receipt: one(paymentReceipts, {
    fields: [payments.receiptId],
    references: [paymentReceipts.id],
  }),
  bill: one(bills, { fields: [payments.billId], references: [bills.id] }),
  customer: one(customers, { fields: [payments.customerId], references: [customers.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  user: one(users, { fields: [orders.userId], references: [users.id] }),
  bills: many(bills),
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

export const feedbackRelations = relations(feedback, ({ one, many }) => ({
  user: one(users, { fields: [feedback.userId], references: [users.id] }),
  handledBy: one(users, { fields: [feedback.handledById], references: [users.id] }),
  messages: many(feedbackMessages),
}));

export const feedbackMessagesRelations = relations(feedbackMessages, ({ one }) => ({
  feedback: one(feedback, {
    fields: [feedbackMessages.feedbackId],
    references: [feedback.id],
  }),
  author: one(users, { fields: [feedbackMessages.authorId], references: [users.id] }),
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
export type ProductFormulation = typeof productFormulations.$inferSelect;
export type ProductBrand = typeof productBrands.$inferSelect;
export type FinishedGood = typeof finishedGoods.$inferSelect;
export type ProductAlias = typeof productAliases.$inferSelect;
export type CatalogueException = typeof catalogueExceptions.$inferSelect;
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
export type Feedback = typeof feedback.$inferSelect;
export type FeedbackMessage = typeof feedbackMessages.$inferSelect;
export type EodReport = typeof eodReports.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type SheetSyncRun = typeof sheetSyncRuns.$inferSelect;
export type SheetOrderRow = typeof sheetOrderRows.$inferSelect;
export type Employee = typeof employees.$inferSelect;
export type SheetPaymentRow = typeof sheetPaymentRows.$inferSelect;
export type SheetPartyRow = typeof sheetPartyRows.$inferSelect;
export type SheetTakenOrderRow = typeof sheetTakenOrderRows.$inferSelect;
