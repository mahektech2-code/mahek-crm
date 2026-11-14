/* ---------------------------------------------------------------------------
 * AUTOMATIC TASKS — the rules, PURE and client-safe.
 *
 * Each app raises a task from its own records and closes it when the record no
 * longer needs anybody: a callback promised, a payment reported, an order or a
 * PO waiting for approval, a leave request, a complaint past its SLA, a lead's
 * next action. Nobody types these, and nobody has to remember to tick them off
 * — the app's own work is what closes them.
 *
 * This file says WHAT each rule is, for the Set up screen and the task record;
 * `automation-service.ts` says how each reads its records. A rule is on unless
 * a `task_automations` row says otherwise, so a rule added here needs no
 * migration to start working.
 * ------------------------------------------------------------------------- */

import type { TaskApp } from "./rules";

export type AutomationRule = {
  id: string;
  app: TaskApp;
  /** "A customer asks for a callback" — the event, as the screen says it. */
  when: string;
  /** Who the task goes to. */
  who: string;
  /** What closes it on its own. */
  closes: string;
  /** The remark written on a task this rule closes. */
  closedRemark: string;
  defaultOn: boolean;
  /** Where the work is done, when it is not the customer's own record. */
  openPath?: string;
};

export const AUTOMATIONS: AutomationRule[] = [
  {
    id: "crm.callback",
    app: "crm",
    when: "A customer is promised a callback (a reminder is set)",
    who: "Whoever the reminder is for",
    closes: "The reminder is completed or dismissed",
    closedRemark: "Closed in TeleCRM: the reminder was completed or dismissed.",
    defaultOn: true,
  },
  {
    id: "crm.lead-next-action",
    app: "crm",
    when: "A lead's next action is set",
    who: "Whoever owes the action",
    closes: "The next action changes, or the lead stops being a lead",
    closedRemark: "Closed in TeleCRM: the lead moved on.",
    defaultOn: true,
  },
  {
    id: "crm.complaint-sla",
    app: "crm",
    when: "A complaint passes its SLA",
    who: "Whoever logged it",
    closes: "The complaint is resolved, closed or rejected",
    closedRemark: "Closed in TeleCRM: the complaint was resolved.",
    defaultOn: true,
  },
  {
    id: "accounts.reported-payment",
    openPath: "/accounts/payments",
    app: "accounts",
    when: "A payment is reported and waits to be found in the bank",
    who: "The Accounts managers",
    closes: "The payment is confirmed, rejected or reversed",
    closedRemark: "Closed in Accounts: the payment was decided.",
    defaultOn: true,
  },
  {
    id: "accounts.order-approval",
    openPath: "/accounts/approvals",
    app: "accounts",
    when: "An order waits for approval",
    who: "The Accounts managers",
    closes: "The order is approved or declined",
    closedRemark: "Closed in Accounts: the order was decided.",
    defaultOn: true,
  },
  {
    id: "erp.po-approval",
    openPath: "/erp/purchase-orders",
    app: "erp",
    when: "A purchase order waits for approval",
    who: "Whoever may approve POs, except the person who raised it",
    closes: "The PO is approved, sent back or cancelled",
    closedRemark: "Closed in the ERP: the PO was decided.",
    defaultOn: true,
  },
  {
    id: "hrms.leave",
    openPath: "/hrms/leave",
    app: "hrms",
    when: "Somebody asks for leave",
    who: "Their reporting manager on the org chart",
    closes: "The leave is approved or rejected",
    closedRemark: "Closed in HRMS: the leave was decided.",
    defaultOn: true,
  },
];

export const AUTOMATION_BY_ID = new Map(AUTOMATIONS.map((r) => [r.id, r]));

/** What one automatic task should look like right now. */
export type WantedTask = {
  key: string;
  assigneeId: string;
  title: string;
  note: string | null;
  customerId: string | null;
  dueDate: string;
  priority: "urgent" | "high" | "normal" | "low";
};

export type ExistingAutoTask = { id: string; key: string; assigneeId: string; title: string; dueDate: string; status: string };

export type AutoPlan = {
  insert: WantedTask[];
  update: { id: string; set: Partial<Pick<WantedTask, "assigneeId" | "title" | "dueDate">> }[];
  close: string[];
};

/**
 * What a sync must do, given what the rule wants and what is already there.
 * Open tasks whose record no longer needs anybody close; open ones that drift
 * (a reassignment, a new due day) are brought in step; a key that has a task
 * already — open or closed — is never raised twice, so a task somebody closed
 * by hand while its record was still open stays closed.
 */
export function planAutoSync(wanted: WantedTask[], existing: ExistingAutoTask[]): AutoPlan {
  const byKey = new Map(existing.map((e) => [e.key, e]));
  const wantedKeys = new Set(wanted.map((w) => w.key));
  const plan: AutoPlan = { insert: [], update: [], close: [] };
  for (const w of wanted) {
    const e = byKey.get(w.key);
    if (!e) {
      plan.insert.push(w);
      continue;
    }
    if (e.status === "done" || e.status === "missed") continue;
    const set: AutoPlan["update"][number]["set"] = {};
    if (e.assigneeId !== w.assigneeId) set.assigneeId = w.assigneeId;
    if (e.title !== w.title) set.title = w.title;
    if (e.dueDate !== w.dueDate) set.dueDate = w.dueDate;
    if (Object.keys(set).length) plan.update.push({ id: e.id, set });
  }
  for (const e of existing) if (e.status !== "done" && e.status !== "missed" && !wantedKeys.has(e.key)) plan.close.push(e.id);
  return plan;
}

const APP_HOME: Record<string, string> = {
  crm: "/crm",
  accounts: "/accounts",
  sales: "/sales",
  erp: "/erp",
  hrms: "/hrms",
  founder: "/founder",
  enquiries: "/enquiries",
  website: "/website",
  hire: "/hire",
  factory: "/factory",
};

/**
 * Where "Open in <app>" goes: the screen an automatic task is done on, else the
 * customer's record in the CRM, else the app itself. Null for a personal task.
 */
export function taskOpenHref(t: { app: string; customerId: string | null; autoRule: string | null }): string | null {
  const rule = t.autoRule ? AUTOMATION_BY_ID.get(t.autoRule) : undefined;
  if (rule?.openPath) return rule.openPath;
  if (t.customerId && (t.app === "crm" || t.app === "tasks")) return `/crm/customers/${t.customerId}`;
  return APP_HOME[t.app] ?? null;
}
