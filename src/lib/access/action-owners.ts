import type { AppId } from "../apps";
import type { Capability } from "../capability-matrix";

/* ---------------------------------------------------------------------------
 * WHICH SCREEN, AND WHICH TICK, OWNS EVERY ACTION.
 *
 * Under the screen model a capability is held because somebody holds a
 * screen at a tick: Access (every ordinary action on it), Edit, or Delete.
 * This table says which. A capability can be owned by several screens in an
 * app — taking an order happens on the Call Log and on My orders — and
 * holding ANY of them at that tick is holding it.
 *
 * `position: "manager"` marks the few capabilities that are about whose
 * records one sees rather than what one does — reading the whole team's
 * reports is the Manager position, so the screen alone is not enough.
 *
 * A `Record` over every capability, so one added to the matrix fails the
 * build here until somebody decides which screen it belongs to. An app
 * missing from a capability's entry cannot grant it at all.
 *
 * DRAFT FOR REVIEW. Every entry here is a decision; `permissions.test.ts`
 * prints, app by app and level by level, what this table gives that today's
 * matrix did not and what it takes away — that list is what gets signed off
 * before anything reads this table.
 * ------------------------------------------------------------------------- */

/**
 * Held by everybody signed in, whatever they were granted — recording a payment
 * somebody handed over is never a privilege. No screen owns it.
 */
export const EVERYONE: ReadonlySet<Capability> = new Set<Capability>(["payment.record"]);

export type Tick = "access" | "edit" | "delete";
export type Owner = { screen: string; tick: Tick; position?: "manager" };

const a = (screen: string): Owner => ({ screen, tick: "access" });
const e = (screen: string): Owner => ({ screen, tick: "edit" });
const d = (screen: string): Owner => ({ screen, tick: "delete" });
const mgr = (o: Owner): Owner => ({ ...o, position: "manager" });

/** The book apps share their lead and customer screens' keys after the app prefix. */
const book = (app: "crm" | "sales", owners: (p: string) => Owner[]): [AppId, Owner[]] => [app, owners(app)];

export const ACTION_OWNERS: Record<Capability, Partial<Record<AppId, Owner[]>>> = {
  "customer.read": Object.fromEntries([
    book("crm", (p) => [a(`${p}.customers`), a(`${p}.call-log`), a(`${p}.leads`), a(`${p}.lead-calling-desk`), a(`${p}.outstanding`), a(`${p}.my-orders`)]),
    book("sales", (p) => [a(`${p}.leads`), a(`${p}.orders`), a(`${p}.payments`), a(`${p}.lead-pipeline`)]),
    ["accounts", [a("accounts.customers"), a("accounts.ledger"), a("accounts.approvals"), a("accounts.outstanding")]],
    ["field", [a("field.accounts"), a("field.leads"), a("field.nearby")]],
  ]),
  "customer.write": { crm: [e("crm.customers")], sales: [e("sales.leads")], field: [e("field.accounts"), e("field.leads")] },
  "customer.export": { crm: [a("crm.customers")], sales: [a("sales.lead-oversight")] },
  "customer.deactivate": { crm: [e("crm.deactivations")], sales: [d("sales.leads")] },
  "customer.classify": { crm: [e("crm.deactivations")], sales: [e("sales.lead-oversight")], accounts: [e("accounts.customers")] },
  "customer.reassign": { accounts: [e("accounts.customers")] },
  "customer.assignSalesManager": { crm: [e("crm.sales-manager")], sales: [e("sales.lead-oversight")], accounts: [e("accounts.customers")] },
  "customer.handOver": { crm: [e("crm.lead-handovers")], sales: [e("sales.lead-handovers")] },

  "lead.work": { crm: [a("crm.leads"), a("crm.lead-calling-desk")], sales: [a("sales.leads")], field: [a("field.leads")] },
  "lead.trash": { crm: [d("crm.leads")], sales: [d("sales.leads")] },
  "lead.restore": { crm: [d("crm.lead-dead")] },
  "lead.override": { crm: [e("crm.lead-qualify")], sales: [e("sales.lead-qualify")], field: [e("field.lead-actions")] },
  "lead.verify": { crm: [e("crm.lead-qualify")], sales: [e("sales.lead-qualify")], field: [e("field.lead-actions")] },
  "lead.gstValidate": { crm: [a("crm.lead-qualify"), a("crm.leads")], sales: [a("sales.lead-qualify"), a("sales.leads")], accounts: [a("accounts.customers")] },
  "sample.approve": { crm: [e("crm.samples")], sales: [e("sales.samples")], field: [e("field.samples")] },
  "distributor.terms": { crm: [e("crm.lead-commercial")], sales: [e("sales.lead-commercial")], field: [e("field.lead-actions")] },
  "distributor.approve": { crm: [e("crm.lead-appointments")], sales: [e("sales.lead-appointments")] },

  "call.log": { crm: [a("crm.call-log"), a("crm.lead-calling-desk")], sales: [a("sales.leads")], field: [a("field.leads"), a("field.accounts")] },
  "order.capture": { crm: [a("crm.my-orders"), a("crm.call-log")], sales: [a("sales.orders")], field: [a("field.orders")] },
  "reminder.write": { crm: [a("crm.reminders"), a("crm.call-log")], sales: [a("sales.leads")], field: [a("field.tasks"), a("field.leads")] },
  "reminder.close": { crm: [e("crm.reminders")], sales: [e("sales.lead-actions")], enquiries: [e("enquiries.list")] },
  "complaint.resolve": { crm: [e("crm.complaints")], sales: [e("sales.lead-oversight")] },

  "target.set": { crm: [e("crm.targets")], sales: [e("sales.targets")], accounts: [e("accounts.targets")] },
  "target.shortfall": { crm: [a("crm.targets")], sales: [a("sales.targets")], accounts: [a("accounts.customer-targets")], field: [a("field.performance")] },
  "team.report": {
    crm: [mgr(a("crm.performance"))],
    sales: [mgr(a("sales.performance"))],
    founder: [mgr(a("founder.overview"))],
  },

  "whatsapp.bulk": { crm: [e("crm.whatsapp")], sales: [e("sales.notify")] },
  "whatsapp.template.write": { crm: [e("crm.whatsapp")], sales: [e("sales.notify")] },
  "whatsapp.activate": { founder: [e("founder.whatsapp")] },

  "order.approve": { accounts: [e("accounts.approvals")] },
  "payment.record": { crm: [a("crm.payments")], sales: [a("sales.payments")], accounts: [a("accounts.record")], field: [a("field.collections")] },
  "payment.confirm": { accounts: [e("accounts.payments")] },
  "creditnote.issue": { accounts: [e("accounts.credits")] },
  "sheet.import": { crm: [e("crm.settings")], sales: [e("sales.prefs")], accounts: [e("accounts.import")] },

  /* No Accounts screen draws the policy; held on the desk's home until somebody decides where it lives. */
  "expense.policy.write": { sales: [e("sales.expense-policy")], accounts: [e("accounts.today")] },
  "expense.policy.publish": { sales: [e("sales.expense-policy")] },

  "pricelist.read": { crm: [a("crm.price-lists")], sales: [a("sales.leads")], accounts: [a("accounts.price-lists")], founder: [a("founder.price-lists")], field: [a("field.catalogue")] },
  "pricelist.manage": { crm: [e("crm.price-lists")], accounts: [e("accounts.price-lists")], founder: [e("founder.price-lists")] },

  "config.write": { crm: [e("crm.settings")], sales: [e("sales.prefs")], admin: [e("admin.console")] },
  "access.manage": { admin: [d("admin.console")] },
};
