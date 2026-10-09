/* ---------------------------------------------------------------------------
 * What the Ask panel's model may read, and for whom.
 *
 * Every table the model can name is a TEMPORARY VIEW of the same name, built
 * fresh for one question, over the real table with two narrowings applied:
 *
 *  1. THE SCREEN. A table is offered only when the person holds a Sales
 *     Dashboard module that already shows it — leave needs Leave, salaries need
 *     Salary, a salesman's trail needs the Live map. That is the Access
 *     screen's own answer, read through `listUserModules`, so unticking a
 *     screen there takes the matching tables out of the panel on the next
 *     question. Nothing here widens what a person could open.
 *
 *  2. THE ROWS. `managerScope()` — the same narrowing every list on the
 *     dashboard reads — decides which salesmen, and so which customers, the
 *     rows may be about. A national manager reads everything; a regional one
 *     reads their region's people and the shops they hold.
 *
 * Columns that are credentials or identity documents (passwords, tokens,
 * Aadhaar, PAN, bank accounts, raw sheet snapshots) are left out of every view
 * whatever the person holds. They are never on a Sales Dashboard screen.
 *
 * PURE: given the scope, the modules and the real column lists, it returns
 * the SQL that builds the views. The service runs it.
 * ------------------------------------------------------------------------- */

/** Placeholders a scope filter may use, resolved when the views are built. */
const S = "(select id from pg_temp.ask_scope_users)";
const C = "(select id from pg_temp.customers)";
const E = "(select employee_id from pg_temp.users where employee_id is not null)";

export type Scope =
  | { kind: "all" }
  /** Rows about one of the in-scope people, through any of these columns. */
  | { kind: "user"; cols: string[] }
  /** Rows about an in-scope customer (or, where given, an in-scope person). */
  | { kind: "customer"; col: string; orUser?: string[] }
  /** Rows about an in-scope employee (HRMS tables key on the employee). */
  | { kind: "employee"; cols: string[] }
  /** A hand-written clause. Placeholders: {S} people, {C} customers, {E} employees. */
  | { kind: "custom"; where: string };

export type TableSpec = {
  table: string;
  /** One line telling the model what a row IS. */
  about: string;
  /**
   * The Sales Dashboard modules any one of which reveals this table. Empty
   * means anybody who can open the panel (team.report) may read it.
   */
  modules: string[];
  scope: Scope;
  /** Columns left out on top of the universal sensitive list. */
  hide?: RegExp;
  /** Columns shown only to a holder of one of these modules. */
  gatedCols?: { re: RegExp; modules: string[] };
};

/** Never in any view, for anybody: credentials, identity documents, sync plumbing. */
export const ALWAYS_HIDDEN =
  /(password|secret|token|_hash$|^raw$|aadhaar|pan_number|account_number|ifsc|uan_no|esic_no|push_token|idempotency_key|^sync_id$|last_seen_sync_id|^device_id$|selfie_id$|photo_id$|_attachment_id$|^context_snapshot$|bill_hash)/i;

const SALARY_COLS = /(salary|conveyance_paise|in_hand_paise|incentive_paise|advance_deduction_paise|^figures$|^utr$|payslip)/i;

/**
 * The order matters: a custom clause may read a view built above it
 * (`pg_temp.users`, `pg_temp.customers`, `pg_temp.mbos_journey_plans`).
 */
export const TABLES: TableSpec[] = [
  // ---------------------------------------------------------------- people
  {
    table: "users",
    about:
      "MahekOne accounts — every salesman, telecaller and manager. role is the account level (associate/manager/admin). Who is a field salesman: has an app_access row with app='field'. employee_id links to employees.",
    modules: [],
    scope: { kind: "custom", where: "id in {S}" },
  },
  {
    table: "app_access",
    about:
      "Which apps a user holds (app: field = the MBOS salesman handset, sales = Sales Dashboard, crm, accounts, hrms, …) and at what level (role).",
    modules: [],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "employees",
    about:
      "The HR employee master (mirrored from the HR sheet): name, department, position, office, reports_to (a name), status (active/inactive), joining/leaving dates, phones, personal targets. Link to a user via users.employee_id.",
    modules: [],
    scope: { kind: "custom", where: "id in {E}" },
    gatedCols: { re: SALARY_COLS, modules: ["sales.salary"] },
  },
  {
    table: "mbos_user_territories",
    about:
      "The geography a person works or oversees: kind is region (a manager's oversight state), state, city or beat; parent is what a city/beat was picked under.",
    modules: [],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "mbos_devices",
    about:
      "Each salesman's bound handset: model, app_version, last_seen_at (last time it spoke to the server), battery_percent at device_state_at, location permission and tracking health.",
    modules: ["sales.live", "sales.sync-health", "sales.today"],
    scope: { kind: "user", cols: ["user_id"] },
  },

  // ------------------------------------------------------------- customers
  {
    table: "customers",
    about:
      "Every account: direct customers (kind='customer'), leads (kind='lead'; lead_stage is the funnel rung) and third-party shops (third_party=true). Whose book: coalesce(sales_am_id, owner_id) for customers, owner_id for leads. outstanding is paise owed. city/region are as typed; resolved_*_id point at places.",
    modules: [],
    scope: {
      kind: "custom",
      where:
        "deleted_at is null and (owner_id in {S} or sales_am_id in {S} or back_office_am_id in {S} or sales_manager_id in {S} or lead_manager_id in {S} or relationship_owner_id in {S} {UNOWNED})",
    },
  },
  {
    table: "customer_contacts",
    about: "The people at a customer: name, role, phone, email, birthday (birth_day/birth_month).",
    modules: [],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "places",
    about:
      "The reviewed place tree: kind is state/district/city/area, parent_id links upward, shops is how many accounts sit there. customers.resolved_state_id/_district_id/_city_id/_area_id point here.",
    modules: [],
    scope: { kind: "all" },
  },
  {
    table: "timeline_events",
    about:
      "Each customer's shared history, one row per thing that happened (visit, order, payment, call, lead move…): event_type, occurred_at, actor_user_id, summary.",
    modules: [],
    scope: { kind: "customer", col: "customer_id", orUser: ["actor_user_id"] },
  },

  // ---------------------------------------------------- attendance & leave
  {
    table: "mbos_attendance_days",
    about:
      "A field salesman's working day from the handset: day, check_in_at (punch in), check_out_at (punch out), check_in_address, worked_seconds, status (present/absent/leave/holiday… derived), within_geofence, sessions (jsonb list of in/out).",
    modules: ["sales.attendance", "sales.today", "sales.live"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "mbos_leave_requests",
    about:
      "Leave a salesman asked for on the handset: leave_type, from_date, to_date, days, half_day, reason, cancelled_at. Whether it was approved is in mbos_approvals (subject_type='leave', subject_id = this id; state).",
    modules: ["sales.leave", "sales.attendance"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "mbos_leave_balances",
    about: "Leave entitlement per salesman per year and leave_type: entitled_days, used_days.",
    modules: ["sales.leave"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "hrms_leave_requests",
    about:
      "Leave recorded in HRMS (office staff and anybody whose leave HR keyed): employee_id, type, start_date, end_date, days, status, approved_by_name.",
    modules: ["sales.leave", "sales.attendance"],
    scope: { kind: "employee", cols: ["employee_id"] },
  },
  {
    table: "hrms_attendance",
    about: "HRMS attendance register rows: employee_id, date, check_in, check_out, method, office_name.",
    modules: ["sales.attendance"],
    scope: { kind: "employee", cols: ["employee_id"] },
  },
  {
    table: "mbos_holidays",
    about: "Field holidays: on_date, name.",
    modules: [],
    scope: { kind: "all" },
  },
  {
    table: "hrms_holidays",
    about: "The company holiday calendar: date, category, name.",
    modules: [],
    scope: { kind: "all" },
  },
  {
    table: "hrms_salaries",
    about: "Monthly salary slips per employee: month, status, in_hand_paise, incentive, deductions, paid_on.",
    modules: ["sales.salary"],
    scope: { kind: "employee", cols: ["employee_id"] },
  },

  // --------------------------------------------------- where they went
  {
    table: "mbos_positions",
    about:
      "The GPS trail while checked in: user_id, at (timestamp), lat, lng, accuracy_m. Large — always filter by user_id and a time window.",
    modules: ["sales.live"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "mbos_activity_locations",
    about:
      "Where each activity (visit, order, payment…) was done: entity_type, entity_id, user_id, lat, lng, captured_at.",
    modules: ["sales.live"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "mbos_visits",
    about:
      "A salesman's visit to a shop: salesman_id, customer_id, check_in_at, check_out_at, duration_seconds, outcome, notes, was_planned, verified, distance_from_shop_m, linked_order_id, linked_payment_id, next_follow_up_date.",
    modules: ["sales.journeys", "sales.today", "sales.live", "sales.activity-history"],
    scope: { kind: "user", cols: ["salesman_id"] },
  },
  {
    table: "mbos_journey_plans",
    about:
      "A planned day for a salesman: plan_date, city, area/beat, status, day_state (proposed/refused/agreed/planned…), refusal_reason, counter_city.",
    modules: ["sales.journeys"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "mbos_journey_stops",
    about:
      "The shops on a planned day: plan_id → mbos_journey_plans, customer_id, sequence, status (planned/visited/skipped), actual_visit_at, skip_reason.",
    modules: ["sales.journeys"],
    scope: { kind: "custom", where: "plan_id in (select id from pg_temp.mbos_journey_plans)" },
  },
  {
    table: "mbos_tours",
    about: "Requests to work away (out-station tours): user_id, start_date, end_date, cities, purpose, estimated_cost_paise.",
    modules: ["sales.field-reports", "sales.expenses"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "mbos_travel_legs",
    about:
      "Each journey leg: user_id, mode_key, from_label, to_label, started_at, ended_at, chosen_metres (distance used), odometer readings, ticket_amount_paise, claim_excluded.",
    modules: ["sales.expenses", "sales.live"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "mbos_travel_modes",
    about: "The ways of travelling (own bike, bus…): key, label.",
    modules: [],
    scope: { kind: "all" },
  },
  {
    table: "sheet_field_activity_rows",
    about:
      "Visits and calls from the prior system (EMP 2.0), before MBOS — the past only; from the cutover (setting fieldActivity.cutoverDate, 10 Oct 2026 by default) mbos_visits is the record and rows here dated on or after it are not part of the history: employee_name, matched_salesman_id, customer_name, matched_customer_id, visit_date, meeting_type, meeting_purpose, meeting_note, location.",
    modules: ["sales.activity-history"],
    scope: { kind: "custom", where: "matched_salesman_id in {S}" },
  },

  // ------------------------------------------------------------- the work
  {
    table: "mbos_tasks",
    about:
      "Tasks given to salesmen: title, assigned_to_user_id, assigned_by_user_id, due_date, status, priority, customer_id, completed_at, escalated_at.",
    modules: ["sales.tasks"],
    scope: { kind: "user", cols: ["assigned_to_user_id", "assigned_by_user_id"] },
  },
  {
    table: "mbos_approvals",
    about:
      "Requests waiting on or decided by a manager: type (leave, expense, order, sample, tour, territory…), requested_by_user_id, subject_type, subject_id, state (pending/approved/rejected…), decided_at, decision_note, approver_user_id.",
    modules: ["sales.approvals", "sales.leave", "sales.expenses", "sales.orders"],
    scope: { kind: "user", cols: ["requested_by_user_id", "approver_user_id"] },
  },
  {
    table: "mbos_samples",
    about:
      "Product samples given to shops: salesman_id, customer_id, product_id, quantity_cans, state (requested→approved→dispatched→received→tried→reviewed), trial_outcome, requested_date.",
    modules: ["sales.samples", "sales.leads"],
    scope: { kind: "customer", col: "customer_id", orUser: ["salesman_id"] },
  },
  {
    table: "mbos_competitor_records",
    about: "Competitor intelligence from shops: competitor_name, product_name, price_paise, credit_days, recorded_on.",
    modules: ["sales.field-reports"],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "complaints",
    about: "Customer complaints: category, description, severity, status, created_at, resolved_at, cn_amount (credit note, paise).",
    modules: ["sales.field-reports"],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "lead_stage_transitions",
    about: "Every move of a lead between funnel rungs: from_stage, to_stage, at, actor_id, reason_code, note.",
    modules: ["sales.leads", "sales.lead-pipeline", "sales.lead-funnel", "sales.lead-oversight"],
    scope: { kind: "customer", col: "customer_id" },
  },

  // ----------------------------------------------------------- the money
  {
    table: "orders",
    about:
      "Orders: customer_id, user_id (who took it; null for sheet orders), ordered_at, total_amount (paise, GST in), net_amount_paise (excl. GST), status (pending_approval/confirmed/dispatched/in_transit/delivered/declined/cancelled), line_items (jsonb), source. Counting sales: status in ('confirmed','dispatched','in_transit','delivered').",
    modules: ["sales.orders", "sales.performance", "sales.today"],
    scope: { kind: "customer", col: "customer_id", orUser: ["user_id"] },
  },
  {
    table: "bills",
    about:
      "Invoices: customer_id, bill_no, bill_date, due_date, amount, paid_amount (paise), status, payment_position (stated/unstated). Outstanding on a bill = amount - paid_amount.",
    modules: ["sales.invoices", "sales.payments"],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "payment_receipts",
    about:
      "Money received: customer_id, amount (paise), received_at, mode, status (reported/held/confirmed/rejected/reversed — only confirmed counts), source, reported_by_id, deposited_at (cash banked).",
    modules: ["sales.payments"],
    scope: { kind: "customer", col: "customer_id", orUser: ["reported_by_id"] },
  },
  {
    table: "payments",
    about: "How each receipt was allocated to bills: receipt_id, bill_id (null = on account), amount.",
    modules: ["sales.payments"],
    scope: { kind: "customer", col: "customer_id" },
  },
  {
    table: "mbos_expenses",
    about:
      "Expense lines a salesman filed: user_id, expense_date, category, amount_paise, eligible_paise, excess_paise, claim_id, remarks.",
    modules: ["sales.expenses"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "mbos_expense_claims",
    about: "An expense claim: user_id, period_from, period_to, submitted_at, total_paise.",
    modules: ["sales.expenses"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "mbos_expense_days",
    about: "One salesman day priced for expenses: day, destination_city, overnight, submitted_claimed_paise, submitted_eligible_paise.",
    modules: ["sales.expenses"],
    scope: { kind: "user", cols: ["user_id"] },
  },

  // ------------------------------------------------------ targets & score
  {
    table: "sales_targets",
    about:
      "A person's monthly target: period ('YYYY-MM'), revenue_target_paise (excl. GST), volume_target_ml, new_customer_target, status (draft/published).",
    modules: ["sales.performance", "sales.targets"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "sales_performance",
    about:
      "The cached monthly score per person: period, revenue/volume/new customer/collection/activity actual and achievement_bp (basis points, 10000 = 100%), total_score_bp, rating, computed_at.",
    modules: ["sales.performance", "sales.targets"],
    scope: { kind: "user", cols: ["user_id"] },
  },
  {
    table: "monthly_targets",
    about: "Per-customer monthly purchase targets: customer_id, year, month, target_amount (paise).",
    modules: ["sales.performance", "sales.targets"],
    scope: { kind: "customer", col: "customer_id" },
  },

  // ------------------------------------------------------------ catalogue
  {
    table: "products",
    about: "Sellable SKUs: name, pack_size, millilitres_per_can, cans_per_box, formulation_id, active.",
    modules: [],
    scope: { kind: "all" },
  },
  {
    table: "product_formulations",
    about: "The liquid a product is (Nano, PU, Universal…): name, category_id.",
    modules: [],
    scope: { kind: "all" },
  },
];

export type BuildInput = {
  /** Null means national: no row narrowing. */
  salesmanIds: string[] | null;
  /** The asker, always in scope. */
  selfId: string;
  /** An associate's own book — no "nobody holds it" leads. */
  own: boolean;
  /** Sales Dashboard module keys this person holds. */
  modules: Set<string>;
  /** Real column names per table, from the database. */
  columns: Map<string, string[]>;
};

export type BuiltView = { table: string; about: string; columns: string[] };

export function allowedTables(modules: Set<string>): TableSpec[] {
  return TABLES.filter((t) => !t.modules.length || t.modules.some((m) => modules.has(m)));
}

/** The columns one person may see on one table. */
export function visibleColumns(spec: TableSpec, all: string[], modules: Set<string>): string[] {
  return all.filter((c) => {
    if (ALWAYS_HIDDEN.test(c)) return false;
    if (spec.hide?.test(c)) return false;
    if (spec.gatedCols?.re.test(c) && !spec.gatedCols.modules.some((m) => modules.has(m))) return false;
    return true;
  });
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Not an identifier: ${s}`);
  return `"${s}"`;
};

function whereFor(scope: Scope, national: boolean, own: boolean): string {
  if (national && scope.kind !== "custom") return "true";
  switch (scope.kind) {
    case "all":
      return "true";
    case "user":
      return scope.cols.map((c) => `${ident(c)} in ${S}`).join(" or ");
    case "employee":
      return scope.cols.map((c) => `${ident(c)} in ${E}`).join(" or ");
    case "customer": {
      const parts = [`${ident(scope.col)} in ${C}`];
      for (const u of scope.orUser ?? []) parts.push(`${ident(u)} in ${S}`);
      return parts.join(" or ");
    }
    case "custom": {
      if (national) {
        // A national reader is narrowed by nothing except what is not a row
        // at all (a lead in the trash) and by the views above (journey stops).
        if (scope.where.startsWith("deleted_at is null")) return "deleted_at is null";
        if (scope.where.includes("pg_temp.")) return scope.where;
        return "true";
      }
      return scope.where
        .replaceAll("{S}", S)
        .replaceAll("{C}", C)
        .replaceAll("{E}", E)
        .replaceAll(
          "{UNOWNED}",
          // A lead nobody holds is every manager's to see — `leadsVisible`'s rule.
          own ? "" : "or (owner_id is null and sales_am_id is null and sales_manager_id is null)",
        );
    }
  }
}

/**
 * The statements that build one person's views, in order, and what each view
 * offers — the second half is what the model is told about.
 */
export function buildViews(input: BuildInput): { statements: string[]; views: BuiltView[] } {
  const national = input.salesmanIds === null;
  const ids = [...new Set([input.selfId, ...(input.salesmanIds ?? [])])];
  const statements = [
    "create temp table ask_scope_users (id text primary key) on commit drop",
  ];
  if (!national) {
    statements.push(
      `insert into pg_temp.ask_scope_users (id) values ${ids.map((i) => `('${i.replaceAll("'", "''")}')`).join(", ")}`,
    );
  }
  const views: BuiltView[] = [];
  for (const spec of allowedTables(input.modules)) {
    const all = input.columns.get(spec.table);
    if (!all?.length) continue;
    const cols = visibleColumns(spec, all, input.modules);
    if (!cols.length) continue;
    const where = whereFor(spec.scope, national, input.own);
    statements.push(
      `create temp view ${ident(spec.table)} as select ${cols.map(ident).join(", ")} from public.${ident(spec.table)} where ${where}`,
    );
    views.push({ table: spec.table, about: spec.about, columns: cols });
  }
  return { statements, views };
}
