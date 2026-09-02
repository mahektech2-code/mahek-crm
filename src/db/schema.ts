import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  doublePrecision,
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

/**
 * What kind of thing the next step is, kept apart from WHEN it is.
 *
 * `booked` is a date the customer is expecting and we owe them; `scheduled` is
 * a date the rules produce and may move; `decide` means nothing will bring
 * them back on its own; `none` means nothing is coming at all. Rendering a
 * prediction and a promise identically is how an estimate gets read down a
 * phone as a commitment.
 */
export const nextStepKindEnum = pgEnum("next_step_kind", [
  "booked",
  "scheduled",
  "decide",
  "none",
]);

/** Required attribution: reporting must tell routine calling from collections. */
export const sourceModuleEnum = pgEnum("source_module", [
  "call_queue",
  "payment_follow_up",
  "inactive_watch",
  "customer_record",
  "ad_hoc",
]);

/**
 * Where the order came from. `external` means the external ORDER SYSTEM the
 * office types into — it is not a catch-all for "not the CRM", which is why
 * field orders taken on a handset get their own value rather than borrowing
 * one that already means something else. A source that lies is a source no
 * report can be built on.
 */
export const orderSourceEnum = pgEnum("order_source", ["crm", "external", "mbos"]);
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
 * Whether anybody has actually SAID what this bill's payment position is.
 *
 * `bill_status` answers paid/part/unpaid and is derived from `paid_amount`, so
 * it has no way to express "nobody has told us" — a bill nobody has spoken for
 * comes out `unpaid`, which is a claim of debt. That is the whole problem: the
 * Order Details tab records what was BILLED and never what was RECEIVED, so a
 * bill projected from it carries no payment evidence in either direction.
 *
 * The old answer was to assume settled and write a confirmed receipt for the
 * full amount, because assuming owed invents the entire order book as debt and
 * puts every customer on the collections list. Both assumptions are wrong, and
 * assuming settled is the one that hides money: it marked all the customers and
 * all the bills paid on the sheet's authority, with no person behind it.
 *
 * So there is a third position and it is stated rather than guessed.
 * `unstated` counts as NEITHER paid nor owed — the bill exists, it shows on the
 * customer record, and it is held out of outstanding, aging, the collections
 * worklist and the slow-payer flag until the app or the Tally receivables
 * report says something. Nothing chases a debt nobody has vouched for, and
 * nothing is written off either.
 *
 * DEFAULT `stated`, deliberately: every row that existed when this column
 * arrived keeps exactly the behaviour it had, so adding it moved no figure on
 * any screen. Only the projection writes `unstated`, and only on INSERT.
 */
export const billPaymentPositionEnum = pgEnum("bill_payment_position", [
  "stated",
  "unstated",
]);

/**
 * The two account managers an account has.
 *
 * Sales is who sells to them and whose book the account is in; back office is
 * who does the dispatch, the billing and the paperwork. They move
 * independently — a salesperson resigning says nothing about who raises the
 * invoices — which is why a change names one of these rather than moving
 * "the owner".
 */
/**
 * Which seat moved. Three of them, and they answer three questions: SALES is
 * who sells to the account and whose book it is, SALES_MANAGER is who that
 * salesperson answers to, BACK_OFFICE is dispatch, billing and paperwork.
 *
 * `sales_manager` is appended rather than slotted in beside `sales`: enum
 * order is not display order anywhere, and reordering a live enum rewrites
 * every row that uses it to buy nothing.
 */
export const amRoleEnum = pgEnum("am_role", [
  "sales",
  "sales_manager",
  "back_office",
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
  /**
   * Accounts have SEEN the claim and deliberately parked it while they look
   * for the money in the bank statement.
   *
   * Not a shade of `reported`. That one means nobody has looked yet, and the
   * quiet it buys the customer EXPIRES — otherwise anybody could take
   * themselves off the collections list by saying they had paid, and the
   * account would simply stop appearing. A hold is somebody in accounts
   * deciding, with their name and their reason on the row, and the quiet it
   * buys does not expire: chasing a customer for money we are in the middle of
   * finding is worse than a call not made. What replaces the expiry is
   * visibility — a hold ages in plain sight on the list it sits on.
   *
   * It touches no money. Every money path keys on `confirmed`, so nothing else
   * had to be taught about this one either.
   */
  "held",
  "confirmed",
  "rejected",
  /**
   * Money that counted and then did not — a cheque that cleared and bounced,
   * the same transfer entered twice, money applied to the wrong customer.
   *
   * Deliberately not `rejected`. That one means accounts looked and never
   * found it, so it never counted and the statement says "never arrived";
   * saying that about a payment the customer genuinely made and that genuinely
   * failed later is wrong on the one document that has to hold up when a
   * balance is disputed. Every money path keys on `confirmed`, so a reversal
   * stops counting without anything else being taught about it.
   */
  "reversed",
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
  /* ------------------------------------------------------------------
   * MBOS parents. A shop photograph, a bill photograph, a check-in selfie
   * and a sample handover are all files somebody has to be able to OPEN
   * later, and `/api/attachments/[id]` decides that from the parent kind —
   * so a file whose parent has no kind is a file nobody can read.
   *
   * They are declared here and USED by nothing yet, deliberately: Postgres
   * refuses to use an enum value in the transaction that adds it, and
   * drizzle-kit applies every pending migration in one. Declaring them a
   * migration early is what lets the MBOS routes use them at all.
   * ------------------------------------------------------------------ */
  "mbos_visit",
  "mbos_expense",
  "mbos_attendance",
  "mbos_sample",
  "mbos_task",
  "mbos_document",
  /**
   * Training material. It could have borrowed `mbos_document` and that would
   * have been wrong where it matters: `canRead` decides who may open a file
   * FROM the parent kind, so a course deck filed as a document would be read
   * under the document rules — role lists and a customer's scope, neither of
   * which a course has.
   */
  "mbos_course",
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
  /** The office end of MBOS. `field` is the handset; these are two audiences. */
  "sales",
  "accounts",
  "people",
  "reports",
  "hrms",
  "admin",
  /** Performance across every app, on one screen. Granted deliberately. */
  "founder",
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

/**
 * Credentials for outside services, set from the Admin Console.
 *
 * A DELIBERATELY separate table from `app_settings`, because everything that
 * makes that table good makes it wrong for a secret: settings are rendered on
 * a screen, exported and imported as JSON, and written to `audit_log` with
 * their before and after values. A key stored there would be readable in four
 * places at once, and one of them is a log nobody prunes.
 *
 * `value` is the secret and NOTHING selects it except the code that is about
 * to make the call. Screens read `last4` and `updatedAt` — enough to tell one
 * key from another and to know when it changed, useless to whoever is looking
 * over somebody's shoulder.
 *
 * It is stored as written rather than encrypted, and the screen says so. There
 * is nowhere to keep an encryption key that the app can read and a database
 * backup cannot — a key in the environment would put us back to needing shell
 * access, which is the problem this table exists to solve. What it buys is a
 * credential a manager can rotate from a screen; what it costs is that a
 * database dump carries it. Treat a dump accordingly.
 */
export const appSecrets = pgTable("app_secrets", {
  /** `openai.apiKey`, `anthropic.apiKey`, `gateway.apiKey`. */
  name: text("name").primaryKey(),
  value: text("value").notNull(),
  /** The tail of the key, for telling one from another on a screen. */
  last4: text("last4").notNull(),
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
    /**
     * The role this grant is held under.
     *
     * A person wears several hats and the account could hold one: Vikram is a
     * manager in the CRM and a clerk in Accounts, which are different powers
     * over different data rather than one power applied twice. Before this,
     * whoever set the account up picked the most powerful of the hats and
     * everything else came with it silently.
     *
     * NULL MEANS the account's primary role — which is what every row meant
     * before this column existed, and what `npm run app:grant` still writes: a
     * terminal that knows nothing about roles has to go on granting an app
     * that works.
     *
     * What it decides is CAPABILITIES, which are the union across every grant
     * a person holds. What it does not yet decide is SCOPE: `users.role` is
     * still what mine/team/all is read from, and it is now derived — the
     * widest role somebody holds anywhere — so a manager-in-the-CRM sees their
     * team. Scope per app is the next step, and until it lands an admin
     * anywhere is an admin everywhere for reading.
     */
    role: roleEnum("role"),
    grantedById: text("granted_by_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_access_user_app_key").on(t.userId, t.app),
    index("app_access_user_idx").on(t.userId),
    index("app_access_role_idx").on(t.role),
  ],
);

/**
 * Which screens inside an app somebody may open.
 *
 * `app_access` grants the CRM; this narrows it to the parts of the CRM they
 * work in. The module keys are `lib/modules.ts` — this table holds no labels,
 * because a label on a grant row is a second place for a screen's name to live
 * and they drift the first time one is renamed.
 *
 * NO ROWS FOR AN APP MEANS EVERY MODULE OF IT. That is not a shortcut, it is
 * the reason adding this moved nothing: every grant that existed before kept
 * meaning precisely what it meant, and a grant narrows only once somebody has
 * unticked something on the access screen. It also keeps `npm run app:grant`
 * and the provisioning path honest — neither knows about modules, and an app
 * granted from a terminal opens whole rather than opening empty.
 *
 * `app` is stored beside the key rather than parsed back out of it, so
 * revoking an app can delete its module rows in one statement.
 */
export const appModuleAccess = pgTable(
  "app_module_access",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    app: appIdEnum("app").notNull(),
    /** A key from `lib/modules.ts`, e.g. `crm.reminders`. */
    module: text("module").notNull(),
    grantedById: text("granted_by_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_module_access_user_module_key").on(t.userId, t.module),
    index("app_module_access_user_app_idx").on(t.userId, t.app),
  ],
);

/**
 * One row per person per day they opened MahekOne.
 *
 * The name is a misnomer kept for now, and the misnomer had consequences: two
 * screens told people their attendance was recorded, which it is not. A
 * sign-in says somebody opened the app — from home, on a phone, at 2am — and
 * `signedOutAt` only fills in for the few who press Sign out rather than
 * closing the tab, so no hours can be derived from a pair of these.
 *
 * Attendance is a check-in system with its own screens and its own rules, and
 * it is not built yet. When it is, it takes this name and this table becomes
 * what it always was: a sign-in log. Until then, nothing may present it as a
 * record of who was at work.
 */
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

/**
 * What the account IS in the trade — a dealer, a manufacturer who buys to
 * consume, a distributor who resells, a retailer. It decides which price list
 * applies and how the field team filters a customer list, and it is a fact
 * about the customer rather than a segment somebody assigns, which is why it
 * sits here and not on an MBOS-private table.
 */
export const customerTypeEnum = pgEnum("customer_type", [
  "dealer",
  "manufacturer",
  "distributor",
  "retailer",
]);

/** How much this account could be worth, in a salesman's judgement. */
export const customerPotentialEnum = pgEnum("customer_potential", [
  "high",
  "medium",
  "low",
]);

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(),

    /* identity and contact */
    externalCode: text("external_code"),
    name: text("name").notNull(),
    /**
     * Not every account has a single named contact — a shop counter often
     * does not — so this is no longer required to save the record. Business
     * name and phone still are: those are what a bill and a call need.
     */
    contactPerson: text("contact_person"),
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

    /*
     * A shop we deliver to, served through a distributor.
     *
     * NOT a third value of `kind`, deliberately. `kind` is exclusive, and this
     * is not: we may bill one of these directly, rarely, and an account we
     * invoiced last month is plainly still a shop we deliver to. Being a third
     * party is not what an account IS, it is how we WORK it — so it sits
     * beside the kind rather than inside it, and the record goes on being
     * whatever it already was for search, scope, history and everything else.
     *
     * What it means is narrow and it is the whole point: a marked account is
     * never PROSPECTED. It produces no "never ordered, chase them" row. Every
     * other reason still reaches the Call Log — an order it actually placed, a
     * debt, a promise — so a shop that starts buying directly comes back on
     * the strength of its own orders, without anybody remembering to unmark
     * it.
     *
     * Set by a person. Nothing derives it, and no import may write it: leads
     * were filled from a spreadsheet once already and that is the mess this
     * exists to sort out.
     */
    thirdParty: boolean("third_party").notNull().default(false),

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
    /**
     * Who the SALESPERSON answers to — the OWNER, on a lead that has no
     * salesperson yet.
     *
     * A third seat, and a different question to the two beside it. Sales is
     * who sells to this account; back office is who raises its paperwork; this
     * is the line manager above the sales seat — the person a manager reviews
     * a region's book with, and the person whose departure moves a hundred
     * accounts at once.
     *
     * It drives NOTHING outside itself. `ASSIGNED_TO_SQL` does not read it, no
     * queue is dated from it, no target counts against it and no scope
     * narrows by it — moving a sales manager moves no numbers between
     * anybody's people, which is exactly why it is a manager's to set while
     * `customer.reassign` stays accounts' and admin's.
     *
     * IT USED TO HAVE NO SOURCE TO RESTATE IT, and `sales_manager_decided_at`
     * did not exist for exactly that reason: nothing outside MahekOne stated
     * a sales manager, so there was nothing for a decided mark to hold off.
     * The org chart (`employee_reporting`) changed that — it is a real record
     * of who a salesperson reports to, kept inside MahekOne itself, and
     * `recomputeSalesManagers()` reads it nightly for every customer this
     * column has not been decided about, exactly the way `recomputeSalesPeople`
     * already reads the sheet for `salesPersonName`. The decided mark is what
     * makes that safe: a person's own pick has to survive the next org-chart
     * change the same way a reassignment has to survive the next sheet sync.
     */
    salesManagerId: text("sales_manager_id").references(() => users.id),
    /**
     * The same seat as a NAME, for somebody with no MahekOne login.
     *
     * The mirror of `backOfficeName`, and unlike it this one CAN be rebuilt:
     * `recomputeSalesManagers()` writes it from the org chart precisely when
     * the matched employee has no `users` account to give an id to, the same
     * "id first, name where there is none" rule `backOfficeName` already
     * follows.
     */
    salesManagerPersonName: text("sales_manager_person_name"),
    /**
     * When a PERSON decided this seat, as opposed to `recomputeSalesManagers`
     * last restating it from the org chart. The same job `am_decided_at` does
     * for the sales and back office seats: a null here is not "unassigned",
     * it is "nobody has ever overridden the org chart's own answer" — and it
     * is what the nightly recompute checks before touching the column, so a
     * manager's own choice is never quietly reverted by the next org-chart
     * change the way an unmarked reassignment used to be reverted by the
     * sheet. Set by `assignSalesManager` on every write, clear otherwise.
     */
    salesManagerDecidedAt: timestamp("sales_manager_decided_at", { withTimezone: true }),
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
    /**
     * When somebody in the app last DECIDED who this account answers to.
     *
     * Both account manager columns are the sheet's to state, and both mirrors
     * beside them are rebuilt from it — `recomputeSalesPeople()` rewrites
     * `salesPersonName` on every nightly pass, and `--reassign` overwrites the
     * ids outright. So an account manager changed in the app is a decision
     * standing in front of a source that will keep restating the old answer,
     * which is the shape of the two bugs that cost the most this month: an
     * order's approved status reset to `dispatched`, and a bill re-settled
     * fourteen hours after somebody marked it owed.
     *
     * This is the same mark as `orders.approvedAt` and `bills.paymentDecidedAt`
     * and it earns its place the same way: the projection never writes it, and
     * where it is set the sheet keeps its hands off both ids and both names.
     * Null means nobody has decided and the sheet is simply right, which is
     * true of every row that existed when this column arrived.
     */
    amDecidedAt: timestamp("am_decided_at", { withTimezone: true }),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    deactivatedById: text("deactivated_by_id").references(() => users.id),
    deactivationReason: text("deactivation_reason"),
    /** Raised by a telecaller, decided by a manager. */
    deactivationRequested: boolean("deactivation_requested").notNull().default(false),
    /**
     * WHO ASKED, AND WHEN.
     *
     * The request was a boolean and a reason and nothing else. The asker's name
     * existed only inside the notification text sent to managers — a sentence,
     * in a table nobody joins, that cannot be listed, sorted or aged. A manager
     * looking at a pending request could see that somebody wanted a customer
     * closed and had no way to find out who, or whether the ask was from this
     * morning or from March.
     *
     * Null on requests raised before these columns existed, and the screen says
     * so rather than guessing. The notification carrying the name is still in
     * `notifications` for anybody who needs to dig one out.
     */
    deactivationRequestedById: text("deactivation_requested_by_id").references(
      () => users.id,
    ),
    deactivationRequestedAt: timestamp("deactivation_requested_at", {
      withTimezone: true,
    }),
    /**
     * The same pair, in the other direction. A deactivated customer who wants
     * to come back is a decision somebody has to take deliberately —
     * `recomputeInactivity` will not do it on the strength of an order — so
     * the ask needs somewhere to live while it waits for a manager.
     */
    reactivationRequested: boolean("reactivation_requested").notNull().default(false),
    reactivationReason: text("reactivation_reason"),
    reactivationRequestedById: text("reactivation_requested_by_id").references(
      () => users.id,
    ),
    reactivationRequestedAt: timestamp("reactivation_requested_at", {
      withTimezone: true,
    }),

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
    /**
     * How predictable the cycle is, 0–100, or null where it is a default.
     *
     * DERIVED, like the cycle itself: `recomputeBuyingCycle` writes it and
     * nothing else may. It never changes the predicted date — a wobbly cycle
     * is still the best estimate there is — it says how much weight to put on
     * that date, which is a different question and one a telecaller can act
     * on.
     */
    cycleConfidence: integer("cycle_confidence"),
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

    /* ------------------------------------------------------------------
     * MBOS — field sales.
     *
     * The handset works the SAME customer master the CRM does. A second one
     * would give the business two answers to "who is this and what do they
     * owe", and the whole point of one database is that it cannot. Every
     * column here is nullable: the book was imported from a spreadsheet that
     * knows none of it, and a field team fills it in one shop at a time.
     * ------------------------------------------------------------------ */

    /**
     * Where the shop actually is, captured by standing in it. `gpsAccuracyM`
     * is the handset's own claim about the fix, and it is stored rather than
     * thrown away because a 900-metre fix and a 6-metre fix are not the same
     * pin — visit verification reads it before deciding anything.
     */
    gpsLat: doublePrecision("gps_lat"),
    gpsLng: doublePrecision("gps_lng"),
    gpsAccuracyM: integer("gps_accuracy_m"),
    gpsCapturedAt: timestamp("gps_captured_at", { withTimezone: true }),

    /** The route a salesman walks, and where it sits. Free text, from the beat master. */
    beat: text("beat"),
    area: text("area"),
    /** Wider than `region`, which the sheet fills — this is the sales territory. */
    territoryRegion: text("territory_region"),

    customerType: customerTypeEnum("customer_type"),
    potential: customerPotentialEnum("potential"),

    /** Paise, like every other amount. Null means no limit has been set. */
    creditLimitPaise: bigint("credit_limit_paise", { mode: "number" }),
    /**
     * A DECISION, not a derivation: accounts block an account and say why. The
     * handset refuses an order against a blocked customer and the sync rejects
     * one that was written offline, quoting this reason back.
     */
    creditBlocked: boolean("credit_blocked").notNull().default(false),
    creditBlockReason: text("credit_block_reason"),

    /* ---- derived and cached: never hand-edited, always recomputable ----
     *
     * The health score is a CACHE, in exactly the sense `outstanding`,
     * `cycleDays` and `slowPayer` above are. It is computed from orders,
     * payments, visits and complaints against the weights in
     * `mbos.health.componentWeights`, and if one looks wrong the fix is to
     * re-run its recompute, never to type over the row. `healthComponents`
     * keeps the parts it was made of, so a salesman shown 42 can be told why.
     */
    healthScore: integer("health_score"),
    healthComponents: jsonb("health_components"),
    healthComputedAt: timestamp("health_computed_at", { withTimezone: true }),
    /** Derived from `mbos_visits`. Rebuilt, never typed. */
    lastVisitDate: date("last_visit_date"),
    /** How often this customer should be SEEN, as against called. */
    visitFrequencyDays: integer("visit_frequency_days"),
    /** The code the trade knows them by, searched on the customer list. */
    dealerCode: text("dealer_code"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    index("customers_owner_idx").on(t.ownerId),
    /*
     * "Everything under Rahul" — asked on a book of eleven hundred, and asked
     * hardest on the day he leaves. Both halves of the seat are indexed: an
     * account whose sales manager has no login is held by the name alone, and
     * that is the row a transfer would otherwise scan the table for.
     */
    index("customers_sales_manager_idx").on(t.salesManagerId),
    index("customers_sales_manager_name_idx").on(t.salesManagerPersonName),
    index("customers_name_idx").on(t.name),
    index("customers_phone_idx").on(t.phone),
    index("customers_status_idx").on(t.status),
    uniqueIndex("customers_external_code_key").on(t.externalCode),
    /** The field team's two lists: a beat to walk, and a code to search by. */
    index("customers_beat_idx").on(t.beat),
    index("customers_dealer_code_idx").on(t.dealerCode),
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

    /* --------------------------------------------- what happens next
     *
     * WHAT THE TELECALLER WAS TOLD when they saved this call, in the words
     * they read on the screen.
     *
     * This is NOT a cache of the customer's current next step, and it must
     * never be recomputed. A cache answers "when is the next call" and is
     * rebuilt whenever the answer changes; this answers "what did we tell the
     * person who logged this call, on the day they logged it", and the moment
     * it is rebuilt that question has no answer left anywhere. It is the same
     * kind of row as `approvedAt` or `paymentDecidedAt` — a mark that somebody
     * was told something — and `lib/recompute.ts` deliberately does not touch
     * it.
     *
     * Written once, on save. The current next step is derived on read by
     * `nextStep` in `lib/engines/next-step.ts`, from live data, and the two are
     * allowed to differ: that difference is the record of what changed since.
     */
    nextStepKind: nextStepKindEnum("next_step_kind"),
    /** Null on `decide` and `none`, where there genuinely is no date. */
    nextStepDate: date("next_step_date"),
    /** The queue reason that was going to bring them back. */
    nextStepReason: text("next_step_reason"),
    nextStepHeadline: text("next_step_headline"),
    nextStepDetail: text("next_step_detail"),
    /** Why they were not on the list that same day, where something held them. */
    nextStepHeldToday: text("next_step_held_today"),

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

/**
 * A group of products that a mix target can be set on.
 *
 * The brief names four — Universal, PU, Nano, Other — and the catalogue has
 * nineteen formulations, so a category cannot be a formulation and must not be
 * four strings typed into a screen. It is a row, formulations point at it, and
 * a manager can add "Epoxy" the day epoxy becomes strategic.
 *
 * Exactly one category is the RESIDUAL, which is what "Other" is: every
 * formulation nobody has classified, plus every order line whose product name
 * matched nothing in the catalogue, lands in it. Without a residual the shares
 * would not total 100% and every percentage on the screen would be wrong by an
 * amount nothing named.
 */
export const productCategories = pgTable(
  "product_categories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /**
     * The catch-all. At most one row may carry it, which the partial unique
     * index below enforces — two residuals would mean unclassified value
     * counted twice and every share overstated.
     */
    isResidual: boolean("is_residual").notNull().default(false),
    active: boolean("active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("product_categories_slug_key").on(t.slug),
    uniqueIndex("product_categories_residual_key")
      .on(t.isResidual)
      .where(sql`is_residual`),
  ],
);

export const productFormulations = pgTable(
  "product_formulations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Lowercased, punctuation stripped — the match key, unique. */
    slug: text("slug").notNull(),
    notes: text("notes"),
    /*
     * Which mix category this liquid sells under — Universal, PU, Nano, Other.
     *
     * The classification hangs on the FORMULATION rather than on the brand or
     * the SKU because that is the level at which it is actually true: one
     * liquid sells as Nano, Astar Nano and M5x4 Thinner, and all three are the
     * same strategic product. Classifying brands would mean saying it three
     * times, and the day somebody says it twice and differently is the day the
     * mix percentages stop adding up.
     *
     * Null is not an error and not a backlog: it means the residual category,
     * which is what "Other" is. A new formulation is therefore Other until
     * somebody says otherwise, which is the safe direction — the alternative
     * is a product that silently belongs to no category and value that
     * disappears out of the denominator.
     */
    categoryId: text("category_id").references(() => productCategories.id),
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
    /*
     * Where the goods went, when that is not where the bill went.
     *
     * NULL MEANS THE BILLING PARTY RECEIVED THEM, which is the ordinary case
     * and true of every row that existed when this column arrived — so nothing
     * had to be rewritten and no existing order changed meaning.
     *
     * Money never follows this column. Credit, term, outstanding, receipts and
     * collections all stay with `customerId`, whatever the lorry did.
     */
    deliveryCustomerId: text("delivery_customer_id").references(
      () => customers.id,
    ),
    userId: text("user_id").references(() => users.id),
    /** Kept from day one: Inactive Watch produces false positives without it. */
    source: orderSourceEnum("source").notNull().default("crm"),
    externalRef: text("external_ref"),
    /**
     * The number a human quotes: `MBOS/26-27/0041`. Allocated server-side from
     * a series on first sync and NEVER the identity — two salesmen offline
     * would otherwise mint the same one. Null for orders that were never given
     * a number, which is most of the CRM's own.
     */
    orderNo: text("order_no"),
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
    uniqueIndex("orders_order_no_key").on(t.orderNo),
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
    /**
     * Whether anybody has stated this bill's payment position — see
     * `billPaymentPositionEnum`. `unstated` is held out of every money figure
     * rather than counted as debt. The sheet may write it on INSERT and never
     * again; only the app moves a bill to `stated`.
     */
    paymentPosition: billPaymentPositionEnum("payment_position")
      .notNull()
      .default("stated"),
    disputed: boolean("disputed").notNull().default(false),
    /**
     * When somebody DECIDED what this bill's payment position is, as opposed to
     * the order sheet assuming it.
     *
     * The order sheet says nothing about payment, so a bill imported from it is
     * settled by assumption. That assumption must never overwrite a decision —
     * Tally's receivables report saying the money is still owed, a payment
     * recorded in Accounts, a receipt confirmed or rejected. This is the mark of
     * one, exactly as `orders.approvedAt` is for approvals, and the projection
     * never writes it and never settles a bill that carries it.
     *
     * It exists because the assumption DID overwrite a decision, twice over.
     * `leaveOwing` unsettles a bill by deleting its assumed receipt, which frees
     * the `SHEETPAY-<order number>` idempotency key — and a free key reads to
     * the importer as "never settled", so the next scheduled pass wrote a fresh
     * full-amount receipt. Applying the receivables report on 9 August marked
     * 395 bills owed; 348 of them, Rs 1.18 crore, were quietly settled again
     * fourteen hours later by a cron nobody was watching.
     */
    paymentDecidedAt: timestamp("payment_decided_at", { withTimezone: true }),
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

    /**
     * The date written ON the instrument, where the instrument carries one.
     *
     * A cheque is the case this exists for, and it is a different fact from
     * `received_at`: a customer hands over a cheque on the 3rd dated the 20th,
     * and the money cannot reach the bank until the 20th however firmly it is
     * in our hands. Two dates, two questions — when did we get it, and when
     * can it be banked — and collapsing them into one loses whichever answer
     * somebody needed.
     *
     * It may be in the past or the future. A cheque dated last week is one
     * somebody should have banked already, which is exactly the kind of thing
     * that goes quiet in a drawer; a cheque dated next month is a customer who
     * should not be chased until then.
     *
     * Which modes carry one is `payments.datedModes`, because the mode list
     * itself is configuration and hardcoding "Cheque" here would put the two
     * out of step the day somebody adds "Demand draft".
     */
    instrumentDate: date("instrument_date"),
    /**
     * The receipt number a salesman reads back to the shop: `MRCP/26-27/0007`.
     * Allocated server-side from a series on first sync. It is OURS — the
     * bank's own name for the money is `reference`, and the two are not the
     * same fact. Null where nothing issued one.
     */
    receiptNo: text("receipt_no"),
    note: text("note"),
    status: receiptStatusEnum("status").notNull().default("reported"),
    /** Where it came from: accounts, a collections call, the bills screen, the sheet. */
    source: text("source").notNull().default("accounts"),
    reportedById: text("reported_by_id").references(() => users.id),
    confirmedById: text("confirmed_by_id").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    rejectReason: text("reject_reason"),

    /* ------------------------------------------------------------ the hold
     *
     * Who parked it, when, and why. The reason is REQUIRED by the action that
     * writes it: a hold takes the customer off collections entirely, and a
     * telecaller who has just been told "the system says you are on hold"
     * needs something to say when the customer rings and asks why nobody has
     * been in touch. "Held" on its own gives them nothing.
     *
     * These stay on the row after the hold is resolved. A payment that was
     * held for nine days and then rejected is a story somebody will have to
     * account for, and clearing the columns on decision would erase it.
     */
    heldById: text("held_by_id").references(() => users.id),
    heldAt: timestamp("held_at", { withTimezone: true }),
    holdReason: text("hold_reason"),

    /* --------------------------------------------------- the cash deposit
     *
     * Cash a salesman collected and then paid into the bank, with the slip
     * photographed. It is the FIRST half of a two-step answer and it is not a
     * confirmation: the salesman says he banked it, and the back office says
     * it appeared on the statement, which is `confirmed` and nothing else.
     * Either half alone leaves somebody reconciling from memory later, and
     * cash in hand is a real personal liability for the person carrying it.
     *
     * Only cash has a deposit. A transfer is already in the bank, and a cheque
     * is banked by the office rather than by the man who took it.
     */
    depositedAt: timestamp("deposited_at", { withTimezone: true }),
    depositedById: text("deposited_by_id").references(() => users.id),
    /** The paying-in slip. An `attachments` id, like every other photograph. */
    depositProofId: text("deposit_proof_id").references(() => attachments.id),

    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    uniqueIndex("payment_receipts_key").on(t.idempotencyKey),
    uniqueIndex("payment_receipts_receipt_no_key").on(t.receiptNo),
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
    /**
     * A telecaller's own decision, same family as `amDecidedAt` and
     * `paymentDecidedAt`: while this reminder is pending and its due date is
     * still ahead, the queue holds off order/cycle reasons that would
     * otherwise put the customer back on a Call Log before the promised
     * date. Never inferred — set only through the hold action offered
     * alongside the promise itself.
     */
    holdOtherReasonsUntilDue: boolean("hold_other_reasons_until_due")
      .notNull()
      .default(false),
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
    /**
     * Copied forward from last month's MANUAL target rather than typed this
     * month, or recomputed from trailing sales. `seedMonthlyTargets` sets it
     * true on the row it carries forward, and `setTarget` clears it the
     * moment a manager actually saves a real change — the same pattern as
     * `sales_targets.carried_forward`. A carried target is never a default:
     * it is still somebody's decision, just not one made for this month.
     */
    carriedForward: boolean("carried_forward").notNull().default(false),
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
    /**
     * WHICH ROLE ALLOWED IT.
     *
     * With one role per person, "was he allowed to do this" was answerable
     * from the person. With four it is not: the log says Vikram approved an
     * order, and nobody can later tell whether he did it as the accounts clerk
     * — ordinary — or because a manager hat carried it, which it does not and
     * must not. `requireCapability` knows which role granted the capability,
     * so it is written down beside the action.
     *
     * Null means NOT RECORDED, never "no role": every row that predates this,
     * and anything written outside a capability check.
     */
    actorRole: roleEnum("actor_role"),
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
/**
 * THE DAY'S CALL LIST, settled once and read all day.
 *
 * It began as a record of who was in each queue when the day opened, so the
 * screen could say how many rows had carried over. It is now the list itself:
 * the first read of a business day builds it and writes it here, and every
 * read after that works from these rows.
 *
 * What that buys is a day a telecaller can plan: the list does not reshuffle
 * under them because a colleague logged a call, and "twelve of forty worked"
 * is a real figure rather than a fraction of a moving denominator.
 *
 * What is FROZEN is the composition — who is on it, why, and in what order.
 * What stays live is whether each row still needs doing: a customer who orders
 * at eleven drops off at eleven, and a promise falling due today is added the
 * moment it does. A frozen list that went on asking for an order somebody had
 * already placed would be worse than no list at all.
 *
 * One row per user per customer: an account reaches its sales manager AND its
 * back office manager, so the same customer legitimately appears on two lists.
 */
export const queueSnapshots = pgTable(
  "queue_snapshots",
  {
    day: date("day").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** The winning reason's weight, as it was when the day was settled. */
    score: integer("score").notNull().default(0),
    /** Every reason, in the order the screen shows them. */
    reasons: jsonb("reasons")
      .$type<Array<{ kind: string; label: string; weight: number }>>()
      .notNull()
      .default([]),
    /** Position in the settled list, so the order survives a reload. */
    rank: integer("rank").notNull().default(0),
    /** When the list was built — the answer to "settled at what time". */
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.userId, t.customerId] }),
    index("queue_snapshots_day_idx").on(t.day),
    index("queue_snapshots_user_day_idx").on(t.userId, t.day),
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
/**
 * Where the sheet and the app disagree, and nothing was overwritten.
 *
 * The team works in the spreadsheet and the CRM projects what they type, so
 * for almost every column the sheet is simply right and should win. There is
 * one exception, and it is expensive: an order the sheet calls `dispatched`
 * that accounts have APPROVED or DECLINED in the app. The projection used to
 * reset it on the next pass, silently — and because the approval columns are
 * not part of that overwrite, the row was left saying "declined by Deepa at
 * 3pm, reason: over credit limit" while its status read `dispatched`.
 *
 * That is not a cosmetic disagreement. Approved status drives EOD value,
 * targets, the buying cycle, the product history and outstanding, so a reset
 * moves real figures on five screens with nobody's name against it.
 *
 * So the decision stands and the disagreement is written down here instead.
 * A row in this table means: the sheet says one thing, a person decided
 * another, and a human has to choose. Nothing is lost either way, which is
 * the only property that matters — the alternative was losing one of them and
 * not saying which.
 */
/**
 * Every change of account manager, and why.
 *
 * `audit_log` records it too and would technically hold the answer, but it is
 * one undifferentiated stream across the whole platform: finding "who has this
 * account belonged to, and why did it move" means grepping JSON blobs by
 * entity id. This is the question people will actually ask — when a
 * salesperson leaves, somebody wants the list of accounts that moved and the
 * reason against each — so it gets a table with the reason as a COLUMN, which
 * is the difference between a log and a history you can group by.
 *
 * One row per customer per role per change. Both roles can be changed in a
 * single action and that writes two rows, because they are two facts: the
 * salesperson leaving says nothing about who does the paperwork.
 *
 * Nothing here is ever updated or deleted. A reassignment that turns out to be
 * wrong is corrected by another reassignment, which is another row.
 */
/**
 * Who bills the shop we deliver to.
 *
 * `customers.thirdParty` says an account is served through a distributor. This
 * says WHICH — one row per shop per distributor, at least one for every marked
 * account, and it is what makes the mark an arrangement somebody can act on
 * rather than an assertion with nothing behind it.
 *
 * A LIST, not a column on the customer. A shop on the boundary between two
 * territories is served by two distributors, and storing one of them would
 * make the other unrecordable — wrong for exactly the accounts that most need
 * this recorded. `isPrimary` is who serves it usually, and the partial unique
 * index is what keeps there being at most one: a rule enforced in a service is
 * a rule the next writer does not know about.
 *
 * The distributor is always an account WE BILL — `kind = 'customer'` and not
 * itself marked. That is checked in the action rather than expressed here,
 * because it is a fact about two rows and Postgres cannot state it without a
 * trigger; the picker only offers direct customers and the action refuses
 * anything else, which is the same shape as every other capability here.
 *
 * Set by a person, like the mark it hangs off. No import writes it and nothing
 * derives it — `orders.deliveryCustomerId` is the EVIDENCE this decision is
 * usually made from, and evidence is not the decision.
 */
export const customerDistributors = pgTable(
  "customer_distributors",
  {
    id: text("id").primaryKey(),
    /** The third-party customer — the shop the goods go to. */
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** The direct customer who buys from us and bills the shop. */
    distributorCustomerId: text("distributor_customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** Who serves it usually. At most one per shop, and possibly none. */
    isPrimary: boolean("is_primary").notNull().default(false),
    /** The arrangement in somebody's own words — a route, a rate, a caveat. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedById: text("updated_by_id").references(() => users.id),
  },
  (t) => [
    // Naming the same distributor twice is a double-click, not a second
    // arrangement, and two identical rows would be counted as two.
    uniqueIndex("customer_distributors_pair_key").on(t.customerId, t.distributorCustomerId),
    uniqueIndex("customer_distributors_primary_key")
      .on(t.customerId)
      .where(sql`${t.isPrimary}`),
    index("customer_distributors_distributor_idx").on(t.distributorCustomerId),
  ],
);

export const customerAmChanges = pgTable(
  "customer_am_changes",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** `sales` or `back_office` — which of the two managers moved. */
    role: amRoleEnum("role").notNull(),
    /**
     * Who it was, as an id AND as a name. The id is null where the sheet only
     * ever named somebody without an account, and the name is what makes the
     * history readable years later when the account is gone — a history of
     * user ids nobody can resolve is not a history.
     */
    fromUserId: text("from_user_id").references(() => users.id),
    fromName: text("from_name"),
    toUserId: text("to_user_id").references(() => users.id),
    toName: text("to_name"),
    /** One of `people.amChangeReasons`, so the list is a manager's to change. */
    reasonCode: text("reason_code").notNull(),
    /** Free text beside the code. Required when the code is `other`. */
    note: text("note"),
    changedById: text("changed_by_id").references(() => users.id),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("customer_am_changes_customer_idx").on(t.customerId, t.changedAt),
    // "Everything that moved when Suresh left" — the reason this is a table.
    index("customer_am_changes_from_idx").on(t.fromUserId, t.changedAt),
    index("customer_am_changes_reason_idx").on(t.reasonCode, t.changedAt),
  ],
);

export const syncConflicts = pgTable(
  "sync_conflicts",
  {
    id: text("id").primaryKey(),
    /** Which sync produced it, so it can be traced to a pull. */
    syncId: text("sync_id"),
    /** `orders` today. Named because the next one will not be. */
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    /** The column that disagreed. */
    field: text("field").notNull(),
    /** What the sheet wanted to write. */
    sheetValue: text("sheet_value"),
    /** What the app holds, and what was KEPT. */
    appValue: text("app_value"),
    /** Who made the app-side decision, where that is known. */
    decidedById: text("decided_by_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    /** Cleared when somebody has looked, never deleted. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedById: text("resolved_by_id"),
    /** Which way they went, in their own words. */
    resolution: text("resolution"),
  },
  (t) => [
    /*
     * One OPEN conflict per field per record. A sheet nobody has corrected
     * re-reports the same disagreement on every pass — every thirty minutes,
     * forever — and a list that grows by forty-eight rows a day is a list
     * nobody reads. Re-detecting an unresolved one is a no-op; once it is
     * resolved, a fresh disagreement opens a new row.
     */
    uniqueIndex("sync_conflicts_open_key")
      .on(t.entityType, t.entityId, t.field)
      .where(sql`${t.resolvedAt} is null`),
    index("sync_conflicts_open_idx").on(t.resolvedAt, t.detectedAt),
  ],
);

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
 * WHO REPORTS TO WHOM. A person, pointing at a person.
 *
 * ITS OWN TABLE, and that is the point rather than an implementation detail.
 * `employees` is a MIRROR of the workbook's Employee Details tab — HR maintains
 * that sheet, the sync rewrites the row on every change, and nothing on an HRMS
 * screen may be edited because the next pass would silently undo it. This is
 * the first piece of employee data MahekOne owns rather than reflects, so it
 * lives outside the mirrored row where the sync cannot reach it. Putting it in
 * a column would work today — `upsertColumns()` is an allow-list of 44 names —
 * and would break the first time somebody added the 45th without noticing.
 *
 * IT COULD NOT COME FROM THE SHEET. `employees.reports_to` is already there and
 * looks like the answer until you read it: 60 of 71 rows carry one of four
 * POSITION titles — "HR and Sales Head", "Production Head", "Bhiwandi Head",
 * "Sales State Head" — and not one matches an employee's name. It says what
 * kind of person somebody answers to, never which one, so no tree can be built
 * from it and nothing above those four heads exists at all.
 *
 * One row per employee, so `employee_id` is unique: a person has one manager
 * here. Dotted lines, matrix reporting and dated history are all real things
 * and none of them are this — they would each need their own shape, and
 * inventing that shape before anybody has asked for it would be guessing.
 */
export const employeeReporting = pgTable(
  "employee_reporting",
  {
    id: text("id").primaryKey(),
    /** The person who reports. Cascade: their record going takes the link. */
    employeeId: text("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /**
     * The person they report to.
     *
     * Also cascade, deliberately. A manager whose employee record is deleted
     * leaves their reports MANAGERLESS rather than pointing at nothing — the
     * tree then shows them as unassigned, which is true and visible, instead of
     * a dangling id that every query has to remember to guard.
     */
    managerId: text("manager_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** Who decided this, and when. HR will be asked "who moved me". */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedById: text("updated_by_id").references(() => users.id),
  },
  (t) => [
    // One manager per person. The upsert keys on this.
    uniqueIndex("employee_reporting_employee_key").on(t.employeeId),
    // Drawing the tree asks "who reports to this person" once per node.
    index("employee_reporting_manager_idx").on(t.managerId),
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

/**
 * The raw landing table for the Activity tab of a defunct prior system
 * ("Mahek EMP 2.0") — a field salesman's visit/call log from before MBOS
 * existed. One row per sheet row, keyed on the sheet's own Activity ID.
 *
 * It started as a one-time backfill and is a live mirror now that the
 * service account can reach the sheet, but nothing here feeds the buying
 * cycle, the queue, `calls` or `mbos_visits` regardless — those engines and
 * that table are owned by the CRM and the live MBOS sync protocol
 * respectively, and neither has a shape (verified GPS, NOT NULL
 * customer/salesman ids) this free-text history can honestly claim. What
 * DOES read a matched row is
 * `timeline_events` — see `lib/field-activity-projection-service.ts` — which
 * is how this reaches a salesman's phone and a customer's shared history
 * without pretending to be either a live visit or a telecaller call.
 */
export const sheetFieldActivityRows = pgTable(
  "sheet_field_activity_rows",
  {
    id: text("id").primaryKey(),
    syncId: text("sync_id")
      .notNull()
      .references(() => sheetSyncRuns.id, { onDelete: "cascade" }),
    /** 1-based row in the sheet, header included. */
    rowNumber: integer("row_number").notNull(),

    /** The sheet's own "Activity ID", e.g. 85E8E144. The idempotency key. */
    activityId: text("activity_id").notNull(),

    /** Every column as the sheet gave it. Never selected by a list query. */
    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    rowHash: text("row_hash").notNull(),

    status: sheetRowStatusEnum("status").notNull().default("present"),
    lastSeenSyncId: text("last_seen_sync_id"),

    /* ------------------------------ matching ------------------------------
     * Free text on both sides — the sheet named neither a MahekOne account
     * nor a customer id. Nothing here guesses: a name with more than one
     * close candidate is `ambiguous`, not silently resolved to whichever
     * sorts first.
     */
    employeeName: text("employee_name"),
    matchedSalesmanId: text("matched_salesman_id").references(() => users.id, {
      onDelete: "set null",
    }),
    salesmanMatchStatus: sheetMatchStatusEnum("salesman_match_status")
      .notNull()
      .default("pending"),

    customerName: text("customer_name"),
    matchedCustomerId: text("matched_customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    customerMatchStatus: sheetMatchStatusEnum("customer_match_status")
      .notNull()
      .default("pending"),
    /** The candidates a match could not choose between, for manual review. */
    matchNote: text("match_note"),

    /*
     * ------------------------------ the visit ------------------------------
     * `visitDate` is nullable like every other best-effort column here — a
     * row with an unreadable date still imports, with an issue naming why,
     * rather than being dropped and losing the other eleven columns with it.
     * Every real row in the data this ships against parses cleanly; this is
     * defence for whatever the live sheet turns out to hold later.
     */
    visitDate: date("visit_date"),
    /** The sheet's "Time Given" — minutes spent at the shop, not a clock time. */
    durationMinutes: integer("duration_minutes"),
    meetingNote: text("meeting_note"),
    issueNote: text("issue_note"),
    /** The sheet's "Remainder Date". Used on 7 of 32,928 rows — kept, not built on. */
    reminderDate: date("reminder_date"),

    /**
     * The sheet's "Mood" column conflates two things: a real mood (Normal,
     * Happy, Angry) and a "Stage 0..7" label from the old app's own customer
     * pipeline, which has no relationship to this app's customer model.
     * `moodRaw` keeps the cell verbatim; `mood` and `stageLabel` are a
     * best-effort split of it, both nullable, neither guessed.
     */
    moodRaw: text("mood_raw"),
    mood: text("mood"),
    stageLabel: text("stage_label"),

    /** "Visit" or "Call". */
    meetingType: text("meeting_type"),
    /** "Follow up", "New Lead", "Payment Collection", … — kept as the sheet spells it. */
    meetingPurpose: text("meeting_purpose"),
    /** Free-text address. No lat/lng in this data — never plotted on the Live map. */
    location: text("location"),

    /**
     * Whether this row has produced its `timeline_events` entry. Belt and
     * braces alongside that table's own natural-key `onConflictDoNothing`: a
     * re-run of the projection should not have to re-derive its own counts
     * from a DB-level no-op.
     */
    timelineEventWritten: boolean("timeline_event_written").notNull().default(false),

    issues: jsonb("issues").$type<SheetRowIssue[]>().notNull().default([]),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sheet_field_activity_rows_activity_id").on(t.activityId),
    index("sheet_field_activity_rows_sync_idx").on(t.syncId),
    index("sheet_field_activity_rows_salesman_idx").on(t.matchedSalesmanId),
    index("sheet_field_activity_rows_customer_idx").on(t.matchedCustomerId),
    index("sheet_field_activity_rows_date_idx").on(t.visitDate, t.id),
    /** Drives the exceptions review: unresolved customer names, cheaply. */
    index("sheet_field_activity_rows_customer_match_idx").on(t.customerMatchStatus),
    /** The projection's own worklist: matched rows not yet written. */
    index("sheet_field_activity_rows_unprojected_idx").on(
      t.customerMatchStatus,
      t.timelineEventWritten,
    ),
  ],
);

/* ═══════════════════════════════════════════════════════ MBOS — field sales
 *
 * The Mahek Business Operating System's field app: a salesman's handset,
 * offline first, syncing into this database. It is another MahekOne app on the
 * same schema — it does not own a customer master, a product catalogue or a
 * ledger, and it must never grow one.
 *
 * Two things are true of every table below and of nothing else here.
 *
 * 1. **The id is the CLIENT's.** A record is created on a handset with no
 *    signal, gets `mbos_<entity>_<uuid>` there, and that id is the primary key
 *    on both sides — the server does not mint a replacement (PROTOCOL.md §1).
 *    It is what lets an offline visit own an offline order that owns an
 *    offline payment, with all three referencing each other before any of them
 *    has ever reached a server.
 * 2. **Two clocks, and they disagree.** `clientCreatedAt` is when the handset
 *    says it happened and `serverCreatedAt` is when we heard about it. A
 *    handset's clock is wrong and its owner can set it, so ordering, conflict
 *    resolution and anything anybody is paid on read the server's (§7).
 *    Keeping only one of the two would either lose the field truth or trust it.
 *
 * `deviceId` rides on every row because "which handset wrote this" is the
 * first question asked of a record that looks wrong.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The universal MBOS columns, §2.1. A function rather than a constant so each
 * table gets its own column instances — Drizzle mutates them with the table
 * they belong to, and a shared object would bind every table to the first.
 */
function mbosColumns() {
  return {
    /** Minted on the DEVICE. See the note above; never regenerated here. */
    id: text("id").primaryKey(),
    /** What the handset's clock said. Believed for display, never for order. */
    clientCreatedAt: timestamp("client_created_at", { withTimezone: true }),
    serverCreatedAt: timestamp("server_created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdById: text("created_by_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedById: text("updated_by_id"),
    /** Which install wrote it. One per handset, from SecureStore. */
    deviceId: text("device_id"),
  };
}

/* ------------------------------------------------------- the shared stream */

/** Which app wrote the event. Deliberately not a role — apps write, people act. */
export const timelineSourceAppEnum = pgEnum("timeline_source_app", ["crm", "mbos"]);

/**
 * One chronological stream per customer, written by BOTH apps (brief §1.1).
 *
 * Not prefixed `mbos_`, because it is not MBOS's. A telecaller's call, a
 * salesman's visit, an order, a payment and a complaint are one story about
 * one customer, and the reason this table exists is that the story was
 * previously only assemblable by querying six tables in the right order and
 * knowing all six existed.
 *
 * It is a PROJECTION and it is read-only: entries are written by the module
 * that owns the underlying record, never edited here, and `sourceRecordId`
 * always leads back to the row that is the actual truth. Nothing may be
 * derived from this table that is not already derivable from its sources — a
 * timeline that starts being believed becomes a second ledger.
 */
export const timelineEvents = pgTable(
  "timeline_events",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** `visit`, `call`, `order`, `payment`, `complaint`, `sample`, `whatsapp`… */
    eventType: text("event_type").notNull(),
    sourceApp: timelineSourceAppEnum("source_app").notNull(),
    /** The id of the row this describes, in whichever table owns it. */
    sourceRecordId: text("source_record_id"),
    /** When it HAPPENED, not when it was projected. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    actorUserId: text("actor_user_id").references(() => users.id),
    /** One line a human reads. Never parsed by anything. */
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The only query this table has: one customer, newest first. */
    index("timeline_events_customer_idx").on(t.customerId, t.occurredAt.desc()),
    index("timeline_events_source_idx").on(t.eventType, t.sourceRecordId),
    /*
     * The natural key: one projection per source row per kind of event.
     *
     * A projection has to be safe to re-run — the backfill of five years of
     * calls is going to be run twice by somebody, and a stream that grew a
     * second copy of every call would be read as the telecaller having rung
     * twice. `source_record_id` null is left alone, because Postgres treats
     * nulls as distinct in a unique index and an event with no source row is
     * not a projection of anything.
     */
    uniqueIndex("timeline_events_natural_key").on(
      t.sourceApp,
      t.eventType,
      t.sourceRecordId,
    ),
  ],
);

/* --------------------------------------------------------------- devices */

/**
 * §2.2 — device binding. One install, bound to one employee.
 *
 * A shared handset is how one salesman's visits get attributed to another, and
 * a lost handset with a live session is a customer book somebody else is
 * carrying. Binding is recorded rather than assumed: `active` false is a
 * device that has been released, and the row stays because "whose phone wrote
 * this record in March" outlives the phone.
 */
export const mbosDevices = pgTable(
  "mbos_devices",
  {
    ...mbosColumns(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The install's own id. Unique — one row per handset, whoever holds it. */
    deviceId: text("device_id").notNull(),
    /** What the handset says it is, for a human reading the list. */
    model: text("model"),
    platform: text("platform"),
    appVersion: text("app_version"),
    boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    /** Why it was released, where somebody said. */
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
  },
  (t) => [
    uniqueIndex("mbos_devices_device_key").on(t.deviceId),
    index("mbos_devices_user_idx").on(t.userId, t.active),
  ],
);

/* --------------------------------------------------------- journey planner */

export const mbosJourneyPlanStatusEnum = pgEnum("mbos_journey_plan_status", [
  "draft",
  "active",
  "completed",
  "abandoned",
]);

/**
 * How far a day has got in being AGREED, which is a different axis from how
 * far it has got in being walked.
 *
 * The design's model: the manager proposes a city, the salesman refuses it
 * with a reason or agrees, and once agreed he picks the shops himself —
 * because he is the one who knows whether that market is shut on a Wednesday.
 * Only then is the day planned.
 */
export const mbosPlanDayStateEnum = pgEnum("mbos_plan_day_state", [
  "proposed",
  "refused",
  "agreed",
  "planned",
]);

export const mbosJourneyStopStatusEnum = pgEnum("mbos_journey_stop_status", [
  "planned",
  "visited",
  "skipped",
]);

/** §2.6 — a day's route: which shops, in which order, on which beat. */
export const mbosJourneyPlans = pgTable(
  "mbos_journey_plans",
  {
    ...mbosColumns(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The day it is FOR. A business date in Asia/Kolkata, never a timestamp. */
    planDate: date("plan_date").notNull(),
    beat: text("beat"),
    area: text("area"),
    status: mbosJourneyPlanStatusEnum("status").notNull().default("draft"),
    /** Set when the salesman actually started walking it. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** True once auto-optimise reordered the stops. */
    optimised: boolean("optimised").notNull().default(false),
    estimatedTravelMinutes: integer("estimated_travel_minutes"),
    notes: text("notes"),

    /* ---- the negotiation ----
     *
     * A plan is agreed rather than issued. `dayState` defaults to `planned` so
     * every row that existed before this kept exactly the meaning it had.
     */
    dayState: mbosPlanDayStateEnum("day_state").notNull().default("planned"),
    /** What the manager proposes. A beat is the salesman's own division of it. */
    city: text("city"),
    proposedById: text("proposed_by_id").references(() => users.id),
    proposedAt: timestamp("proposed_at", { withTimezone: true }),
    /** Why he will not walk it. Required by the action that writes a refusal. */
    refusalReason: text("refusal_reason"),
    /** What he wants instead. Optional — "not this" is a legitimate answer. */
    counterCity: text("counter_city"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("mbos_journey_plans_user_day_key").on(t.userId, t.planDate),
    index("mbos_journey_plans_date_idx").on(t.planDate),
    index("mbos_journey_plans_state_idx").on(t.dayState, t.planDate),
  ],
);

/** One shop on a plan. `sequence` is the order to walk them in. */
export const mbosJourneyStops = pgTable(
  "mbos_journey_stops",
  {
    ...mbosColumns(),
    planId: text("plan_id")
      .notNull()
      .references(() => mbosJourneyPlans.id, { onDelete: "cascade" }),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    plannedAt: timestamp("planned_at", { withTimezone: true }),
    actualVisitAt: timestamp("actual_visit_at", { withTimezone: true }),
    status: mbosJourneyStopStatusEnum("status").notNull().default("planned"),
    /** Mandatory in the interface when a stop is skipped — the plan is a promise. */
    skipReason: text("skip_reason"),
  },
  (t) => [
    index("mbos_journey_stops_plan_idx").on(t.planId, t.sequence),
    index("mbos_journey_stops_customer_idx").on(t.customerId),
  ],
);

/* --------------------------------------------------------------- samples */

/** §2.11 — where a sample got to. `pending` is an answer, not a gap. */
export const mbosSampleOutcomeEnum = pgEnum("mbos_sample_outcome", [
  "pending",
  "approved",
  "rejected",
]);

/**
 * A sample handed to a customer, tracked to the order it did or did not
 * become. The point of the table is the last column: a sample nobody followed
 * up is stock given away.
 */
export const mbosSamples = pgTable(
  "mbos_samples",
  {
    ...mbosColumns(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    salesmanId: text("salesman_id")
      .notNull()
      .references(() => users.id),
    productId: text("product_id").references(() => products.id),
    /** CANS, like every other quantity in MahekOne. See `products`. */
    quantityCans: integer("quantity_cans"),
    requestedDate: date("requested_date"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Proof of handover — an `attachments` id, never a URL. */
    deliveryPhotoId: text("delivery_photo_id").references(() => attachments.id),
    trialOutcome: mbosSampleOutcomeEnum("trial_outcome").notNull().default("pending"),
    followUpDate: date("follow_up_date"),
    feedbackNotes: text("feedback_notes"),
    /** Set when the trial became a sale. The conversion report is this column. */
    convertedOrderId: text("converted_order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("mbos_samples_customer_idx").on(t.customerId),
    index("mbos_samples_follow_up_idx").on(t.trialOutcome, t.followUpDate),
  ],
);

/* ---------------------------------------------------------------- visits */

/**
 * §2.4 — what a visit produced. `visited` is the honest answer for a call that
 * produced nothing, and it is kept distinct from `not_available` and `closed`,
 * which are facts about the shop rather than about the sale.
 */
export const mbosVisitOutcomeEnum = pgEnum("mbos_visit_outcome", [
  "visited",
  "order",
  "payment",
  "complaint",
  "sample",
  "not_available",
  "closed",
]);

/**
 * §2.4 — one visit to one shop.
 *
 * Append-only in the protocol's sense: a visit created on two handsets is two
 * visits, never a conflict (PROTOCOL.md §7). Nothing here is edited after the
 * salesman leaves the shop.
 *
 * `verified` and `locationMismatch` are the honest part. A check-in 400 metres
 * from the shop's own pin is not proof of anything — the pin may be wrong, the
 * fix may be poor, the shop may have moved — so the visit is RECORDED with the
 * mismatch beside it and a reason, rather than refused at the door or accepted
 * silently. Refusing it loses the visit; accepting it silently makes every
 * visit worth the same, which is worse.
 */
export const mbosVisits = pgTable(
  "mbos_visits",
  {
    ...mbosColumns(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    salesmanId: text("salesman_id")
      .notNull()
      .references(() => users.id),

    /* ---- where and when, both ends ---- */
    checkInLat: doublePrecision("check_in_lat"),
    checkInLng: doublePrecision("check_in_lng"),
    checkInAccuracyM: integer("check_in_accuracy_m"),
    checkInAt: timestamp("check_in_at", { withTimezone: true }),
    checkOutLat: doublePrecision("check_out_lat"),
    checkOutLng: doublePrecision("check_out_lng"),
    checkOutAccuracyM: integer("check_out_accuracy_m"),
    checkOutAt: timestamp("check_out_at", { withTimezone: true }),
    /**
     * Derived from the two timestamps and stored, because a visit synced
     * without its check-out — the salesman walked out of signal — still has a
     * duration the handset measured. Null means the visit never closed.
     */
    durationSeconds: integer("duration_seconds"),

    /* ---- what was captured. All three are `attachments` ids. ---- */
    shopPhotoId: text("shop_photo_id").references(() => attachments.id),
    custPhotoId: text("cust_photo_id").references(() => attachments.id),
    voiceNoteId: text("voice_note_id").references(() => attachments.id),
    /**
     * The voice note as text. `transcriptIsAi` says a machine wrote it, and it
     * is a separate column rather than a convention in the text because a
     * report that reaches a manager has to say whose words it is — the brief's
     * rule that AI-generated content affecting a customer record is tagged.
     */
    transcript: text("transcript"),
    transcriptIsAi: boolean("transcript_is_ai").notNull().default(false),

    outcome: mbosVisitOutcomeEnum("outcome").notNull().default("visited"),
    notes: text("notes"),

    /* ---- what the visit produced, in the tables that own those things ---- */
    linkedOrderId: text("linked_order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    linkedPaymentId: text("linked_payment_id").references(() => paymentReceipts.id, {
      onDelete: "set null",
    }),
    linkedComplaintId: text("linked_complaint_id").references(() => complaints.id, {
      onDelete: "set null",
    }),
    linkedSampleId: text("linked_sample_id").references(() => mbosSamples.id, {
      onDelete: "set null",
    }),
    nextFollowUpDate: date("next_follow_up_date"),

    /* ---- against the plan ---- */
    journeyPlanStopId: text("journey_plan_stop_id").references(() => mbosJourneyStops.id, {
      onDelete: "set null",
    }),
    wasPlanned: boolean("was_planned").notNull().default(false),
    /** Why an unplanned shop was visited. Asked for, not inferred. */
    deviationReason: text("deviation_reason"),

    /* ---- verification ---- */
    locationMismatch: boolean("location_mismatch").notNull().default(false),
    verified: boolean("verified").notNull().default(false),
    /** The sentence a manager reads: poor fix, no customer pin, too far. */
    unverifiedReason: text("unverified_reason"),
  },
  (t) => [
    index("mbos_visits_customer_idx").on(t.customerId, t.checkInAt.desc()),
    index("mbos_visits_salesman_idx").on(t.salesmanId, t.checkInAt.desc()),
    index("mbos_visits_unverified_idx").on(t.verified, t.checkInAt),
  ],
);

/* ----------------------------------------------------------------- leads */

/** §2.5 — where the prospect came from. Conversion is reported by this. */
export const mbosLeadSourceEnum = pgEnum("mbos_lead_source", [
  "manual",
  "website",
  "referral",
  "exhibition",
  "cold_call",
  "whatsapp",
  "campaign",
]);

/** The qualification ladder. `won` is the stage a conversion leaves behind. */
export const mbosLeadStageEnum = pgEnum("mbos_lead_stage", [
  "new",
  "contacted",
  "qualified",
  "negotiation",
  "won",
  "lost",
]);

/**
 * §2.5 — a prospect the field team is working.
 *
 * `customers.kind = 'lead'` already exists and is a different animal: it is a
 * party the sheet knows about that has never ordered. This is a lead somebody
 * MET, before there is any reason to put a row in the customer master at all —
 * a name and a mobile number from an exhibition is not a customer, and writing
 * one would put it on the collections list's outer joins and the queue's
 * prospect cadence on the strength of a business card.
 *
 * Conversion writes a customer and records its id here; the lead row stays, so
 * "where did this account come from" keeps its answer.
 */
export const mbosLeads = pgTable(
  "mbos_leads",
  {
    ...mbosColumns(),
    name: text("name").notNull(),
    companyName: text("company_name"),
    /** Mandatory in the form, and the duplicate check runs on it. */
    mobile: text("mobile"),
    city: text("city"),
    area: text("area"),
    source: mbosLeadSourceEnum("source").notNull().default("manual"),
    /** Paise. What the salesman thinks the account could be worth in a month. */
    estimatedPotentialPaise: bigint("estimated_potential_paise", { mode: "number" }),
    assignedToUserId: text("assigned_to_user_id").references(() => users.id),
    stage: mbosLeadStageEnum("stage").notNull().default("new"),
    nextFollowUpDate: date("next_follow_up_date"),
    notes: text("notes"),
    gpsLat: doublePrecision("gps_lat"),
    gpsLng: doublePrecision("gps_lng"),

    /** Set on conversion. The lead is not deleted — it is where the account began. */
    convertedCustomerId: text("converted_customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    /** Mandatory when the stage is `lost`: a loss nobody explained teaches nothing. */
    lostReason: text("lost_reason"),
    /**
     * A lead nobody has touched for the configured window archives itself. It
     * is a flag rather than a delete, because a cold lead is exactly who a
     * campaign goes back to next year.
     */
    archived: boolean("archived").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /**
     * Derived cache: the last day anything happened on this lead. It drives
     * the stale flag and the auto-archive, and it is rebuilt from activity
     * rather than typed.
     */
    lastActivityDate: date("last_activity_date"),
  },
  (t) => [
    index("mbos_leads_assigned_idx").on(t.assignedToUserId, t.stage),
    index("mbos_leads_mobile_idx").on(t.mobile),
    index("mbos_leads_stale_idx").on(t.archived, t.lastActivityDate),
  ],
);

/* -------------------------------------------------------------- expenses */

/** §2.9 — what the money went on. Caps are configured per category. */
export const mbosExpenseCategoryEnum = pgEnum("mbos_expense_category", [
  "travel",
  "food",
  "lodging",
  "other",
]);

/**
 * A bundle of expense lines submitted together. The claim is what a manager
 * approves; the lines are what it is made of.
 *
 * There is no `status` column, and that is deliberate — see `mbosApprovals`.
 */
export const mbosExpenseClaims = pgTable(
  "mbos_expense_claims",
  {
    ...mbosColumns(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    periodFrom: date("period_from"),
    periodTo: date("period_to"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** Derived cache: the sum of its lines, in paise. Rebuilt, never typed. */
    totalPaise: bigint("total_paise", { mode: "number" }).notNull().default(0),
    note: text("note"),
  },
  (t) => [index("mbos_expense_claims_user_idx").on(t.userId, t.submittedAt)],
);

/** §2.9 — one expense. Unclaimed lines roll into the next claim cycle. */
export const mbosExpenses = pgTable(
  "mbos_expenses",
  {
    ...mbosColumns(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expenseDate: date("expense_date").notNull(),
    category: mbosExpenseCategoryEnum("category").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    /** An `attachments` id. Mandatory above `mbos.expenses.billPhotoThresholdPaise`. */
    billPhotoId: text("bill_photo_id").references(() => attachments.id),
    remarks: text("remarks"),
    /** Null until it is bundled into a claim. */
    claimId: text("claim_id").references(() => mbosExpenseClaims.id, {
      onDelete: "set null",
    }),
    /** Set where the expense belongs to an outstation tour. */
    tourId: text("tour_id"),
  },
  (t) => [
    index("mbos_expenses_user_idx").on(t.userId, t.expenseDate),
    index("mbos_expenses_claim_idx").on(t.claimId),
  ],
);

/* ------------------------------------------------------------ attendance */

/** §2.10 — the day's verdict. Derived from the hours, and overridable by leave. */
export const mbosAttendanceStatusEnum = pgEnum("mbos_attendance_status", [
  "present",
  "half_day",
  "absent",
  "on_leave",
  "holiday",
]);

/**
 * §2.10 — the real attendance system.
 *
 * This is NOT the `attendance` table above, and the two must never be
 * confused. That one is a sign-in log with an unfortunate name: it says
 * somebody opened MahekOne, from home, on a phone, at 2am, and its
 * `signedOutAt` fills in only for the few who press Sign out — so no hours can
 * be derived from a pair of them, and AGENTS.md forbids any screen presenting
 * it as a record of who was at work.
 *
 * Attendance is a check-in system with its own screens and its own rules, and
 * this is it: a deliberate act, with a location, a selfie and a geofence
 * behind it. When the old table is finally renamed to what it is, nothing here
 * changes.
 *
 * `withinGeofence` is recorded rather than enforced. A salesman starting the
 * day at a customer's factory forty kilometres out is doing his job, and a
 * check-in refused at the door is a day's work with no record of it — so the
 * distance is stored, the flag is set, and a manager decides.
 */
export const mbosAttendanceDays = pgTable(
  "mbos_attendance_days",
  {
    ...mbosColumns(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The business day in Asia/Kolkata. One row per person per day. */
    day: date("day").notNull(),

    checkInAt: timestamp("check_in_at", { withTimezone: true }),
    checkInLat: doublePrecision("check_in_lat"),
    checkInLng: doublePrecision("check_in_lng"),
    checkInAccuracyM: integer("check_in_accuracy_m"),
    /** An `attachments` id — the selfie the check-in captured. */
    checkInSelfieId: text("check_in_selfie_id").references(() => attachments.id),
    checkInAddress: text("check_in_address"),

    checkOutAt: timestamp("check_out_at", { withTimezone: true }),
    checkOutLat: doublePrecision("check_out_lat"),
    checkOutLng: doublePrecision("check_out_lng"),
    checkOutAccuracyM: integer("check_out_accuracy_m"),
    checkOutAddress: text("check_out_address"),
    /** True where the day closed itself because nobody checked out. */
    autoCheckedOut: boolean("auto_checked_out").notNull().default(false),

    /** Derived cache: seconds between the two marks. Rebuilt, never typed. */
    workedSeconds: integer("worked_seconds"),
    /** Derived from the hours and the half-day threshold, or set by leave. */
    status: mbosAttendanceStatusEnum("status").notNull().default("absent"),

    withinGeofence: boolean("within_geofence"),
    /** Metres from the designated start location, where one is defined. */
    geofenceDistanceM: integer("geofence_distance_m"),

    /** A correction the employee asked for. The decision lives in `mbos_approvals`. */
    regularisationRequested: boolean("regularisation_requested").notNull().default(false),
    regularisationReason: text("regularisation_reason"),
  },
  (t) => [
    uniqueIndex("mbos_attendance_days_user_day_key").on(t.userId, t.day),
    index("mbos_attendance_days_day_idx").on(t.day),
  ],
);

/* ----------------------------------------------------------------- leave */

export const mbosLeaveTypeEnum = pgEnum("mbos_leave_type", [
  "casual",
  "sick",
  "earned",
  "loss_of_pay",
]);

/**
 * §2.11 — a leave request. Whether it was granted is `mbos_approvals`; what is
 * here is what was asked for, and a withdrawal, which is not an approval
 * decision and so has its own two columns.
 */
export const mbosLeaveRequests = pgTable(
  "mbos_leave_requests",
  {
    ...mbosColumns(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    leaveType: mbosLeaveTypeEnum("leave_type").notNull(),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    /** A single day taken as a half. Whole days otherwise. */
    halfDay: boolean("half_day").notNull().default(false),
    /** Derived from the dates and the working calendar. Rebuilt, never typed. */
    days: integer("days").notNull().default(0),
    reason: text("reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
  },
  (t) => [
    index("mbos_leave_requests_user_idx").on(t.userId, t.fromDate),
    index("mbos_leave_requests_window_idx").on(t.fromDate, t.toDate),
  ],
);

/**
 * §2.11 — entitlement and consumption, per person per year per type.
 *
 * `usedDays` is a derived cache rebuilt from approved requests; the balance is
 * the subtraction and is not stored at all, because a stored balance is a
 * number two writers can disagree about.
 */
export const mbosLeaveBalances = pgTable(
  "mbos_leave_balances",
  {
    ...mbosColumns(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    leaveType: mbosLeaveTypeEnum("leave_type").notNull(),
    entitledDays: integer("entitled_days").notNull().default(0),
    usedDays: integer("used_days").notNull().default(0),
  },
  (t) => [
    uniqueIndex("mbos_leave_balances_key").on(t.userId, t.year, t.leaveType),
  ],
);

/* ----------------------------------------------------------------- tours */

/** §2.11 — a multi-day outstation tour, distinct from a daily journey plan. */
/**
 * Which regions a sales manager covers.
 *
 * **No rows means national.** That is the load-bearing part: it is what let
 * this ship without changing the meaning of a single existing grant, and it is
 * the same rule `app_module_access` uses for modules — a permission model that
 * silently narrows what people already hold is one nobody can deploy.
 *
 * `region` is text matching `customers.territory_region`, not a foreign key: a
 * region is whatever the customer master says it is, and a second list would
 * offer the console regions the book does not use.
 */
export const mbosManagerTerritories = pgTable(
  "mbos_manager_territories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    region: text("region").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
  },
  (t) => [uniqueIndex("mbos_manager_territories_key").on(t.userId, t.region)],
);

/**
 * §2.11 — the days nobody is expected to work.
 *
 * `scope` is free text and not a foreign key to a beat, because a holiday is
 * regional in a way the territory model cannot express: "Nagpur East and
 * Nagpur West" is two beats, "all beats" is every beat there will ever be, and
 * a join table would need maintaining every time a beat is renamed. Null means
 * everywhere.
 */
export const mbosHolidays = pgTable(
  "mbos_holidays",
  {
    id: text("id").primaryKey(),
    onDate: date("on_date").notNull(),
    name: text("name").notNull(),
    scope: text("scope"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedById: text("updated_by_id"),
  },
  (t) => [index("mbos_holidays_date_idx").on(t.onDate)],
);

export const mbosTours = pgTable(
  "mbos_tours",
  {
    ...mbosColumns(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    /** The cities as typed, in order. A list, because a tour is a route. */
    cities: jsonb("cities").$type<string[]>().notNull().default([]),
    purpose: text("purpose"),
    /** Paise. What it was expected to cost when it was asked for. */
    estimatedCostPaise: bigint("estimated_cost_paise", { mode: "number" }),
    notes: text("notes"),
  },
  (t) => [index("mbos_tours_user_idx").on(t.userId, t.startDate)],
);

/* ----------------------------------------------------------------- tasks */

export const mbosTaskPriorityEnum = pgEnum("mbos_task_priority", [
  "low",
  "medium",
  "high",
]);

export const mbosTaskStatusEnum = pgEnum("mbos_task_status", [
  "open",
  "in_progress",
  "done",
  "cancelled",
]);

/**
 * §2.11 — an action item with somebody's name and a date on it.
 *
 * `sourceType`/`sourceId` are how the system assigns itself work: a rejected
 * order raises a task against that customer (PROTOCOL.md §6), because the
 * salesman stood in the shop and said the order was placed, and a notification
 * can be missed where a task on the list cannot.
 */
export const mbosTasks = pgTable(
  "mbos_tasks",
  {
    ...mbosColumns(),
    title: text("title").notNull(),
    description: text("description"),
    assignedToUserId: text("assigned_to_user_id")
      .notNull()
      .references(() => users.id),
    assignedByUserId: text("assigned_by_user_id").references(() => users.id),
    priority: mbosTaskPriorityEnum("priority").notNull().default("medium"),
    dueDate: date("due_date"),
    customerId: text("customer_id").references(() => customers.id, {
      onDelete: "cascade",
    }),
    status: mbosTaskStatusEnum("status").notNull().default("open"),
    completionNote: text("completion_note"),
    /** An `attachments` id — proof, where the manager flagged it mandatory. */
    completionPhotoId: text("completion_photo_id").references(() => attachments.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    snoozedTo: date("snoozed_to"),
    snoozeReason: text("snooze_reason"),
    /** Set when an overdue task was escalated to a manager. Written once. */
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    /** Where the system raised it itself: `rejected_order`, `sample`, `visit`. */
    sourceType: text("source_type"),
    sourceId: text("source_id"),
  },
  (t) => [
    index("mbos_tasks_assignee_idx").on(t.assignedToUserId, t.status, t.dueDate),
    index("mbos_tasks_customer_idx").on(t.customerId),
    index("mbos_tasks_overdue_idx").on(t.status, t.dueDate),
  ],
);

/* ---------------------------------------------------- competitor records */

/**
 * §2.11 — what the competition is doing in this shop, as the shopkeeper says
 * it. Captured on a visit, which is why it links to one.
 */
export const mbosCompetitorRecords = pgTable(
  "mbos_competitor_records",
  {
    ...mbosColumns(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    visitId: text("visit_id").references(() => mbosVisits.id, { onDelete: "set null" }),
    competitorName: text("competitor_name").notNull(),
    productName: text("product_name"),
    /** Paise. Their rate as quoted to this customer, not a list price. */
    pricePaise: bigint("price_paise", { mode: "number" }),
    creditDays: integer("credit_days"),
    deliveryNote: text("delivery_note"),
    strengths: text("strengths"),
    weaknesses: text("weaknesses"),
    recordedOn: date("recorded_on"),
  },
  (t) => [index("mbos_competitor_records_customer_idx").on(t.customerId, t.recordedOn)],
);

/* -------------------------------------------------------- internal notes */

/**
 * §2.11 — a note about a customer that the customer must never see, and that a
 * Field Sales Executive is never sent either.
 *
 * The visibility is enforced by the bootstrap payload, not only by a screen:
 * a note that could leak is not on the device to leak (PROTOCOL.md §9).
 * `visibleToRoles` is the list of MahekOne roles allowed to read it.
 */
export const mbosInternalNotes = pgTable(
  "mbos_internal_notes",
  {
    ...mbosColumns(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    visibleToRoles: jsonb("visible_to_roles").$type<string[]>().notNull().default([]),
    /** Removal is a status. A note somebody wrote is a fact about the account. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedById: text("removed_by_id"),
  },
  (t) => [index("mbos_internal_notes_customer_idx").on(t.customerId)],
);

/* ------------------------------------------------------------- documents */

export const mbosDocumentCategoryEnum = pgEnum("mbos_document_category", [
  "price_list",
  "catalogue",
  "agreement",
  "kyc",
  "policy",
  "marketing",
]);

/** §2.11 — the document library. The bytes are an `attachments` row. */
export const mbosDocuments = pgTable(
  "mbos_documents",
  {
    ...mbosColumns(),
    title: text("title").notNull(),
    category: mbosDocumentCategoryEnum("category").notNull(),
    attachmentId: text("attachment_id").references(() => attachments.id),
    /** Set where the document belongs to one customer — a KYC file, an agreement. */
    customerId: text("customer_id").references(() => customers.id, {
      onDelete: "cascade",
    }),
    visibleToRoles: jsonb("visible_to_roles").$type<string[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    index("mbos_documents_category_idx").on(t.category, t.active),
    index("mbos_documents_customer_idx").on(t.customerId),
  ],
);

/* --------------------------------------------------------------- courses */

/** §2.11 — the knowledge centre: a training module and who has finished it. */
export const mbosCourses = pgTable(
  "mbos_courses",
  {
    ...mbosColumns(),
    title: text("title").notNull(),
    category: text("category"),
    durationMinutes: integer("duration_minutes"),
    /** The material itself, where it is a file we hold. */
    attachmentId: text("attachment_id").references(() => attachments.id),
    /** Percentage a quiz must reach to count as passed. */
    passMarkPercent: integer("pass_mark_percent"),
    mandatory: boolean("mandatory").notNull().default(false),
    /** Only meaningful where `mandatory` — the deadline it must be done by. */
    dueDate: date("due_date"),
    active: boolean("active").notNull().default(true),
  },
  (t) => [index("mbos_courses_active_idx").on(t.active, t.mandatory)],
);

export const mbosCourseProgress = pgTable(
  "mbos_course_progress",
  {
    ...mbosColumns(),
    courseId: text("course_id")
      .notNull()
      .references(() => mbosCourses.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    quizScorePercent: integer("quiz_score_percent"),
    passed: boolean("passed").notNull().default(false),
    /** The certificate's own reference, once one has been issued. */
    certificateRef: text("certificate_ref"),
  },
  (t) => [
    uniqueIndex("mbos_course_progress_key").on(t.courseId, t.userId),
    index("mbos_course_progress_user_idx").on(t.userId),
  ],
);

/* ------------------------------------------------------------- approvals */

/**
 * §5 — the six things somebody has to say yes to. One vocabulary, because the
 * approval hierarchy is one hierarchy and a second list of kinds would drift
 * from it.
 */
export const mbosApprovalTypeEnum = pgEnum("mbos_approval_type", [
  "order",
  "expense_claim",
  "leave",
  "tour",
  "sample",
  "attendance_regularisation",
]);

export const mbosApprovalStateEnum = pgEnum("mbos_approval_state", [
  "pending",
  "approved",
  "rejected",
  /** An expense claim approved for less than it asked for. */
  "partially_approved",
]);

/**
 * §5 — ONE table for every approval in MBOS.
 *
 * Six kinds of thing get approved and the questions asked of them are
 * identical: who asked, what for, who decided, when, what did they say, and
 * how much did they allow. Six status columns on six tables would be six
 * places for "pending" to mean something slightly different, and the sixth
 * would be forgotten when the escalation rule changed.
 *
 * **The subject's state is DERIVED from this table and never set beside it.**
 * That is why `mbos_expense_claims`, `mbos_leave_requests` and `mbos_tours`
 * carry no status column: a claim is approved because there is an approved row
 * here naming it, not because somebody wrote `approved` on the claim as well.
 * Two copies of one decision is how a screen ends up showing a rejection
 * beside a payment.
 *
 * `approvedAmountPaise` is what makes `partially_approved` mean anything: a
 * claim for ₹4,200 allowed at ₹3,000 is a decision with a number in it, and
 * without the number the state is a shrug.
 */
export const mbosApprovals = pgTable(
  "mbos_approvals",
  {
    ...mbosColumns(),
    type: mbosApprovalTypeEnum("type").notNull(),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => users.id),
    /** The table the subject lives in: `mbos_expense_claims`, `orders`, … */
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    reason: text("reason"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    approverUserId: text("approver_user_id").references(() => users.id),
    state: mbosApprovalStateEnum("state").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Mandatory on a rejection — somebody has to be told something. */
    decisionNote: text("decision_note"),
    approvedAmountPaise: bigint("approved_amount_paise", { mode: "number" }),
  },
  (t) => [
    /** The approver's queue, and the only hot query on this table. */
    index("mbos_approvals_pending_idx").on(t.state, t.requestedAt),
    index("mbos_approvals_subject_idx").on(t.subjectType, t.subjectId),
    index("mbos_approvals_requester_idx").on(t.requestedByUserId, t.state),
  ],
);

/* ------------------------------------------------------- the sync ledger */

/**
 * The idempotency ledger — PROTOCOL.md §4. This table is what makes a retry
 * safe, and a retry is most of them: a handset on 2G in a market sends a
 * payment, never sees the response, and sends it again.
 *
 * The key is `<entityId>:<op>:<payloadHash>`. A replayed key returns the
 * result stored here and writes NOTHING — which is why `resultJson` holds the
 * whole original response rather than a status: the second caller has to
 * receive exactly what the first one did, including the server number the
 * record was given.
 */
export const mbosSyncReceipts = pgTable(
  "mbos_sync_receipts",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    deviceId: text("device_id"),
    userId: text("user_id").references(() => users.id),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    /** The response as it was sent the first time. Replayed verbatim. */
    resultJson: jsonb("result_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mbos_sync_receipts_key").on(t.idempotencyKey),
    index("mbos_sync_receipts_entity_idx").on(t.entityType, t.entityId),
  ],
);

/**
 * §2.11 — the conflict log. A mutable record edited on two devices.
 *
 * Append-only entities cannot conflict: a visit, an order or a payment created
 * twice is two records (PROTOCOL.md §7). Only edits to the same mutable row —
 * customer details, task state, lead stage — can, and they resolve by
 * server-received time, never by device time, because a handset's clock is
 * wrong and its owner can set it.
 *
 * Both versions are kept. The losing edit is a thing somebody typed, and
 * discarding it silently is how a manager finds out months later that the
 * correction they made never took.
 */
export const mbosConflicts = pgTable(
  "mbos_conflicts",
  {
    ...mbosColumns(),
    /** The record that conflicted, in whichever table owns it. */
    recordId: text("record_id").notNull(),
    entityType: text("entity_type").notNull(),
    /** What the handset held, whole. Kept even when it lost. */
    localVersion: jsonb("local_version"),
    serverVersion: jsonb("server_version"),
    /** `server_wins`, `client_wins`, `manual` — which way it went, and why. */
    resolution: text("resolution"),
    flaggedForReview: boolean("flagged_for_review").notNull().default(false),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [
    index("mbos_conflicts_record_idx").on(t.entityType, t.recordId),
    index("mbos_conflicts_review_idx").on(t.flaggedForReview, t.serverCreatedAt),
  ],
);

/* ------------------------------------------------------ prices and schemes */

/**
 * Brief §11 decision 1 — the customer price list, keyed on the PRICE TAG
 * rather than on the customer.
 *
 * The Sales Party tab already carries a `tagPricelist` per party and prices
 * vary by what the account is, not by which account it is: every dealer on the
 * "DEALER" tag gets the dealer rate. Keying on the customer would mean 1,191
 * rows per product and a new one every time a party is added.
 *
 * A row here does NOT on its own make an order valuable. `products.priceSource`
 * is still `unset` and `canValueOrders()` still decides — the check exists
 * because a half-populated price list is worse than none, and switching the
 * source to `pricelist` has to be somebody's deliberate act.
 */
export const mbosPriceList = pgTable(
  "mbos_price_list",
  {
    ...mbosColumns(),
    /** Matches `sheet_party_rows.tagPricelist` — "DEALER", "DISTRIBUTOR", … */
    customerPriceTag: text("customer_price_tag").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Paise, per CAN — the unit an order line is counted in. */
    ratePaise: bigint("rate_paise", { mode: "number" }).notNull(),
    validFrom: date("valid_from"),
    /** Null means open-ended. A superseded rate is dated out, never deleted. */
    validTo: date("valid_to"),
  },
  (t) => [
    index("mbos_price_list_lookup_idx").on(t.customerPriceTag, t.productId, t.validFrom),
    index("mbos_price_list_product_idx").on(t.productId),
  ],
);

/**
 * Brief §4.7 — promotional schemes.
 *
 * Eligibility and benefit are DATA, not code. "Buy 10 cans of X, get 1 free"
 * and "5% off above ₹50,000 for distributors in Nagpur" are the same shape of
 * thing, and expressing them as a rule engine's input is what lets a manager
 * add one in October without a deploy — the same reason quick notes and
 * thresholds are configuration. A scheme hardcoded in the order form is a
 * scheme that outlives the festival it was written for.
 */
export const mbosSchemes = pgTable(
  "mbos_schemes",
  {
    ...mbosColumns(),
    name: text("name").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    /** Who and what it applies to: products, tags, areas, minimum quantities. */
    eligibility: jsonb("eligibility").notNull().default({}),
    /** What they get: free quantity, a discount, a slab. */
    benefit: jsonb("benefit").notNull().default({}),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
  },
  (t) => [index("mbos_schemes_active_idx").on(t.active, t.validFrom)],
);

/* ------------------------------------------------------------- tombstones */

/**
 * What went away.
 *
 * A pull tells a handset what exists; nothing tells it what stopped existing.
 * A stop the office removed from tomorrow's route, a document withdrawn, a
 * customer reassigned out of somebody's book — all of them simply stay on the
 * phone for ever, because a deleted row has no `updated_at` for a delta to
 * notice. The salesman walks to a shop that is not his any more and nothing
 * anywhere looks wrong.
 *
 * A delete leaves no row to sync, so it leaves this instead.
 *
 * `userId` narrows it: a deletion is only worth sending to the handset that
 * holds the thing. Null means everybody — a product withdrawn from the
 * catalogue is gone for the whole team.
 */
export const mbosDeletions = pgTable(
  "mbos_deletions",
  {
    id: text("id").primaryKey(),
    /** The handset's OWN table name, because a pull row is a local row. */
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    userId: text("user_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
  },
  (t) => [
    index("mbos_deletions_at_idx").on(t.at),
    index("mbos_deletions_user_idx").on(t.userId, t.at),
  ],
);

/* -------------------------------------------------------------- positions */

/**
 * Where somebody actually went.
 *
 * MBOS stored a coordinate on the check-in and one on each visit and nothing
 * else, so "the live map" could only ever be a handful of fixes a day — a map
 * drawn from them looks like tracking without being it, which is worse than a
 * screen that says it has nothing.
 *
 * This is the stream. The handset posts a position while it is checked in and
 * stops when the day is closed, which is the same rule the salesman was told
 * when he agreed to it: tracking runs while you are working and not otherwise.
 *
 * It is deliberately thin. No address, no speed, no battery — a position is a
 * lat, a lng, how sure the phone was, and when. Anything more is another thing
 * to justify holding about somebody's day.
 */
export const mbosPositions = pgTable(
  "mbos_positions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The handset's clock. A track is a shape, and a shape needs its own order. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    accuracyM: integer("accuracy_m"),
    deviceId: text("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mbos_positions_user_at_idx").on(t.userId, t.at)],
);

/* ----------------------------------------------------- activity locations */

/**
 * Where each thing was done.
 *
 * Four tables carried a coordinate — visits, leads, attendance and the trail —
 * and the other twenty-three did not, so an order taken at a shop, a payment
 * collected at a counter and a complaint raised in a godown were all recorded
 * with no idea where they happened.
 *
 * **One table rather than a lat/lng pair on each.** "Where was this done" is
 * one question with one answer shape, and answering it in twelve places is
 * answering it in eleven and forgetting the twelfth. It also means the
 * thirteenth kind of activity costs nothing to cover, and retention has one
 * place to reach.
 *
 * **A row can say there was NO fix.** Coordinates null with a `reason` is the
 * record that we asked and could not get one — indoors in a concrete godown,
 * or permission refused. No row at all means nothing was asked. Those are
 * different facts, and a screen that could not tell them apart would say "no
 * location" for both.
 *
 * **Age is part of the reading, exactly as accuracy is.** Almost every fix
 * here is one the day's trail had already taken, which is what makes this cost
 * no battery and add no delay to a save — and it is also why a reader has to
 * be told how old it was. Four minutes is evidence; four hours is not.
 */
export const mbosActivityLocations = pgTable(
  "mbos_activity_locations",
  {
    id: text("id").primaryKey(),
    /** The handset's own entity type — `order`, `payment`, `sample`, … */
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    /** Part of the reading, never a filter. A 500 m fix is not a doorway. */
    accuracyM: integer("accuracy_m"),
    /** When the FIX was taken, by the handset's clock. */
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    /** How old that fix was when the activity was recorded. */
    ageSeconds: integer("age_seconds"),
    /** `fresh` — taken for this act. `trail` — one the day's tracking had. */
    source: text("source"),
    /** Only where there are no coordinates: denied, unavailable, off. */
    reason: text("reason"),
    deviceId: text("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /* One location per activity, so a retried sync writes the same row rather
       than a second one — idempotent without having to ask. */
    uniqueIndex("mbos_activity_locations_entity_key").on(t.entityType, t.entityId),
    index("mbos_activity_locations_user_idx").on(t.userId, t.capturedAt),
  ],
);

/* ------------------------------------------- §3.30 salesman targets & score */

/*
 * A person is measured on six things, and this is where the six are asked for
 * and where the answers are kept.
 *
 * The table next door, `monthly_targets`, is a target per CUSTOMER: what one
 * account is expected to buy. These are targets per PERSON. They are not two
 * spellings of one idea and neither is derived from the other — a customer
 * target is a forecast about an account, and a person target is what somebody
 * is appraised against, including on things no customer target mentions:
 * litres, product mix, new names, collected money and visits made.
 */

/**
 * `draft` is a target being worked out; `published` is one the person can see.
 *
 * The split exists because a manager builds thirty of these in an afternoon,
 * and a salesman watching his number change four times before lunch stops
 * believing any of them. Nothing reaches a handset until it is published.
 */
export const salesTargetStatusEnum = pgEnum("sales_target_status", [
  "draft",
  "published",
]);

export const salesTargets = pgTable(
  "sales_targets",
  {
    id: text("id").primaryKey(),
    /**
     * WHO carries it.
     *
     * A `users` row rather than an employee, because a target has to be
     * readable by the person it is set for, and reading it means signing in.
     * It is deliberately not restricted to field salesmen: an account with no
     * salesman is worked by the back office, so a telecaller carries the
     * targets of every such customer and has to be able to hold one.
     */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `YYYY-MM`, the same key `monthKey()` produces. */
    period: text("period").notNull(),

    /* ---- the six asks. Null means not asked, which is NOT the same as zero.
       An unset component is dropped from the score and its weight shared out;
       a zero would be a target nobody can fail, scored at infinity. ---- */
    revenueTargetPaise: bigint("revenue_target_paise", { mode: "number" }),
    /**
     * Millilitres, like the catalogue, and litres only on the way to a screen.
     * A drum is 210 litres and a can is 0.5, so litres cannot be an integer
     * and a float target is a target that fails an equality check.
     */
    volumeTargetMl: bigint("volume_target_ml", { mode: "number" }),
    newCustomerTarget: integer("new_customer_target"),
    /**
     * Basis points of what was ALREADY overdue at the start of the month, not
     * a rupee figure — collection is measured against debt that already
     * existed, never against money that only became due during the month.
     * `collection_target_paise` is the retired column: a target set before
     * this shipped is not reinterpreted, it simply stops scoring anything,
     * the same way any other unset component does.
     */
    collectionTargetBp: integer("collection_target_bp"),
    activityTarget: integer("activity_target"),

    status: salesTargetStatusEnum("status").notNull().default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedById: text("published_by_id").references(() => users.id),
    notes: text("notes"),
    /**
     * Copied forward from last month's PUBLISHED target rather than typed by
     * anybody this month. `copyForwardSalesTargets` sets it true on the row it
     * creates, and any real save — a manager changing even one figure — clears
     * it, because a target somebody has now looked at and decided on is no
     * longer a carry-over of the old decision. It is what lets the screen say
     * "still last month's number" rather than presenting a continued target as
     * a fresh one somebody chose this month.
     */
    carriedForward: boolean("carried_forward").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdById: text("created_by_id"),
    updatedById: text("updated_by_id"),
  },
  (t) => [
    uniqueIndex("sales_targets_key").on(t.userId, t.period),
    index("sales_targets_period_idx").on(t.period, t.status),
  ],
);

/**
 * The mix bands, one row per category per target.
 *
 * Three numbers rather than one, because §5 of the brief is explicit that not
 * every salesman can be held to exactly 30% Universal — a territory selling
 * into furniture and one selling into automotive are different books. Minimum
 * is what is not acceptable below, target is the ask, stretch is exceptional.
 */
export const salesTargetCategories = pgTable(
  "sales_target_categories",
  {
    id: text("id").primaryKey(),
    targetId: text("target_id")
      .notNull()
      .references(() => salesTargets.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => productCategories.id),
    /** Basis points of total value. 3000 is 30%. */
    minimumBp: integer("minimum_bp").notNull().default(0),
    targetBp: integer("target_bp").notNull().default(0),
    stretchBp: integer("stretch_bp").notNull().default(0),
  },
  (t) => [
    uniqueIndex("sales_target_categories_key").on(t.targetId, t.categoryId),
    /* A band that does not increase would score a larger share lower than a
       smaller one — invisible until somebody is marked down for selling more
       of exactly what they were asked to sell. */
    check(
      "sales_target_categories_band_order",
      sql`minimum_bp <= target_bp and target_bp <= stretch_bp`,
    ),
  ],
);

/**
 * Every change to a published target, and why.
 *
 * §20 of the brief, and the reason it is a table rather than a line in
 * `audit_log`: the question somebody asks in March is "which targets moved for
 * the price revision", and an audit log can only answer that by grep. The
 * reason is a code from `performance.revisionReasons`, so it can be counted.
 *
 * A DRAFT is not revised, it is edited — nothing has been promised to anybody
 * yet, and logging every keystroke of target-setting would bury the four
 * changes that actually matter.
 */
export const salesTargetRevisions = pgTable(
  "sales_target_revisions",
  {
    id: text("id").primaryKey(),
    targetId: text("target_id")
      .notNull()
      .references(() => salesTargets.id, { onDelete: "cascade" }),
    /** `revenue`, `volume`, `mix:universal`, … — what moved. */
    field: text("field").notNull(),
    /** Rendered, not raw: "₹13,00,000" reads back in a year, "130000000" does not. */
    oldValue: text("old_value"),
    newValue: text("new_value"),
    reason: text("reason").notNull(),
    reasonNote: text("reason_note"),
    changedById: text("changed_by_id").references(() => users.id),
    /**
     * Stored ON the row beside the id, like `customer_am_changes` — a history
     * has to stay readable after the person leaves and their account goes.
     */
    changedByName: text("changed_by_name"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sales_target_revisions_target_idx").on(t.targetId, t.changedAt)],
);

/**
 * The score, as a CACHE.
 *
 * Same rule as every other derived value here: never hand-edited, rebuilt by
 * `recomputeSalesPerformance()` in `lib/recompute.ts`. It exists because the
 * manager dashboard asks this question for thirty people at once and the
 * handset asks it on a 2G connection — computing six components and a mix over
 * a month of order lines on every read would make both unusable.
 *
 * It is NOT the same kind of column as `calls.next_step_*`, which record what
 * somebody was told on a day and must never be rebuilt. This is a reading of
 * the present, and a rebuild is a correction rather than a destruction.
 */
export const salesPerformance = pgTable(
  "sales_performance",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    period: text("period").notNull(),
    targetId: text("target_id").references(() => salesTargets.id, {
      onDelete: "set null",
    }),

    revenueTargetPaise: bigint("revenue_target_paise", { mode: "number" }),
    revenueActualPaise: bigint("revenue_actual_paise", { mode: "number" }).notNull().default(0),
    revenueAchievementBp: integer("revenue_achievement_bp"),

    volumeTargetMl: bigint("volume_target_ml", { mode: "number" }),
    volumeActualMl: bigint("volume_actual_ml", { mode: "number" }).notNull().default(0),
    volumeAchievementBp: integer("volume_achievement_bp"),

    mixAchievementBp: integer("mix_achievement_bp"),

    newCustomerTarget: integer("new_customer_target"),
    newCustomerActual: integer("new_customer_actual").notNull().default(0),
    newCustomerAchievementBp: integer("new_customer_achievement_bp"),

    collectionTargetPaise: bigint("collection_target_paise", { mode: "number" }),
    collectionActualPaise: bigint("collection_actual_paise", { mode: "number" }).notNull().default(0),
    collectionAchievementBp: integer("collection_achievement_bp"),

    activityTarget: integer("activity_target"),
    activityActual: integer("activity_actual").notNull().default(0),
    activityAchievementBp: integer("activity_achievement_bp"),

    /** Out of 100, in basis points. 9140 is 91.40. */
    totalScoreBp: integer("total_score_bp").notNull().default(0),
    rating: text("rating"),
    /** Components nobody set a target for, whose weight was shared out. */
    untargeted: jsonb("untargeted").$type<string[]>(),

    /**
     * How much of the revenue could NOT be resolved to a catalogue SKU.
     *
     * Order lines carry a product NAME, and four of the sheet's names match
     * nothing. Those lines are real money and count towards revenue in full;
     * what they cannot do is contribute litres or a mix category. Carrying the
     * figure means the screen can say "the mix is computed over 94% of the
     * value" instead of presenting a share that is quietly wrong.
     */
    unmatchedRevenuePaise: bigint("unmatched_revenue_paise", { mode: "number" })
      .notNull()
      .default(0),

    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sales_performance_key").on(t.userId, t.period),
    index("sales_performance_period_idx").on(t.period),
  ],
);

export const salesPerformanceCategories = pgTable(
  "sales_performance_categories",
  {
    id: text("id").primaryKey(),
    performanceId: text("performance_id")
      .notNull()
      .references(() => salesPerformance.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => productCategories.id),
    targetBp: integer("target_bp").notNull().default(0),
    minimumBp: integer("minimum_bp").notNull().default(0),
    stretchBp: integer("stretch_bp").notNull().default(0),
    actualPaise: bigint("actual_paise", { mode: "number" }).notNull().default(0),
    /** Shown beside the share, never scored — see the unmatched note above. */
    actualMl: bigint("actual_ml", { mode: "number" }).notNull().default(0),
    actualBp: integer("actual_bp").notNull().default(0),
    /** `below-minimum` | `below-target` | `on-target` | `stretch` */
    status: text("status").notNull(),
    scoreBp: integer("score_bp").notNull().default(0),
  },
  (t) => [
    uniqueIndex("sales_performance_categories_key").on(t.performanceId, t.categoryId),
  ],
);

/* ------------------------------------------- §3.31 customer health history */

/**
 * Where each customer stood at the end of a month.
 *
 * The one thing the owner dashboard cannot derive. Every other figure on it is
 * a read of the present or a sum over a window, but "how many customers came
 * BACK" is a comparison between two readings, and the earlier reading is gone
 * the moment it stops being true. A book with 145 at risk in both months looks
 * stable and may be 145 different people, half recovered and half newly
 * slipping — the counts cannot tell those apart and this can.
 *
 * WRITTEN NIGHTLY, over the CURRENT month's row. That is what makes a closed
 * month correct for free: it stops being overwritten on the last night of the
 * month, so the row is the band as it stood at month end, and no separate
 * month-end job has to fire on the right day to be right.
 *
 * It is a snapshot rather than a cache: a cache is rebuilt when the answer
 * changes, and rebuilding this would destroy the very thing it is for. Nothing
 * recomputes a past month, and nothing may learn to — the same rule the
 * `calls.next_step_*` columns follow. It also cannot be backfilled: before the
 * first night this ran there is no reading to compare against, and the screen
 * says so rather than showing a movement of zero.
 */
export const customerHealthSnapshots = pgTable(
  "customer_health_snapshots",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** `YYYY-MM`, the same key everything else in this schema uses. */
    period: text("period").notNull(),
    /** `active` | `at-risk` | `dormant` | `lost` — see `engines/inactivity.ts`. */
    band: text("band").notNull(),
    /**
     * The cycle the band was measured against, kept ON the row.
     *
     * A customer's cycle moves as they order, so a snapshot that stored only
     * the band could never be explained afterwards — "why was this account
     * dormant in March" has no answer once the cycle it was judged against has
     * changed underneath it.
     */
    cycleDays: integer("cycle_days"),
    /** Hundredths of a cycle: 250 is 2.5 cycles elapsed. Integers, like money. */
    cyclesElapsedBp: integer("cycles_elapsed_bp"),
    daysOverdue: integer("days_overdue"),
    lastOrderDate: date("last_order_date"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("customer_health_snapshots_key").on(t.customerId, t.period),
    index("customer_health_snapshots_period_idx").on(t.period, t.band),
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

export const appModuleAccessRelations = relations(appModuleAccess, ({ one }) => ({
  user: one(users, { fields: [appModuleAccess.userId], references: [users.id] }),
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
export type AppModuleAccess = typeof appModuleAccess.$inferSelect;
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

/* ------------------------------------------------------------- MBOS types */

export type TimelineEvent = typeof timelineEvents.$inferSelect;
export type MbosDevice = typeof mbosDevices.$inferSelect;
export type MbosJourneyPlan = typeof mbosJourneyPlans.$inferSelect;
export type MbosJourneyStop = typeof mbosJourneyStops.$inferSelect;
export type MbosSample = typeof mbosSamples.$inferSelect;
export type MbosVisit = typeof mbosVisits.$inferSelect;
export type MbosLead = typeof mbosLeads.$inferSelect;
export type MbosExpense = typeof mbosExpenses.$inferSelect;
export type MbosExpenseClaim = typeof mbosExpenseClaims.$inferSelect;
export type MbosAttendanceDay = typeof mbosAttendanceDays.$inferSelect;
export type MbosLeaveRequest = typeof mbosLeaveRequests.$inferSelect;
export type MbosLeaveBalance = typeof mbosLeaveBalances.$inferSelect;
export type MbosTour = typeof mbosTours.$inferSelect;
export type MbosTask = typeof mbosTasks.$inferSelect;
export type MbosCompetitorRecord = typeof mbosCompetitorRecords.$inferSelect;
export type MbosInternalNote = typeof mbosInternalNotes.$inferSelect;
export type MbosDocument = typeof mbosDocuments.$inferSelect;
export type MbosCourse = typeof mbosCourses.$inferSelect;
export type MbosCourseProgress = typeof mbosCourseProgress.$inferSelect;
export type MbosApproval = typeof mbosApprovals.$inferSelect;
export type MbosSyncReceipt = typeof mbosSyncReceipts.$inferSelect;
export type MbosConflict = typeof mbosConflicts.$inferSelect;
export type MbosPriceListEntry = typeof mbosPriceList.$inferSelect;
export type MbosScheme = typeof mbosSchemes.$inferSelect;
