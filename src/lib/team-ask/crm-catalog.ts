import type { TableSpec } from "./catalog";

/* ---------------------------------------------------------------------------
 * What the CRM's Ask AI may read, and for whom.
 *
 * The same machinery as "Ask about the team" (`catalog.ts`): every table the
 * model can name is a TEMPORARY VIEW of the same name over the real table,
 * narrowed twice —
 *
 *  1. THE SCREEN. A table is offered only when the person holds a CRM module
 *     that already shows it: bills need Sales Bills, Outstanding or Payment
 *     Follow-up; complaints need Complaints; the chats need WhatsApp. That is
 *     the Access screen's answer, read through `listUserModules`.
 *
 *  2. THE ROWS. `{S}` is the people `resolveScope()` puts in this person's
 *     book — the same list every CRM screen narrows by — and a customer is in
 *     the view exactly when `scopedToUsers` would list it: the four seats that
 *     carry sight (whose book, back office, lead manager, relationship owner),
 *     and never a lead in the trash.
 *
 * A telecaller therefore asks about their own book and nothing else; a manager
 * about their team's; an administrator about the company's.
 * ------------------------------------------------------------------------- */

const ASSIGNED = `case when kind = 'lead' then owner_id when am_decided_at is not null then sales_am_id else coalesce(sales_am_id, owner_id) end`;

export const CRM_TABLES: TableSpec[] = [
  // ---------------------------------------------------------------- people
  {
    table: "users",
    about:
      "MahekOne accounts in this person's book: telecallers, salesmen and managers. name, email, phone, role (associate/manager/admin), active.",
    modules: [],
    scope: { kind: "custom", where: "id in {S}" },
  },

  // ------------------------------------------------------------- customers
  {
    table: "customers",
    about:
      "Every account in this person's book: direct customers (kind='customer'), leads (kind='lead'; lead_stage is the funnel rung) and third-party shops billed by a distributor (third_party=true). outstanding is paise owed (stated bills only). last_order_date, last_order_value (paise), cycle_days (their buying cycle; cycle_is_default=true means not measured), last_call_date, last_contact_date, status (active/inactive/deactivated), slow_payer, do_not_contact, credit_term_days, credit_limit_paise, credit_blocked. Seats: owner_id/sales_am_id (whose book — join users), back_office_am_id, sales_person_name (as the sheet names the salesperson). city/region are as typed; resolved_city_id etc. point at places.",
    modules: [],
    scope: {
      kind: "custom",
      where: `deleted_at is null and ((${ASSIGNED}) in {S} or back_office_am_id in {S} or lead_manager_id in {S} or relationship_owner_id in {S})`,
    },
    hide: /^(geocoded_|gps_)/,
  },
  {
    table: "customer_contacts",
    about:
      "The people at a customer: name, role (owner, orders, accounts…), phone, email, is_primary / for_whatsapp / for_payment_reminders, birth_day + birth_month.",
    modules: [],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "customer_distributors",
    about: "Who bills a third-party shop: customer_id is the shop, distributor_customer_id the account we invoice, is_primary.",
    modules: [],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "places",
    about: "The reviewed place tree: id, name, kind (state/district/city/area), parent_id. Join customers.resolved_city_id = places.id for a clean city name.",
    modules: [],
    scope: { kind: "all" },
  },
  {
    table: "timeline_events",
    about: "Everything that happened to a customer, in one stream: event_type, source_app, occurred_at, actor_user_id, summary.",
    modules: [],
    scope: { kind: "customer", col: "customer_id" },
  },

  // ---------------------------------------------------------- daily calling
  {
    table: "calls",
    about:
      "Every call logged: customer_id, user_id (who called), started_at, connection_status, outcome, call_reason, notes, next_step_kind / next_step_date / next_step_headline (what the telecaller was told happens next), order_id, reminder_id, complaint_id.",
    modules: ["crm.history", "crm.call-log", "crm.customers", "crm.dashboard"],
    scope: { kind: "customer", col: "customer_id", orUser: ["user_id"] },
  },
  {
    table: "queue_snapshots",
    about:
      "Each day's Call Log as it was built: day, user_id (whose list), customer_id, rank (1 = top), score, reasons (why they are on it).",
    modules: ["crm.call-log", "crm.dashboard"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "reminders",
    about:
      "Callbacks: customer_id, assigned_user_id, due_date, type, status (open/done/dismissed…), note, closed_at, closure_note.",
    modules: ["crm.reminders", "crm.call-log"],
    scope: { kind: "customer", col: "customer_id", orUser: ["assigned_user_id"] },
  },
  {
    table: "lead_stage_transitions",
    about: "Every move of a lead between funnel rungs: customer_id, from_stage, to_stage, at, actor_id, reason_code, note.",
    modules: ["crm.leads"],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "mbos_samples",
    about:
      "Product samples given to shops: customer_id, salesman_id, product_id, quantity_cans, state (requested→approved→dispatched→received→tried→reviewed), trial_outcome, requested_date.",
    modules: ["crm.samples", "crm.leads"],
    scope: { kind: "customer", col: "customer_id" },
  },

  // --------------------------------------------------------------- records
  {
    table: "complaints",
    about:
      "Customer complaints: customer_id, category, description, severity, status, sla_due_at, created_at, resolved_at, request_cn (credit note asked for), cn_amount (paise), cn_status.",
    modules: ["crm.complaints"],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "monthly_targets",
    about: "Each customer's monthly sales target: customer_id, year, month, target_amount (paise, excl. GST), is_default, carried_forward.",
    modules: ["crm.targets"],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "focus_customers",
    about: "Customers somebody marked to grow into top customers: customer_id, added_by_id, note, added_at.",
    modules: ["crm.targets"],
    scope: { kind: "customer", col: "customer_id" },
  },

  // ----------------------------------------------------------- the money
  {
    table: "orders",
    about:
      "Orders: customer_id, user_id (who took it; null for sheet orders), order_no, ordered_at, total_amount (paise, GST in), net_amount_paise (excl. GST), status (pending_approval/confirmed/dispatched/in_transit/delivered/declined/cancelled), line_items (jsonb), decline_reason. A sale counts when status in ('confirmed','dispatched','in_transit','delivered').",
    modules: ["crm.customers", "crm.history", "crm.dashboard", "crm.bills", "crm.targets"],
    scope: { kind: "customer", col: "customer_id", orUser: ["user_id"] },
  },
  {
    table: "bills",
    about:
      "Invoices: customer_id, bill_no, bill_date, due_date, amount, paid_amount (paise), status, disputed, payment_position (stated/unstated — unstated bills are not counted as owed). Outstanding on a bill = amount - paid_amount.",
    modules: ["crm.bills", "crm.outstanding", "crm.payments"],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "payment_receipts",
    about:
      "Money received or reported: customer_id, amount (paise), received_at, mode, reference, instrument_date (date on a cheque), status (reported/held/confirmed/rejected/reversed — only confirmed counts), reported_by_id.",
    modules: ["crm.payments", "crm.outstanding", "crm.bills"],
    scope: { kind: "customer", col: "customer_id", orUser: ["reported_by_id"] },
  },
  {
    table: "payments",
    about: "How each receipt was allocated to bills: receipt_id, bill_id (null = on account), amount.",
    modules: ["crm.payments", "crm.outstanding", "crm.bills"],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "follow_up_states",
    about:
      "Collections state per customer: stage (how far the chasing has gone), days_overdue, total_overdue (paise), overdue_bill_count, oldest_overdue_bill_date, last_follow_up_at, held, held_reason.",
    modules: ["crm.payments", "crm.outstanding"],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "follow_up_attempts",
    about:
      "Each collections attempt: customer_id, user_id, attempted_at, channel, outcome, promised_amount (paise), promised_date.",
    modules: ["crm.payments"],
    scope: { kind: "customer", col: "customer_id", orUser: ["user_id"] },
  },

  // -------------------------------------------------------------- WhatsApp
  {
    table: "wa_messages",
    about:
      "WhatsApp messages we sent or prepared: customer_id, user_id, template_name, status (prepared/copied/sent/delivered/read/failed…), confirmed_sent_at, sent_at, read_at, failure_reason. Not the message body.",
    modules: ["crm.whatsapp"],
    scope: { kind: "customer", col: "customer_id", orUser: ["user_id"] },
    hide: /^(body|resolved_destination)$/,
  },
  {
    table: "wa_replies",
    about: "Replies customers sent on WhatsApp: customer_id, message, received_at, actioned, answer_status.",
    modules: ["crm.whatsapp"],
    scope: { kind: "customer", col: "customer_id" },
  },

  // ------------------------------------------------------------ catalogue
  {
    table: "products",
    about: "The product catalogue (SKUs): name, formulation_id, millilitres_per_can, cans_per_box, active.",
    modules: [],
    scope: { kind: "all" },
  },
  {
    table: "product_formulations",
    about: "Product formulations (the liquid a SKU is made of): name, active.",
    modules: [],
    scope: { kind: "all" },
  },
];

/** What each CRM module is called on the screen, for "you would need …". */
export const CRM_MODULE_LABEL: Record<string, string> = {
  "crm.history": "Call History",
  "crm.call-log": "Call Log",
  "crm.customers": "Customers",
  "crm.dashboard": "Dashboard",
  "crm.reminders": "Reminders",
  "crm.leads": "Leads",
  "crm.samples": "Samples",
  "crm.complaints": "Complaints",
  "crm.targets": "Monthly targets",
  "crm.bills": "Sales Bills",
  "crm.outstanding": "Outstanding",
  "crm.payments": "Payment Follow-up",
  "crm.whatsapp": "WhatsApp",
};
