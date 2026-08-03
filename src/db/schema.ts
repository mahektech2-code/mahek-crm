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
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/* ---------------------------------------------------------------------------
 * MahekOne — shared schema.
 *
 * Every app in the suite reads and writes these tables. The CRM is the first
 * consumer; dispatch, inventory and accounts will join later. Nothing here is
 * CRM-private, so nothing has to be duplicated or synced later on.
 *
 * Money is stored in paise (integer) so nothing rounds badly. Format at the
 * edge with lib/format.ts, never in the database.
 * ------------------------------------------------------------------------- */

export const roleEnum = pgEnum("role", ["telecaller", "manager", "admin"]);
export const customerStatusEnum = pgEnum("customer_status", [
  "Active",
  "Slow payer",
  "Inactive",
  "New",
]);
export const channelEnum = pgEnum("channel", ["Call", "WhatsApp", "Visit"]);
export const connectionEnum = pgEnum("connection", [
  "Connected",
  "Missed",
  "Not reachable",
  "Busy",
  "Wrong number",
]);
export const reminderStatusEnum = pgEnum("reminder_status", [
  "open",
  "done",
  "cancelled",
]);
export const complaintStatusEnum = pgEnum("complaint_status", [
  "Open",
  "In progress",
  "Resolved",
  "Closed",
]);
export const billStatusEnum = pgEnum("bill_status", [
  "Unpaid",
  "Partly paid",
  "Paid",
]);
export const messageStatusEnum = pgEnum("message_status", [
  "Queued",
  "Copied",
  "Sent",
  "Delivered",
  "Read",
  "Failed",
  "Cancelled",
]);
export const sendModeEnum = pgEnum("send_mode", ["manual", "connected"]);
export const destKindEnum = pgEnum("dest_kind", ["personal", "group"]);
export const appIdEnum = pgEnum("app_id", [
  "crm",
  "field",
  "orders",
  "people",
  "reports",
  "admin",
]);

/* ------------------------------------------------------------------ people */

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
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

/**
 * Which MahekOne apps a person can open. One sign-in serves all of them; this
 * table is what the launcher reads, and what decides whether signing in lands
 * you in the launcher or straight inside your only app.
 */
export const appAccess = pgTable(
  "app_access",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    app: appIdEnum("app").notNull(),
    grantedById: text("granted_by_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("app_access_user_app_key").on(t.userId, t.app),
    index("app_access_user_idx").on(t.userId),
  ],
);

/**
 * Signing in records attendance for the day; signing out closes it. One row per
 * person per day — a second sign-in on the same day reopens the same row rather
 * than starting a new one, so hours stay honest across a lunch break.
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/* --------------------------------------------------------------- customers */

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    contactPerson: text("contact_person").notNull(),
    phone: text("phone").notNull(),
    city: text("city").notNull(),
    ownerId: text("owner_id").references(() => users.id),
    status: customerStatusEnum("status").notNull().default("Active"),
    gstin: text("gstin"),
    creditTermDays: integer("credit_term_days").notNull().default(30),
    route: text("route"),
    /** Typical days between orders — drives the inactive watch. */
    cycleDays: integer("cycle_days").notNull().default(30),
    lastOrderDate: date("last_order_date"),
    lastOrderValue: bigint("last_order_value", { mode: "number" })
      .notNull()
      .default(0),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    outstanding: bigint("outstanding", { mode: "number" }).notNull().default(0),
    avgOrderValue: bigint("avg_order_value", { mode: "number" })
      .notNull()
      .default(0),
    orders6m: integer("orders_6m").notNull().default(0),
    /** Average days taken to pay — > credit terms means a slow payer. */
    paysInDays: integer("pays_in_days").notNull().default(30),
    slowPayer: boolean("slow_payer").notNull().default(false),
    whatsappGroupName: text("whatsapp_group_name"),
    whatsappDest: destKindEnum("whatsapp_dest").notNull().default("personal"),
    active: boolean("active").notNull().default(true),
    deactivationRequested: boolean("deactivation_requested")
      .notNull()
      .default(false),
    deactivationReason: text("deactivation_reason"),
    customerSince: date("customer_since"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("customers_owner_idx").on(t.ownerId),
    index("customers_name_idx").on(t.name),
  ],
);

/* ------------------------------------------------------------------- bills */

export const bills = pgTable(
  "bills",
  {
    id: text("id").primaryKey(),
    billNo: text("bill_no").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    billDate: date("bill_date").notNull(),
    dueDate: date("due_date").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    paid: bigint("paid", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("bills_no_key").on(t.billNo),
    index("bills_customer_idx").on(t.customerId),
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
    mode: text("mode").notNull().default("Bank transfer"),
    reference: text("reference"),
    receivedOn: date("received_on").notNull(),
    recordedById: text("recorded_by_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("payments_customer_idx").on(t.customerId)],
);

/* ------------------------------------------------------ the daily worklist */

export const queueItems = pgTable(
  "queue_items",
  {
    id: text("id").primaryKey(),
    day: date("day").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Why this customer is in today's queue. */
    reason: text("reason").notNull(),
    /** Sort weight — lower is called first. */
    priority: integer("priority").notNull().default(100),
    worked: boolean("worked").notNull().default(false),
    skipped: boolean("skipped").notNull().default(false),
    /** Set when a WhatsApp message holds the customer back from calling. */
    heldBackReason: text("held_back_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("queue_day_customer_key").on(t.day, t.customerId, t.ownerId),
    index("queue_day_owner_idx").on(t.day, t.ownerId),
  ],
);

export const interactions = pgTable(
  "interactions",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    channel: channelEnum("channel").notNull().default("Call"),
    connection: connectionEnum("connection"),
    outcome: text("outcome"),
    note: text("note"),
    /** "Order ₹96,000", "Reminder 14 Aug" — what the call produced. */
    produced: text("produced"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("interactions_customer_idx").on(t.customerId),
    index("interactions_user_time_idx").on(t.userId, t.occurredAt),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    product: text("product").notNull(),
    quantity: integer("quantity").notNull().default(1),
    value: bigint("value", { mode: "number" }).notNull(),
    expectedDispatch: date("expected_dispatch"),
    placedAt: timestamp("placed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("orders_customer_idx").on(t.customerId)],
);

export const reminders = pgTable(
  "reminders",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    dueDate: date("due_date").notNull(),
    note: text("note").notNull(),
    /** Where it came from: "call", "promise", "manual", "inactive watch". */
    source: text("source").notNull().default("manual"),
    status: reminderStatusEnum("status").notNull().default("open"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("reminders_user_due_idx").on(t.userId, t.dueDate),
    index("reminders_customer_idx").on(t.customerId),
  ],
);

export const promises = pgTable(
  "promises",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    amount: bigint("amount", { mode: "number" }).notNull(),
    promisedBy: date("promised_by").notNull(),
    note: text("note"),
    kept: boolean("kept"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("promises_customer_idx").on(t.customerId)],
);

export const complaints = pgTable(
  "complaints",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    description: text("description").notNull(),
    loggedById: text("logged_by_id")
      .notNull()
      .references(() => users.id),
    assignedTo: text("assigned_to").notNull().default("Operations"),
    status: complaintStatusEnum("status").notNull().default("Open"),
    resolutionNote: text("resolution_note"),
    customerTold: boolean("customer_told").notNull().default(false),
    loggedOn: date("logged_on").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    requestCn: boolean("request_cn").notNull().default(false),
    billId: text("bill_id").references(() => bills.id),
    goodsDescription: text("goods_description"),
    mobileNumber: text("mobile_number"),
  },
  (t) => [index("complaints_customer_idx").on(t.customerId)],
);

export const complaintEvents = pgTable("complaint_events", {
  id: text("id").primaryKey(),
  complaintId: text("complaint_id")
    .notNull()
    .references(() => complaints.id, { onDelete: "cascade" }),
  note: text("note").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const complaintImages = pgTable("complaint_images", {
  id: text("id").primaryKey(),
  complaintId: text("complaint_id")
    .notNull()
    .references(() => complaints.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ----------------------------------------------------------------- targets */

export const targets = pgTable(
  "targets",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** "2026-08" */
    period: text("period").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    /** True when nobody set this and the system applied a default. */
    isDefault: boolean("is_default").notNull().default(true),
    setById: text("set_by_id").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("targets_customer_period_key").on(t.customerId, t.period)],
);

/* ---------------------------------------------------------------- whatsapp */

export const waTemplates = pgTable("wa_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  body: text("body").notNull(),
  /** Which destination this template is meant for. */
  appliesTo: destKindEnum("applies_to").notNull().default("personal"),
  uses: integer("uses").notNull().default(0),
  archived: boolean("archived").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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
    body: text("body").notNull(),
    edited: boolean("edited").notNull().default(false),
    destination: text("destination").notNull(),
    destKind: destKindEnum("dest_kind").notNull().default("personal"),
    mode: sendModeEnum("mode").notNull().default("manual"),
    status: messageStatusEnum("status").notNull().default("Queued"),
    sentById: text("sent_by_id")
      .notNull()
      .references(() => users.id),
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("wa_messages_customer_idx").on(t.customerId)],
);

export const waReplies = pgTable("wa_replies", {
  id: text("id").primaryKey(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  message: text("message").notNull(),
  actioned: boolean("actioned").notNull().default(false),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const waRuns = pgTable("wa_runs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  templateId: text("template_id").references(() => waTemplates.id),
  filterKey: text("filter_key").notNull(),
  /** [{ customerId, state: 'pending'|'sent'|'skipped' }] */
  recipients: jsonb("recipients").notNull().$type<WaRunRecipient[]>(),
  cursor: integer("cursor").notNull().default(0),
  paused: boolean("paused").notNull().default(false),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type WaRunRecipient = {
  customerId: string;
  state: "pending" | "sent" | "skipped";
};

/* ---------------------------------------------------------------- workspace */

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("eod_user_day_key").on(t.userId, t.day)],
);

export const helpArticles = pgTable("help_articles", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  role: text("role").notNull().default("Telecaller"),
  isScript: boolean("is_script").notNull().default(false),
  scriptBody: text("script_body"),
  body: text("body").notNull(),
  updatedOn: date("updated_on").notNull(),
});

/* ------------------------------------------------------------- audit trail */

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    detail: text("detail"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_entity_idx").on(t.entity, t.entityId)],
);

/* --------------------------------------------------------------- relations */

export const usersRelations = relations(users, ({ many }) => ({
  customers: many(customers),
  interactions: many(interactions),
  reminders: many(reminders),
  appAccess: many(appAccess),
  attendance: many(attendance),
}));

export const appAccessRelations = relations(appAccess, ({ one }) => ({
  user: one(users, { fields: [appAccess.userId], references: [users.id] }),
}));

export const attendanceRelations = relations(attendance, ({ one }) => ({
  user: one(users, { fields: [attendance.userId], references: [users.id] }),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  owner: one(users, { fields: [customers.ownerId], references: [users.id] }),
  bills: many(bills),
  interactions: many(interactions),
  reminders: many(reminders),
  complaints: many(complaints),
  orders: many(orders),
  messages: many(waMessages),
  promises: many(promises),
}));

export const billsRelations = relations(bills, ({ one, many }) => ({
  customer: one(customers, {
    fields: [bills.customerId],
    references: [customers.id],
  }),
  payments: many(payments),
}));

export const interactionsRelations = relations(interactions, ({ one }) => ({
  customer: one(customers, {
    fields: [interactions.customerId],
    references: [customers.id],
  }),
  user: one(users, { fields: [interactions.userId], references: [users.id] }),
}));

export const remindersRelations = relations(reminders, ({ one }) => ({
  customer: one(customers, {
    fields: [reminders.customerId],
    references: [customers.id],
  }),
  user: one(users, { fields: [reminders.userId], references: [users.id] }),
}));

export const complaintsRelations = relations(complaints, ({ one, many }) => ({
  customer: one(customers, {
    fields: [complaints.customerId],
    references: [customers.id],
  }),
  loggedBy: one(users, {
    fields: [complaints.loggedById],
    references: [users.id],
  }),
  bill: one(bills, {
    fields: [complaints.billId],
    references: [bills.id],
  }),
  events: many(complaintEvents),
  images: many(complaintImages),
}));

export const complaintImagesRelations = relations(complaintImages, ({ one }) => ({
  complaint: one(complaints, {
    fields: [complaintImages.complaintId],
    references: [complaints.id],
  }),
}));

export const queueItemsRelations = relations(queueItems, ({ one }) => ({
  customer: one(customers, {
    fields: [queueItems.customerId],
    references: [customers.id],
  }),
  owner: one(users, { fields: [queueItems.ownerId], references: [users.id] }),
}));

export const waMessagesRelations = relations(waMessages, ({ one }) => ({
  customer: one(customers, {
    fields: [waMessages.customerId],
    references: [customers.id],
  }),
  sentBy: one(users, { fields: [waMessages.sentById], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type AppAccess = typeof appAccess.$inferSelect;
export type Attendance = typeof attendance.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Bill = typeof bills.$inferSelect;
export type QueueItem = typeof queueItems.$inferSelect;
export type Interaction = typeof interactions.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type Complaint = typeof complaints.$inferSelect;
export type ComplaintImage = typeof complaintImages.$inferSelect;
export type Target = typeof targets.$inferSelect;
export type WaTemplate = typeof waTemplates.$inferSelect;
export type WaMessage = typeof waMessages.$inferSelect;
export type WaRun = typeof waRuns.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type HelpArticle = typeof helpArticles.$inferSelect;
