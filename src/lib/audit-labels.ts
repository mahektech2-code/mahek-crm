/* ---------------------------------------------------------------------------
 * THE AUDIT LOG, IN WORDS SOMEBODY RUNNING THE BUSINESS CAN READ.
 *
 * `audit_log` is written by more than three hundred call sites, each naming
 * what it did with a code — `customer.deactivation_rejected`, `erp.rmLevel.create`,
 * `set-app-access` — and keeping whatever it thought worth keeping as JSON. The
 * console used to print exactly that: the code as "What happened", the TABLE
 * name as "About", and the raw JSON, truncated, as "Detail". That is a record a
 * developer can read and an owner cannot, and an audit log the owner cannot read
 * answers nobody's question.
 *
 * Nothing about what is STORED changes here. The log is append-only and stays
 * that way; this is a reading of it. Three things happen on the way out:
 *
 *  1. **A code becomes a sentence.** `DESCRIBE` holds one for every code that
 *     matters to somebody deciding whether the business is all right — money,
 *     access, settings, who owns a customer. Each names the record, not the
 *     table, and says the number that matters ("reversed a ₹25,097 payment from
 *     Colour Camp — Wrong entry").
 *
 *  2. **Every other code is TRANSLATED, never printed.** There are a few hundred
 *     factory and HR codes, and they are regular: `erp.rawMaterial.create` is an
 *     app, a thing and a verb. `translate` turns those three into "added a raw
 *     material in the Factory app" from the two word lists below, and
 *     `audit-labels.test.ts` reads the source and fails on any code written
 *     anywhere whose words this file does not know. So a new feature that audits
 *     a new code fails the build until somebody says what it means in English,
 *     instead of quietly putting a code back on the owner's screen.
 *
 *  3. **Before and after become a list of changes.** "Phone: 70217… → 97020…",
 *     with ids turned into names and paise into rupees, and the bookkeeping
 *     fields (`updatedAt`, `updatedById`) left out because they are what every
 *     write does rather than what this one did.
 *
 * PURE and client-safe like `complaint-labels` and `seat-labels` beside it:
 * names arrive as data, resolved once per page by the service.
 * ------------------------------------------------------------------------- */

import { APPS as APP_REGISTRY } from "./apps";
import { money, shortDate } from "./format";

/* ------------------------------------------------------------------ groups */

/**
 * WHAT AN OWNER ASKS ABOUT, which is not which table a row landed in.
 *
 * A group is decided by the longest matching PREFIX of the code, so it can be
 * asked in SQL as well as here — the filter has to run in the database or a
 * paged list would page through rows it then hides. `groupCaseSql` in the
 * service is generated from this same list, so the tab and the label cannot
 * disagree about a row.
 */
export const AUDIT_GROUPS = [
  {
    slug: "money",
    label: "Money",
    hint: "Payments, orders, credit notes, price lists and targets",
    prefixes: [
      "payment.",
      "order.",
      "creditnote.",
      "payout.",
      "pricelist.",
      "followup.",
      "target.",
      "expense.",
      "mbos.priceList.",
      "mbos.scheme.",
      "mbos.evidence.",
      "mbos.expense_payout.",
      "import.bills",
    ],
  },
  {
    slug: "customers",
    label: "Customers & leads",
    hint: "Who owns a customer, leads moving, calls, reminders, complaints and WhatsApp",
    prefixes: [
      "customer.",
      "lead.",
      "sample.",
      "distributor.",
      "queue.",
      "interaction.",
      "opportunity.",
      "reminder.",
      "complaint.",
      "watch.",
      "whatsapp.",
      "founder.note",
      "admin.bulk-",
      "import.customers",
    ],
  },
  {
    slug: "field",
    label: "Field team",
    hint: "Salesmen's handsets, journeys, territories, approvals and documents",
    prefixes: ["mbos.", "leave.entitlement"],
  },
  {
    slug: "factory",
    label: "Factory",
    hint: "Purchases, testing, production, stock and dispatch in the Factory app",
    prefixes: ["erp."],
  },
  {
    slug: "hr",
    label: "HR",
    hint: "Employees, attendance, leave, salaries and tasks in HRMS",
    prefixes: ["hrms.", "employee."],
  },
  {
    slug: "access",
    label: "People & access",
    hint: "Accounts created, apps granted, passwords, refusals and signing in as somebody",
    prefixes: [
      "access.",
      "create-user",
      "create",
      "set-app-access",
      "set-role",
      "issue-credential",
      "link-employee",
      "unlink-employee",
      "deactivate-user",
      "reactivate-user",
      "update-user",
      "send-password-reset",
      "end-sessions",
      "impersonate.",
      "provision-user",
      "admin.identity-correction",
    ],
  },
  {
    slug: "settings",
    label: "Settings & catalogue",
    hint: "Configuration, keys, the catalogue, the expense policy and WhatsApp rules",
    prefixes: [
      "config.",
      "secret.",
      "catalogue.",
      "expense_policy.",
      "whatsapp.service_",
      "whatsapp.automation_window",
      "whatsapp.rule_",
      "whatsapp.template_link",
      "job.",
    ],
  },
  {
    slug: "signin",
    label: "Sign-ins",
    hint: "Signing in and out, and resetting passwords",
    prefixes: [
      "sign-in",
      "sign-out",
      "request-password-reset",
      "reset-password",
      "reset-code-sent",
      "change-password",
    ],
  },
] as const;

export type AuditGroup = (typeof AUDIT_GROUPS)[number]["slug"] | "other";

export const AUDIT_GROUP_LABEL: Record<AuditGroup, string> = {
  ...(Object.fromEntries(AUDIT_GROUPS.map((g) => [g.slug, g.label])) as Record<
    (typeof AUDIT_GROUPS)[number]["slug"],
    string
  >),
  other: "Other",
};

/** Every (prefix, group) pair, longest prefix first — the order the SQL CASE uses too. */
export const GROUP_RULES: ReadonlyArray<{ prefix: string; group: AuditGroup }> = AUDIT_GROUPS.flatMap(
  (g) => g.prefixes.map((prefix) => ({ prefix: prefix as string, group: g.slug as AuditGroup })),
).sort((a, b) => b.prefix.length - a.prefix.length);

export function auditGroup(action: string): AuditGroup {
  return GROUP_RULES.find((r) => action.startsWith(r.prefix))?.group ?? "other";
}

/** How many rows a page of the console's log may carry. */
export const AUDIT_PAGE_SIZES = [25, 50, 100] as const;
export type AuditPageSize = (typeof AUDIT_PAGE_SIZES)[number];

/* ------------------------------------------------------------------- input */

export type AuditEvent = {
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  /** The customer the row is about, where the service could find one. */
  subjectId: string | null;
};

/** Names resolved once per page. Anything missing falls back to a description, never an id. */
export type AuditNames = {
  users: Record<string, string>;
  customers: Record<string, string>;
  employees: Record<string, string>;
  /** Setting key → the label the Settings screen shows. */
  settings: Record<string, string>;
};

export type RefKind = "customer" | "user" | "employee";

/** A sentence is words and references; a reference renders as a link where it can. */
export type Piece = string | { ref: RefKind; id: string; name: string } | { strong: string };

export type Change = { field: string; from: string; to: string };

export type Description = {
  /** Read after the actor's name: "{actor} {says}". */
  says: Piece[];
  /** A reason or note somebody typed, shown in quotes beneath. */
  note: string | null;
  changes: Change[];
  /** True when the sentence came from the word lists rather than a written entry. */
  translated: boolean;
};

/* ----------------------------------------------------------------- helpers */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const rupees = (v: unknown): string | null => {
  const n = num(v);
  return n === null ? null : money(n);
};
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
/** "medium_value" / "highConsumption" → "medium value" / "high consumption". */
export function words(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
}
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Context the describers share: name lookups that never print an id. */
class Ctx {
  constructor(
    readonly e: AuditEvent,
    readonly n: AuditNames,
  ) {}
  get a(): Obj {
    return obj(this.e.after);
  }
  get b(): Obj {
    return obj(this.e.before);
  }
  customer(id: unknown, fallback = "a customer"): Piece {
    const key = str(id);
    if (!key) return fallback;
    const name = this.n.customers[key];
    return name ? { ref: "customer", id: key, name } : fallback;
  }
  /** The customer the row is about — the subject the service found, else the entity. */
  subject(fallback = "a customer"): Piece {
    return this.customer(this.e.subjectId ?? this.e.entityId, fallback);
  }
  /** No id means nobody held the seat; an id we cannot name is an account since removed. */
  user(id: unknown, fallback = "nobody"): Piece {
    const key = str(id);
    if (!key) return fallback;
    const name = this.n.users[key];
    return name ? { ref: "user", id: key, name } : /^usr_/.test(key) ? "a former account" : fallback;
  }
  employee(id: unknown, fallback = "an employee"): Piece {
    const key = str(id);
    if (!key) return fallback;
    const name = this.n.employees[key];
    return name ? { ref: "employee", id: key, name } : fallback;
  }
  setting(key: unknown): Piece {
    const k = str(key);
    if (!k) return "a setting";
    return { strong: this.n.settings[k] ?? cap(words(k.split(".").pop() ?? k)) };
  }
  /** The first reason-like text in either state. */
  reason(): string | null {
    const a = this.a;
    const b = this.b;
    return (
      str(a.reason) ??
      str(a.note) ??
      str(a.remark) ??
      str(a.remarks) ??
      str(a.detail) ??
      str(a.question) ??
      str(b.reason) ??
      null
    );
  }
}

type Say = { says: Piece[]; note?: string | null; changes?: false | Change[] };
type Describer = (c: Ctx) => Say | Piece[];

const strong = (s: string): Piece => ({ strong: s });

/* --------------------------------------------------------- written entries */

/**
 * ONE SENTENCE PER CODE THAT ANYBODY WILL LOOK FOR.
 *
 * Written for the codes production actually carries and for every decision that
 * moves money, access or ownership. The rest are translated (below), which is
 * readable but plainer; promote a code into this list when its translation is
 * not enough.
 */
const DESCRIBE: Record<string, Describer> = {
  /* ---- money */
  "payment.record": (c) => ({
    says: [
      "recorded a payment of",
      strong(rupees(c.a.amount) ?? "an amount"),
      ...(str(c.a.mode) ? [`by ${str(c.a.mode)!.toLowerCase()}`] : []),
      "from",
      c.subject(),
      ...(c.a.status === "reported" ? ["— waiting for accounts to find it in the bank"] : []),
    ],
    note: str(c.a.reference) ? `Reference ${str(c.a.reference)}` : null,
    changes: false,
  }),
  "payment.confirm": (c) => ({
    says: ["confirmed a payment of", strong(rupees(c.a.amount) ?? "an amount"), "from", c.subject(), "— it now counts against the bills"],
    changes: false,
  }),
  "payment.reject": (c) => ({
    says: ["rejected a reported payment of", strong(rupees(c.a.amount) ?? "an amount"), "from", c.subject(), "— the money was never found"],
    changes: false,
  }),
  "payout.create": (c) => ({
    says: ["added a payout of", strong(rupees(c.a.amount) ?? "an amount"), "to", strong(str(c.a.payee) ?? "a vendor")],
    changes: false,
  }),
  "payout.reschedule": (c) => ({
    says: ["moved the payout to", strong(str(c.a.payee) ?? "a vendor"), "to", strong(shortDate(str(c.a.payOn)))],
    changes: false,
  }),
  "payout.hold": (c) => ({ says: ["held the payout to", strong(str(c.a.payee) ?? "a vendor")], changes: false }),
  "payout.release": (c) => ({ says: ["released the payout to", strong(str(c.a.payee) ?? "a vendor")], changes: false }),
  "payout.paid": (c) => ({
    says: ["marked", strong(rupees(c.a.amount) ?? "a payout"), "to", strong(str(c.a.payee) ?? "a vendor"), "paid"],
    changes: false,
  }),
  "payout.reopen": (c) => ({ says: ["reopened a paid payout to", strong(str(c.a.payee) ?? "a vendor")], changes: false }),
  "payout.cancel": (c) => ({ says: ["cancelled the payout to", strong(str(c.a.payee) ?? "a vendor")], changes: false }),
  "payout.note": (c) => ({ says: ["changed the note on the payout to", strong(str(c.a.payee) ?? "a vendor")], changes: false }),
  "payout.invoice.add": (c) => ({
    says: ["added", strong(str(c.a.kind) ?? "an invoice"), "to the payout to", strong(str(c.a.payee) ?? "a vendor")],
    changes: false,
  }),
  "payout.invoice.remove": (c) => ({ says: ["removed", strong(str(c.b.kind) ?? "an invoice"), "from a vendor payout"], changes: false }),
  "payment.reverse": (c) => ({
    says: ["reversed a confirmed payment of", strong(rupees(c.a.amount) ?? "an amount"), "from", c.subject(), "— it no longer counts"],
    changes: false,
  }),
  "payment.hold": (c) => ({
    says: ["put a payment of", strong(rupees(c.a.amount) ?? "an amount"), "from", c.subject(), "on hold while it is checked"],
    changes: false,
  }),
  "payment.reallocate": (c) => ["moved a payment from", c.subject(), "onto different bills"],
  "payment.matchedToBankEntry": (c) => ({
    says: ["matched a bank entry to a payment", c.subject() === "a customer" ? "" : "from", c.subject(""), "already reported, instead of recording it twice"],
    changes: false,
  }),
  "payment.apply_on_account": (c) => ({
    says: ["used", strong(rupees(c.a.amount) ?? "money"), "held on account by", c.subject(), "to settle bill", strong(str(c.a.billNo) ?? "")],
    changes: false,
  }),
  "order.approve": (c) => ({
    says: ["approved an order", ...(num(c.a.amount) ? ["of", strong(rupees(c.a.amount)!)] : []), "from", c.subject()],
    changes: false,
  }),
  "order.decline": (c) => ({
    says: ["declined an order", ...(num(c.a.amount) ? ["of", strong(rupees(c.a.amount)!)] : []), "from", c.subject()],
    changes: false,
  }),
  "order.change.accept": (c) => ["accepted a change to an order from", c.subject()],
  "order.change.decline": (c) => ["declined a change to an order from", c.subject()],
  "creditnote.issue": (c) => ({
    says: ["issued a credit note of", strong(rupees(c.a.amount) ?? "an amount"), "to", c.subject()],
    changes: false,
  }),
  "creditnote.refuse": (c) => ({ says: ["refused a credit note request from", c.subject()], changes: false }),
  "followup.log": (c) => ({
    says: [
      "logged a payment follow-up with",
      c.subject(),
      ...(str(c.a.outcome) ? [`— ${str(c.a.outcome)!.toLowerCase()}`] : []),
      ...(num(c.a.amount) ? ["of", strong(rupees(c.a.amount)!)] : []),
      ...(str(c.a.date) ? ["by", strong(shortDate(str(c.a.date)!))] : []),
    ],
    changes: false,
  }),
  "followup.attempt": (c) => ["chased", c.subject(), "for payment"],
  "target.create": (c) => ({ says: ["set a sales target for", c.user(c.a.userId), "for", strong(periodWords(c.a.period))], changes: false }),
  "target.revise": (c) => ({ says: ["changed the published sales target of", c.user(c.a.userId), "for", strong(periodWords(c.a.period))], changes: false }),
  "target.publish": (c) => ({ says: ["published the sales target of", c.user(c.a.userId), "for", strong(periodWords(c.a.period))], changes: false }),
  "pricelist.publish": (c) => ({ says: ["published a price list", ...(num(c.a.rates) ? [`with ${plural(num(c.a.rates)!, "rate")}`] : [])], changes: false }),
  "pricelist.document.publish": (c) => ({ says: ["published a price list from an uploaded document", ...(num(c.a.rates) ? [`(${plural(num(c.a.rates)!, "rate")})`] : [])], changes: false }),
  "pricelist.rate.set": () => ({ says: ["set a price on a price list"], changes: false }),
  "pricelist.rate.bulk": (c) => ({ says: ["set", plural(num(c.a.written) ?? 0, "rate"), "at once on a price list"], changes: false }),
  "pricelist.request.withdraw": (c) => ({ says: ["withdrew a special-price request for", c.subject()], changes: false }),
  "pricelist.parse.resolve": () => ({ says: ["matched a line of an uploaded price list to a product"], changes: false }),
  "pricelist.parse.price": () => ({ says: ["corrected a price read from an uploaded price list"], changes: false }),
  "pricelist.create": (c) => ({ says: ["created a price list", ...(str(c.a.name) ? [strong(str(c.a.name)!)] : [])], changes: false }),
  "pricelist.withdraw": () => ({ says: ["withdrew a price list"], changes: false }),
  "pricelist.delete": (c) => ({ says: ["deleted the price list", strong(str(c.b.name) ?? "")], changes: false }),
  "pricelist.customer.assign": (c) => ["changed which price list", c.subject(), "is charged from"],
  "pricelist.request.raise": (c) => ["asked for a special price for", c.subject()],
  "pricelist.request.decide": (c) => [c.a.status === "approved" ? "approved" : "decided", "a special-price request for", c.subject()],
  "mbos.approval.approved": (c) => ({ says: ["approved a field request", ...(num(c.a.approvedAmountPaise) ? ["for", strong(rupees(c.a.approvedAmountPaise)!)] : [])], changes: false }),
  "mbos.approval.rejected": () => ({ says: ["turned down a field request"], changes: false }),
  "mbos.evidence.accepted": () => ({ says: ["accepted a salesman's evidence for an expense claim"], changes: false }),
  "mbos.evidence.rejected": () => ({ says: ["rejected a salesman's evidence for an expense claim"], changes: false }),
  "mbos.expense_payout.recorded": (c) => ({ says: ["recorded a reimbursement to a salesman", ...(num(c.a.amountPaise) ? ["of", strong(rupees(c.a.amountPaise)!)] : [])], changes: false }),
  "mbos.expense_payout.voided": () => ({ says: ["voided a reimbursement to a salesman"], changes: false }),
  "expense.day_approved": () => ({ says: ["approved a salesman's day of expenses"], changes: false }),
  "expense.day_partially_approved": () => ({ says: ["partly approved a salesman's day of expenses"], changes: false }),
  "expense.day_rejected": () => ({ says: ["rejected a salesman's day of expenses"], changes: false }),
  "expense.day_reopened": () => ({ says: ["reopened a salesman's day of expenses"], changes: false }),
  "expense.day_submitted_by_office": () => ({ says: ["submitted a salesman's day of expenses on his behalf"], changes: false }),
  "expense.exception_accepted": () => ({ says: ["accepted an expense that broke the policy"], changes: false }),
  "expense.exception_rejected": () => ({ says: ["rejected an expense that broke the policy"], changes: false }),
  "expense.exception_corrected": () => ({ says: ["corrected an expense that broke the policy"], changes: false }),
  "hrms.leave.apply": () => ({ says: ["applied for leave"], changes: false }),
  "hrms.attendance.editHelp": () => ({ says: ["let a QR-code day be corrected"], changes: false }),
  "hrms.attendance.fromHelp": () => ({ says: ["wrote an approved help request's times onto the attendance day"], changes: false }),
  "hrms.leaveCredit.run": () => ({ says: ["ran the leave credit for everybody"], changes: false }),
  "hrms.salary.pay": () => ({ says: ["marked a salary as paid"], changes: false }),
  "hrms.advance.give": (c) => ({ says: ["gave a salary advance", ...(num(c.a.amount) ? ["of", strong(rupees(c.a.amount)!)] : [])], changes: false }),
  "catalogue.packing_import": (c) => ({ says: ["imported ERP packing from Mahek Plus", ...(num(c.a.packingSet) !== null ? [`(${num(c.a.packingSet)} SKUs, ${num(c.a.withCanUse) ?? 0} with a Can Use, ${num(c.a.materialsCreated) ?? 0} packing materials added)`] : [])], changes: false }),
  "catalogue.import": (c) => ({ says: ["imported the product catalogue", ...(num(c.a.created) !== null ? [`(${num(c.a.created)} new, ${num(c.a.updated) ?? 0} changed)`] : [])], changes: false }),
  "import.bills": () => ({ says: ["imported bills from a file"], changes: false }),

  /* ---- customers & leads */
  "customer.update": (c) => ["edited the details of", c.subject()],
  "customer.contact.add": (c) => ({ says: ["added a contact", ...(str(c.a.name) ? [strong(str(c.a.name)!)] : []), "to", c.subject()], changes: false }),
  "customer.contact.update": (c) => ["edited a contact at", c.subject()],
  "customer.contact.remove": (c) => ({ says: ["removed a contact", ...(str(c.b.name) ? [strong(str(c.b.name)!)] : []), "from", c.subject()], changes: false }),
  "customer.contact.designate": (c) => ({
    says: [
      "changed which number at",
      c.subject(),
      str(c.a.designation) === "payment" ? "gets payment reminders" : str(c.a.designation) === "whatsapp" ? "gets WhatsApp" : "is the primary one",
    ],
    changes: false,
  }),
  "customer.deactivate": (c) => ({ says: ["deactivated", c.subject()], changes: false }),
  "customer.focus.add": (c) => ({ says: ["added", c.subject(), "to focus customers"], changes: false }),
  "customer.focus.remove": (c) => ({ says: ["took", c.subject(), "off focus customers"], changes: false }),
  "customer.deactivation_rejected": (c) => ({ says: ["turned down a request to deactivate", c.subject()], changes: false }),
  "customer.reactivate": (c) => ({ says: ["reactivated", c.subject()], changes: false }),
  "customer.reactivation_rejected": (c) => ({ says: ["turned down a request to reactivate", c.subject()], changes: false }),
  "customer.reassign": (c) => {
    const a = c.a;
    const moved: Piece[] = [];
    if ("salesAmId" in a) moved.push("salesperson to", c.user(a.salesAmId, str(a.salesPersonName) ?? "nobody"));
    if ("backOfficeAmId" in a)
      moved.push(...(moved.length ? ["and"] : []), "back office to", c.user(a.backOfficeAmId, str(a.backOfficeName) ?? "nobody"));
    const reason = str(obj(a.salesReason).reasonCode) ?? str(obj(a.backOfficeReason).reasonCode);
    return {
      says: ["changed who looks after", c.subject(), ...(moved.length ? ["— ", ...moved] : [])],
      note: reason,
      changes: false,
    };
  },
  "customer.assignSalesManager": (c) => ({
    says: [
      "made",
      c.user(c.a.salesManagerId, str(c.a.salesManagerPersonName) ?? "somebody"),
      "the sales manager of",
      plural(num(c.a.moved) ?? 0, "customer"),
    ],
    note: str(c.a.reasonCode) ?? str(c.a.note),
    changes: false,
  }),
  "customer.handOver": (c) => ({
    says: ["handed", num(c.a.count) === 1 ? c.subject() : plural(num(c.a.count) ?? 0, "customer"), "over to", c.user(c.a.toUserId)],
    note: str(c.a.reasonCode),
    changes: false,
  }),
  "customer.convertThirdParty": (c) => thirdParty(c, "marked", "as billed through a distributor"),
  "customer.markThirdParty": (c) => thirdParty(c, "marked", "as billed through a distributor"),
  "customer.revertThirdParty": (c) => thirdParty(c, "marked", "as billed directly again"),
  "customer.unmarkThirdParty": (c) => thirdParty(c, "marked", "as billed directly again"),
  "customer.addDistributor": (c) => ["named", c.customer(c.a.distributorId, "a distributor"), "as a distributor of", c.subject()],
  "customer.updateDistributor": (c) => ["changed how", c.customer(c.a.distributorId, "a distributor"), "serves", c.subject()],
  "customer.removeDistributor": (c) => ["removed", c.customer(c.b.distributorId, "a distributor"), "as a distributor of", c.subject()],
  "customer.convertedFromLead": (c) => ({ says: ["turned the lead", c.subject(), "into a customer"], changes: false }),
  "queue.skip": (c) => ({ says: ["took", c.subject(), "off today's Call Log"], changes: false }),
  "queue.rebuild": (c) => ({ says: ["rebuilt the Call Log for", strong(shortDate(str(c.a.day) ?? ""))], changes: false }),
  "interaction.save": (c) => ({
    says: [callWord(c.a.interactionType), c.subject(), ...(str(c.a.outcome) ? [`— ${words(str(c.a.outcome)!)}`] : [])],
    changes: false,
  }),
  "opportunity.status": (c) => ({
    says: ["moved a call opportunity to", strong(words(str(c.a.status) ?? "a new status"))],
    changes: false,
  }),
  "reminder.close": (c) => ({ says: ["completed a reminder for", c.subject()], changes: false }),
  "reminder.dismiss": (c) => ({ says: ["dismissed a reminder for", c.subject()], changes: false }),
  "complaint.priority": (c) => ["changed the priority of a complaint from", c.subject()],
  "watch.outcome": (c) => ({ says: ["recorded what happened with the inactive customer", c.subject()], changes: false }),
  "lead.captured": (c) => ({
    says: ["added a new lead,", strong(str(c.a.name) ?? "unnamed"), ...(str(c.a.city) ? [`in ${str(c.a.city)}`] : [])],
    changes: false,
  }),
  "lead.stage.move": (c) => ({
    says: ["moved the lead", c.subject(), "from", strong(words(str(c.b.stage) ?? "?")), "to", strong(words(str(c.a.stage) ?? "?"))],
    note: overriddenNote(c),
    changes: false,
  }),
  "lead.stage.promote": (c) => ({ says: ["won the lead", c.subject(), "— it is now a customer"], note: overriddenNote(c), changes: false }),
  "lead.stage.reopen": (c) => ({ says: ["reopened the lead", c.subject(), "(it had been", `${words(str(c.b.stage) ?? "closed")})`], changes: false }),
  "lead.stage.relabel": (c) => ({
    says: ["relabelled the lead", c.subject(), "from", strong(words(str(c.b.stage) ?? "?")), "to", strong(words(str(c.a.stage) ?? "?")), "so it can be converted"],
    changes: false,
  }),
  "lead.trashed": (c) => ({ says: ["deleted the lead", c.subject(str(c.b.name) ?? "a lead")], changes: false }),
  "lead.restored": (c) => ({ says: ["restored the deleted lead", c.subject()], changes: false }),
  "lead.priority": (c) => ({ says: ["set the priority of", c.subject(), "to", strong(words(str(c.a.leadPriority) ?? "none"))], changes: false }),
  "lead.deskAssigned": (c) => ({ says: ["gave the lead", c.subject(), "to", c.user(c.a.ownerId)], changes: false }),
  "lead.reassigned": (c) => ({ says: ["moved the lead", c.subject(), "from", c.user(c.b.ownerId), "to", c.user(c.a.ownerId)], changes: false }),
  "lead.unassigned": (c) => ({ says: ["took the lead", c.subject(), "off", c.user(c.b.ownerId), "— it is unassigned"], changes: false }),
  "lead.callingDesk.call": (c) => ({
    says: ["called the lead", c.subject(), ...(str(c.a.outcome) ? [`— ${words(str(c.a.outcome)!)}`] : [])],
    changes: false,
  }),
  "lead.callingDesk.convertToProspect": (c) => ({ says: ["made", c.subject(), "a prospect"], note: words(str(c.a.reason) ?? "") || null, changes: false }),
  "lead.communication": (c) => ({ says: ["sent", c.subject(), str(c.a.actionCode) ? `a ${words(str(c.a.actionCode)!)}` : "something"], changes: false }),
  "lead.salesType.set": (c) => ({ says: ["set how", c.subject(), "will be sold to:", strong(words(str(c.a.salesType) ?? "?"))], changes: false }),
  "lead.prospectRequest": (c) => ({ says: ["asked for", c.subject(), "to be made a prospect"], changes: false }),
  "lead.prospectRequest.resubmit": (c) => ({ says: ["asked again for", c.subject(), "to be made a prospect"], changes: false }),
  "lead.prospectRequest.return": (c) => ({ says: ["sent back the request to make", c.subject(), "a prospect"], changes: false }),
  "lead.qualificationReview": (c) => ({ says: ["reviewed the qualification of", c.subject()], changes: false }),
  "lead.manager.assign": (c) => ({ says: ["made", c.user(c.a.leadManagerId), "the manager of the lead", c.subject()], changes: false }),
  "lead.firstOrder.confirm": (c) => ({ says: ["confirmed the first order of", c.customer(c.a.customerId), ...(num(c.a.valuePaise) ? ["worth", strong(rupees(c.a.valuePaise)!)] : [])], changes: false }),
  "lead.duplicate.dismissed": (c) => ({ says: ["said two leads that looked alike are different shops"], note: str(c.a.reason), changes: false }),
  "whatsapp.sent_api": (c) => ({ says: ["sent", c.customer(c.a.customerId), "a WhatsApp message", ...(str(c.a.watiTemplate) ? [`(${words(str(c.a.watiTemplate)!)})`] : [])], changes: false }),
  "whatsapp.confirm_sent": (c) => ({ says: ["confirmed a WhatsApp message was sent to", c.customer(c.a.customerId)], changes: false }),
  "whatsapp.chat_sent": (c) => ({ says: ["replied on WhatsApp to", c.customer(c.a.customerId, "a customer")], changes: false }),
  "whatsapp.dnd_on": (c) => ({ says: ["stopped WhatsApp messages to", c.subject()], changes: false }),
  "whatsapp.dnd_off": (c) => ({ says: ["allowed WhatsApp messages to", c.subject(), "again"], changes: false }),
  "whatsapp.test_send": (c) => ({ says: ["sent a test WhatsApp message", c.a.ok === false ? "— it failed" : ""], changes: false }),
  "whatsapp.replies_backfilled": (c) => ({ says: ["imported", plural(num(c.a.imported) ?? 0, "older WhatsApp reply", "older WhatsApp replies")], changes: false }),
  "founder.note": () => ({ says: ["added a note"], changes: false }),
  "admin.bulk-sales-am-correction": (c) => ({ says: ["corrected the salesperson on", plural(num(c.a.count) ?? 0, "customer"), "directly in the database"], changes: false }),
  "admin.bulk-sales-manager-correction": (c) => ({ says: ["corrected the sales manager on", plural(num(c.a.count) ?? 0, "customer"), "directly in the database"], changes: false }),
  "admin.bulk-sales-manager-derivation": (c) => ({ says: ["filled in the sales manager on", plural(num(c.a.count) ?? 0, "customer"), "from HRMS, directly in the database"], changes: false }),
  "import.customers": () => ({ says: ["imported customers from a file"], changes: false }),

  /* ---- field */
  "mbos.journey.propose": (c) => ({ says: ["proposed a journey plan to", c.user(c.e.entityId, str(c.a.salesman) ?? "a salesman"), journeyDates(c)], changes: false }),
  "mbos.journey.answered": (c) => ({
    says: [c.a.answer === "refused" ? "refused the day proposed for" : "agreed the day proposed for", strong(str(c.a.planDate) ?? "a day")],
    note: str(c.a.reason),
    changes: false,
  }),
  "mbos.journey.period": (c) => ({ says: ["planned the journey of", c.user(c.e.entityId, str(c.a.salesman) ?? "a salesman"), journeyDates(c)], changes: false }),
  "mbos.salesman.territories": (c) => ["changed the area", c.user(c.e.entityId, "a salesman"), "works"],
  "mbos.manager.territories": (c) => ["changed the regions", c.user(c.e.entityId, "a manager"), "manages"],
  "mbos.device.release": (c) => ({ says: ["released the handset", strong(str(c.b.model) ?? ""), "so it can be signed into again"], changes: false }),
  "mbos.lead.reassign": (c) => ({ says: ["moved the lead", c.subject(), "from", c.user(c.b.assignedToUserId), "to", c.user(c.a.assignedToUserId)], changes: false }),
  "mbos.lead.archive": (c) => ({ says: ["filed away the lead", c.subject()], changes: false }),
  "mbos.lead.restore": (c) => ({ says: ["brought back the filed lead", c.subject()], changes: false }),
  "mbos.notification.send": (c) => ({
    says: ["sent a notice", str(c.a.title) ? `“${str(c.a.title)}”` : "", "to", plural(num(c.a.recipientCount) ?? 0, "salesman", "salesmen")],
    note: str(c.a.body),
    changes: false,
  }),
  "mbos.task.created": (c) => ({ says: ["gave", c.user(c.a.assignedToUserId), "a task:", strong(str(c.a.title) ?? "")], changes: false }),
  "mbos.task.bulkCreated": (c) => ({ says: ["gave", plural(num(c.a.created) ?? 0, "person", "people"), "a task:", strong(str(c.a.title) ?? "")], changes: false }),
  "mbos.task.campaignCreated": (c) => ({
    says: ["assigned", plural(num(c.a.tasks) ?? 0, "task"), ...(num(c.a.questions) ? ["asking", plural(num(c.a.questions)!, "question")] : []), ":", strong(str(c.a.title) ?? "")],
    note: str(c.a.audience),
    changes: false,
  }),
  "mbos.task.campaignClosed": (c) => ({ says: ["withdrew", plural(num(c.a.cancelled) ?? 0, "open task"), "from an assignment"], changes: false }),
  "customer.task.linkSaved": (c) => ({ says: ["saved a field task's answer to the customer record", c.subject()], changes: false }),
  "mbos.document.publish": (c) => ({ says: ["published a document to the field team", ...(str(c.a.title) ? [strong(str(c.a.title)!)] : [])], changes: false }),
  "mbos.document.withdraw": () => ({ says: ["withdrew a document from the field team"], changes: false }),
  "mbos.document.tag": (c) => {
    const n = Array.isArray(c.a.visibleToUserIds) ? c.a.visibleToUserIds.length : 0;
    return { says: ["changed who a document is for:", n ? plural(n, "person", "people") + " by name" : "everybody in the field"], changes: false };
  },
  "mbos.document.edit": (c) => ({ says: ["edited a document", ...(str(c.a.title) ? [strong(str(c.a.title)!)] : [])] }),
  "mbos.course.publish": (c) => ({ says: ["published a training course", ...(str(c.a.title) ? [strong(str(c.a.title)!)] : [])], changes: false }),
  "mbos.course.withdraw": () => ({ says: ["withdrew a training course"], changes: false }),
  "mbos.holiday.add": (c) => ({ says: ["added a holiday,", strong(str(c.a.name) ?? ""), "on", strong(shortDate(str(c.a.onDate) ?? ""))], changes: false }),
  "mbos.holiday.remove": (c) => ({ says: ["removed the holiday", strong(str(c.b.name) ?? ""), "on", strong(shortDate(str(c.b.onDate) ?? ""))], changes: false }),
  "mbos.holiday.edit": (c) => ({ says: ["changed the holiday", strong(str(c.a.name) ?? ""), "on", strong(shortDate(str(c.a.onDate) ?? ""))], changes: false }),
  "mbos.holiday.allocate": (c) => ({ says: ["gave", strong(str(c.a.person) ?? "somebody"), "the holiday", strong(str(c.a.name) ?? "")], changes: false }),
  "mbos.holiday.deallocate": (c) => ({ says: ["took the holiday", strong(str(c.a.name) ?? ""), "away from", strong(str(c.a.person) ?? "somebody")], changes: false }),
  "mbos.holiday.reset": (c) => ({ says: ["put", strong(str(c.a.person) ?? "somebody"), "back on the usual rule for", strong(str(c.a.name) ?? "")], changes: false }),
  "mbos.visit.accept": () => ({ says: ["accepted a salesman's visit as genuine"], changes: false }),
  "mbos.visit.pin.accept": (c) => ({ says: ["moved the map pin of", c.subject(), "to where the salesman checked in"], changes: false }),
  "mbos.visit.pin.reject": (c) => ({ says: ["kept the map pin of", c.subject(), "where it was"], changes: false }),
  "mbos.visit.ask": () => ({ says: ["asked a salesman about a visit"], changes: false }),
  "leave.entitlement.set": (c) => ({ says: ["set the leave entitlement of", c.user(c.e.entityId), "to", strong(plural(num(c.a.days) ?? 0, "day")), "for", strong(str(c.a.year) ?? "")], changes: false }),
  "employee.reporting_set": (c) => ({ says: ["made", c.employee(c.e.entityId), "report to", c.employee(c.a.managerId)], changes: false }),
  "employee.reporting_moved": (c) => ({ says: ["moved", c.employee(c.e.entityId), "from reporting to", c.employee(c.b.managerId), "to", c.employee(c.a.managerId)], changes: false }),
  "employee.reporting_cleared": (c) => ({ says: [c.employee(c.e.entityId), "no longer reports to", c.employee(c.b.managerId)], changes: false }),

  /* ---- access */
  "access.denied": (c) => ({
    says: ["tried to", strong(words(str(c.a.capability) ?? str(c.e.entityId) ?? "do something")), "and was stopped — they do not have access to it"],
    changes: false,
  }),
  "create-user": (c) => ({ says: ["created a MahekOne account for", c.user(c.e.entityId)], note: accessWords(c.reason()), changes: false }),
  create: (c) => ({ says: ["created a MahekOne account for", c.user(c.e.entityId)], changes: false }),
  "set-app-access": (c) => ({ says: ["changed which apps", c.user(c.e.entityId), "can open"], note: accessWords(c.reason()), changes: false }),
  "set-role": (c) => ({ says: ["changed the level of", c.user(c.e.entityId)], changes: false }),
  "issue-credential": (c) => ({ says: ["issued a sign-in password to", c.user(c.e.entityId)], note: null, changes: false }),
  "link-employee": (c) => ({ says: ["linked", c.user(c.e.entityId), "to their HR record"], changes: false }),
  "unlink-employee": (c) => ({ says: ["unlinked", c.user(c.e.entityId), "from their HR record"], changes: false }),
  "deactivate-user": (c) => ({ says: ["switched off the sign-in of", c.user(c.e.entityId)], changes: false }),
  "reactivate-user": (c) => ({ says: ["switched the sign-in of", c.user(c.e.entityId), "back on"], changes: false }),
  "update-user": (c) => ({ says: ["edited the account of", c.user(c.e.entityId)], changes: false }),
  "send-password-reset": (c) => ({ says: ["sent", c.user(c.e.entityId), "a password reset link"], changes: false }),
  "end-sessions": (c) => ({ says: ["signed", c.user(c.e.entityId), "out everywhere"], changes: false }),
  "impersonate.start": (c) => ({ says: ["made a link to sign in as", c.user(c.e.entityId)], note: null, changes: false }),
  "impersonate.enter": (c) => ({ says: ["signed in as", c.user(c.e.entityId)], note: null, changes: false }),
  "access.erp-designation.create": (c) => ({
    says: ["created the ERP designation", strong(str(c.a.name) ?? "a designation")],
    note: null,
    changes: false,
  }),
  "access.erp-designation.edit": (c) => ({
    says: [
      "changed the ERP designation",
      strong(str(c.a.name) ?? str(c.b.name) ?? "a designation"),
      ...(Array.isArray(c.a.moved) && c.a.moved.length
        ? [`— ${c.a.moved.length} ${c.a.moved.length === 1 ? "person" : "people"} moved with it`]
        : []),
    ],
    note: Array.isArray(c.a.leftAlone) && c.a.leftAlone.length ? `Left as customised: ${c.a.leftAlone.join(", ")}` : null,
    changes: false,
  }),
  "access.erp-designation.delete": (c) => ({
    says: ["deleted the ERP designation", strong(str(c.b.name) ?? "a designation")],
    note: null,
    changes: false,
  }),
  "erp.viewAs.start": (c) => ({ says: ["previewed the ERP as", strong(str(c.a.as) ?? "somebody else")], note: null, changes: false }),
  "erp.rawMaterial.duties": (c) => ({ says: ["set who requests, raises, approves and tests", c.subject()], note: null, changes: false }),
  "erp.viewAs.stop": (c) => ({ says: ["stopped previewing the ERP as", strong(str(c.b.as) ?? "somebody else")], note: null, changes: false }),
  "provision-user": (c) => ({ says: ["updated the account of", c.user(c.e.entityId), "from the team list"], changes: false }),
  "admin.identity-correction": (c) => ({ says: ["corrected whose account", c.user(c.e.entityId), "is, directly in the database"], changes: false }),
  "secret.set": (c) => ({
    says: c.e.entityId
      ? ["set the", strong(secretLabel(c.e.entityId)), "key", ...(str(c.a.last4) ? [`(ending ${str(c.a.last4)})`] : [])]
      : ["set a service key"],
    changes: false,
  }),
  "secret.clear": (c) => ({ says: c.e.entityId ? ["removed the", strong(secretLabel(c.e.entityId)), "key"] : ["removed a service key"], changes: false }),

  /* ---- settings */
  "config.update": (c) => ({
    says: c.e.entityId ? ["changed the setting", c.setting(c.e.entityId)] : ["changed a setting"],
    changes: [{ field: "Value", from: valueWords(c.b.value, c), to: valueWords(c.a.value, c) }],
  }),
  "whatsapp.service_on": () => ({ says: ["switched WhatsApp sending on"], changes: false }),
  "whatsapp.service_off": () => ({ says: ["switched WhatsApp sending off"], changes: false }),
  "whatsapp.rule_status": (c) => ({ says: ["turned a WhatsApp automation", strong(str(c.a.status) ?? "")], changes: false }),
  "whatsapp.rule_update": () => ({ says: ["edited a WhatsApp automation rule"], changes: false }),
  "whatsapp.rule_create": () => ({ says: ["added a WhatsApp automation rule"], changes: false }),
  "whatsapp.automation_window": () => ["changed when automatic WhatsApp messages may be sent"],
  "whatsapp.template_link": (c) => ({ says: ["linked a WhatsApp template to", strong(words(str(c.a.watiTemplateName) ?? "nothing"))], changes: false }),
  "expense_policy.published": (c) => ({ says: ["published the expense policy", ...(str(c.a.effectiveFrom) ? ["from", strong(shortDate(str(c.a.effectiveFrom)!))] : [])], changes: false }),
  "expense_policy.set.create": (c) => ({ says: ["created the expense policy", strong(str(c.a.name) ?? "")], changes: false }),
  "expense_policy.set.save": (c) => ({ says: ["edited the expense policy", strong(str(c.a.name) ?? "")], changes: false }),
  "expense_policy.set.activate": () => ({ says: ["switched an expense policy on"], changes: false }),
  "expense_policy.set.deactivate": () => ({ says: ["switched an expense policy off"], changes: false }),
  "expense_policy.set.delete": (c) => ({ says: ["deleted the expense policy", strong(str(c.b.name) ?? "")], changes: false }),
  "expense_policy.hometown": (c) => ({ says: ["set a salesman's hometown to", strong(str(c.a.city) ?? "nothing")], changes: false }),
  "expense_policy.set.assign": () => ({ says: ["changed which expense policy salesmen are on"], changes: false }),
  "job.run": (c) => ({ says: ["ran the job", strong(words(str(c.a.job) ?? str(c.e.entityId) ?? ""))], changes: false }),
  "job.dry_run": (c) => ({ says: ["tried the job", strong(words(str(c.a.job) ?? str(c.e.entityId) ?? "")), "without saving anything"], changes: false }),

  /* ---- sign-ins */
  "sign-in": () => ({ says: ["signed in"], changes: false }),
  "sign-in-code": () => ({ says: ["signed in with a code"], changes: false }),
  "sign-in-console": () => ({ says: ["confirmed their password to open the Admin Console"], changes: false }),
  "sign-out": () => ({ says: ["signed out"], changes: false }),
  "request-password-reset": () => ({ says: ["asked for a password reset link"], changes: false }),
  "reset-password": () => ({ says: ["reset their password with a link"], changes: false }),
  "reset-password-code": () => ({ says: ["reset their password with a code"], changes: false }),
  "sign-in-code-sent": () => ({ says: ["asked for a sign-in code"], changes: false }),
  "reset-code-sent": () => ({ says: ["asked for a password reset code"], changes: false }),
  "change-password": () => ({ says: ["changed their password"], changes: false }),
};

const appName = (id: string) => APP_REGISTRY.find((a) => a.id === id)?.name ?? id;

/**
 * The access screen writes its summary as `changed crm 17/30 → 18/30` and
 * `granted sales (26/26 modules)`: short, exact, and written for a log. This
 * says the same thing in words without losing a number.
 */
export function accessWords(detail: string | null): string | null {
  if (!detail) return null;
  return detail
    .replace(/changed ([a-z]+) (\d+)\/(\d+) → (\d+)\/(\d+)/g, (_, app, was, _of, now, of) =>
      `${appName(app)}: now ${now} of ${of} screens (was ${was})`)
    .replace(/granted ([a-z, ()\d/]+?)(?=;|$)/g, (_, list: string) =>
      `Gave ${list.replace(/([a-z]+) \((\d+)\/(\d+)(?: modules)?\)/g, (_m: string, app: string, n: string, of: string) =>
        `${appName(app)} (${n === of ? `all ${of} screens` : `${n} of ${of} screens`})`)}`)
    .replace(/revoked ([a-z, ]+)/g, (_, list: string) => `Took away ${list.split(/,\s*/).map(appName).join(", ")}`)
    .replace(/ · (associate|manager|admin) · ([a-z]+) \((\d+)\/(\d+)\)/g, (_, level, app) => ` · ${level} in ${appName(app)}`)
    .replace(/ · (telecaller|manager|admin) · ([a-z]+)$/g, (_, level, app) => ` · ${level} in ${appName(app)}`);
}

function thirdParty(c: Ctx, verb: string, tail: string): Say {
  const ids = Array.isArray(c.a.customerIds) ? (c.a.customerIds as unknown[]) : [];
  const who = ids.length > 1 ? plural(ids.length, "customer") : c.customer(ids[0] ?? c.e.entityId);
  const via = Array.isArray(c.a.distributorIds) && c.a.distributorIds.length ? ["— billed by", c.customer(c.a.distributorIds[0], "a distributor")] : [];
  return { says: [verb, who, tail, ...via], changes: false };
}

function callWord(type: unknown): string {
  const t = str(type) ?? "";
  if (t.includes("inbound")) return "took a call from";
  if (t.includes("whatsapp")) return "messaged";
  if (t.includes("visit")) return "visited";
  return "called";
}

function overriddenNote(c: Ctx): string | null {
  const o = c.a.overriddenConditions;
  return Array.isArray(o) && o.length ? `Moved past ${o.length} unmet ${o.length === 1 ? "condition" : "conditions"} on a manager's say-so` : null;
}

function journeyDates(c: Ctx): string {
  const from = str(c.a.from);
  const to = str(c.a.to);
  if (!from) return "";
  return from === to || !to ? `for ${shortDate(from)}` : `for ${shortDate(from)} – ${shortDate(to)}`;
}

function periodWords(p: unknown): string {
  const s = str(p);
  if (!s || !/^\d{4}-\d{2}$/.test(s)) return s ?? "a month";
  const [y, m] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

const SECRET_LABEL: Record<string, string> = {
  "openai.apiKey": "OpenAI",
  "sarvam.apiKey": "Sarvam",
  "anthropic.apiKey": "Anthropic",
  "olamaps.apiKey": "Ola Maps",
  "minimoth.apiKey": "sign-in codes (MiniMoth)",
  "wati.apiKey": "WhatsApp (Wati)",
  "resend.apiKey": "email (Resend)",
};
function secretLabel(name: string): string {
  return SECRET_LABEL[name] ?? cap(words(name.replace(/\.?api_?key$/i, "")));
}

/* ------------------------------------------------------------- translation */

/**
 * The words a code is made of. A code is `[app.]thing[.thing].verb` or
 * `verb-thing`; these two lists are what turn it into English. The test fails
 * on any token written in source that appears in neither, so a new code costs
 * one line here rather than a raw string on the owner's screen.
 */
const APPS: Record<string, string> = {
  erp: "the Factory app",
  hrms: "HRMS",
  mbos: "the field app",
  whatsapp: "WhatsApp",
  catalogue: "the catalogue",
  expense_policy: "the expense policy",
  expense: "the field expense desk",
};

/** Past-tense verbs. A token found here, at the END of a code, is the verb. */
export const VERBS: Record<string, string> = {
  create: "added",
  created: "added",
  add: "added",
  added: "added",
  edit: "edited",
  update: "updated",
  updated: "updated",
  set: "set",
  delete: "deleted",
  remove: "removed",
  removed: "removed",
  retire: "retired",
  restore: "restored",
  restored: "restored",
  approve: "approved",
  approved: "approved",
  reject: "rejected",
  rejected: "rejected",
  decide: "decided",
  publish: "published",
  published: "published",
  withdraw: "withdrew",
  verify: "verified",
  unverify: "un-verified",
  post: "posted",
  adjust: "adjusted",
  import: "imported",
  run: "ran",
  ack: "acknowledged",
  resolve: "resolved",
  status: "changed the status of",
  mark: "marked",
  apply: "applied",
  give: "gave",
  pay: "marked {} as paid",
  prepare: "prepared",
  remark: "added a remark to",
  remarkDelete: "deleted a remark on",
  raise: "raised",
  solve: "solved",
  feedback: "gave feedback on",
  assign: "assigned",
  accept: "accepted",
  share: "shared",
  done: "marked {} done",
  notDone: "marked {} not done",
  na: "marked {} not applicable",
  bulkDone: "marked several {0}s done",
  pending: "marked {} pending",
  send: "sent",
  log: "logged",
  review: "reviewed",
  regenerate: "regenerated",
  regeneratePayslip: "regenerated the payslip for",
  release: "released",
  qty: "changed the quantity of",
  rate: "set the rate on",
  bill: "billed",
  unbill: "un-billed",
  ready: "marked {} ready",
  amount: "changed the amount of",
  mode: "changed the payment mode of",
  packing: "changed the packing of",
  staff: "changed the staff of",
  reopen: "reopened",
  activate: "activated",
  deactivate: "deactivated",
  photo: "changed the photo of",
  idCard: "added an ID card to",
  idCardRemove: "removed the ID card from",
  signUp: "signed up",
  editSelf: "edited their own {0} record",
  checkIn: "checked in for",
  checkOut: "checked out of",
  officerCheckOut: "checked somebody out of",
  setIn: "set the check-in time on",
  takeFollowUp: "took over a follow-up on",
  takeTask: "took over a task in",
  takeMonthly: "took over a monthly to-do in",
  deactivationRequest: "asked to deactivate",
  deactivationWithdraw: "withdrew a deactivation request for",
  deactivationReject: "turned down deactivating",
  reactivate: "reactivated",
  writeOff: "wrote off",
  applySuggestion: "applied the suggested {0}",
  toTesting: "sent {} for testing",
  toPurchase: "sent {} on to purchase",
  costs: "recorded the transport and inward cost of",
  cancel: "cancelled",
  closeShort: "closed short",
  sendBack: "sent back",
  select: "selected",
  decideMethod: "decided how to buy",
  selectVendor: "chose the vendor for",
  billReceived: "marked the bill received on",
  billNotReceived: "marked the bill not received on",
  issueCn: "issued a credit note on",
  screen: "screened",
  extra: "added extra charges to",
  gst: "changed the GST on",
  notVerify: "marked {} not verified",
  workingGodown: "switched their working godown",
  window: "changed the sending window",
  dismissed: "dismissed",
  canonicalId: "chose the main code for a product in",
  skuActive: "switched a SKU on or off in",
  goodActive: "switched a finished good on or off in",
  heldNamed: "named a held product in",
  draft_created: "started a draft of",
  draft_updated: "edited the draft of",
  rule_updated: "edited a rule in",
  rule_added: "added a rule to",
  rule_removed: "removed a rule from",
  draft_archived: "archived a draft of",
  grade_mapped: "mapped a grade in",
  city_classified: "classified a city in",
  city_unclassified: "unclassified a city in",
  day_submitted_by_office: "submitted a day's expenses on behalf of a salesman in",
  day_reopened: "reopened a day's expenses in",
  day_approved: "approved a day's expenses in",
  day_rejected: "rejected a day's expenses in",
  exception_accepted: "accepted an exception in",
  exception_rejected: "rejected an exception in",
  exception_waived: "waived an exception in",
  rule_create: "added an automation rule in",
  rule_update: "edited an automation rule in",
  rule_delete: "deleted an automation rule in",
  rule_status: "switched an automation rule in",
  formulationNotes: "edited the notes on a formulation in",
  formulationOfferedForMix: "changed whether a formulation counts towards the product mix in",
  formulationMoved: "moved a formulation in",
  categoryCreated: "added a category to",
  categoryOrder: "reordered the categories in",
  alias: "added another name for a product in",
  aliasRemoved: "removed another name for a product from",
  revise: "revised",
  version: "made a new version of",
  duplicate: "copied",
  reparse: "re-read",
  header: "edited the heading of",
  price: "set a price while reading",
  confirm: "confirmed",
  ask: "asked about",
  save: "saved",
  kept: "kept",
  move: "moved",
  promote: "promoted",
  void: "voided",
  resubmit: "resubmitted",
  return: "sent back",
  call: "called",
  convertToProspect: "made a prospect of",
  migrate: "migrated",
  reassigned: "reassigned",
  deskAssigned: "assigned",
  nameDistributor: "named a distributor for",
  figuresConfirmed: "confirmed the figures on",
  gstValidate: "checked the GST number of",
  captured: "captured",
  trashed: "deleted",
  communication: "sent material to",
  sent_back: "sent back",
  requested: "requested",
  reviewed: "reviewed",
  cancelled: "cancelled",
  saved: "saved",
  agreed: "agreed",
  recorded: "recorded",
  priority: "set the priority of",
  workflow: "set the next step on",
  partially_approved: "partly approved",
  day_partially_approved: "partly approved a day's expenses in",
  exception_corrected: "corrected an exception in",
  assignmentDelete: "deleted the assignment of",
  rename: "renamed",
  reproposed: "proposed again",
  took_counter: "took the salesman's counter-proposal for",
  end: "ended",
  corrected: "corrected",
  declined: "declined",
  accepted: "accepted",
  underProcess: "marked {} under process",
  approveParty: "approved the party on",
  formulationActive: "switched a formulation on or off in",
  brandActive: "switched a brand on or off in",
  categoryActive: "switched a category on or off in",
  hold: "put on hold",
  scan: "scanned for dispatch",
  unscan: "took off a dispatch",
  overrideRequest: "asked for a dispatch override on",
  overrideApprove: "approved a dispatch override on",
  overrideDecline: "declined a dispatch override on",
  qcApprove: "passed QC on",
  qcReject: "failed QC on",
  labelLoose: "labelled loose units of",
  labelPrint: "printed labels for",
};

/** Nouns. A code's middle tokens are looked up here. */
export const NOUNS: Record<string, string> = {
  rawMaterial: "raw material",
  supplier: "supplier",
  product: "product",
  customer: "customer",
  myCustomer: "customer",
  godown: "godown",
  ref: "reference list value",
  refList: "reference list value",
  transfer: "stock transfer",
  rmLevel: "raw-material stock level",
  fgLevel: "finished-goods stock level",
  sfg: "semi-finished batch",
  unit: "box",
  dispatch: "box",
  fg: "finished-goods fill",
  pack: "packing entry",
  requisition: "purchase requirement",
  quotation: "quotation",
  purchaseOrder: "purchase order",
  inward: "goods inward",
  test: "quality test",
  purchase: "purchase",
  recipe: "recipe",
  order: "order",
  batchCode: "batch code",
  detail: "order line",
  transport: "transport entry",
  credit: "credit entry",
  expense: "expense",
  video: "video",
  alert: "stock alert",
  alerts: "stock alerts check",
  request: "complaint request",
  ai: "AI-read",
  pricelist: "price list",
  bill: "supplier bill",
  complaint: "complaint",
  lr: "lorry receipt",
  photo: "photograph",
  inbox: "order inbox entry",
  attendance: "attendance",
  leave: "leave request",
  leaveCredit: "leave credit",
  holiday: "holiday",
  overtime: "overtime entry",
  monthly: "monthly attendance sheet",
  help: "help request",
  grievance: "grievance",
  document: "document",
  notification: "notice",
  salary: "salary",
  advance: "salary advance",
  employee: "employee",
  office: "office",
  timing: "staff timing",
  asset: "asset",
  assignmentDelete: "asset assignment",
  kpi: "KPI",
  points: "performance points",
  calling: "calling record",
  activity: "activity",
  journey: "journey",
  tasks: "",
  template: "task template",
  checklist: "checklist item",
  todo: "to-do",
  buddy: "buddy task",
  sku: "SKU",
  category: "category",
  role: "role",
  brand: "brand",
  good: "finished good",
  formulation: "formulation",
  rate: "rate",
  scope: "customer group",
  discount: "discount",
  parse: "reading",
  sheet: "sheet",
  automation: "WhatsApp automation",
  approval: "field request",
  evidence: "expense evidence",
  visit: "visit",
  pin: "map pin",
  priceList: "field price list",
  scheme: "scheme",
  lead: "lead",
  task: "task",
  course: "training course",
  device: "handset",
  salesman: "salesman",
  manager: "manager",
  qualification: "qualification",
  qualificationReview: "qualification review",
  prospectFields: "prospect details",
  prospectRequest: "prospect request",
  suspect: "suspect",
  firstOrder: "first order",
  stage: "stage",
  callingDesk: "calling desk record",
  salesType: "sales type",
  nextAction: "next action",
  basics: "basic details",
  source: "lead source",
  distributor: "distributor",
  profile: "distributor profile",
  terms: "distributor terms",
  agreement: "distributor agreement",
  sample: "sample",
  canonicalId: "product",
  heldNamed: "product",
  categoryCreated: "category",
  import: "catalogue",
  duplicate: "duplicate",
};

/**
 * Turns a code with no written entry into a sentence from the two lists.
 *
 * Returns the tokens it did not recognise too — the screen ignores them and
 * prints its best attempt, while the test fails on any, which is the split
 * that keeps an unknown code readable today and named tomorrow.
 */
export function translate(action: string): { says: string; unknown: string[] } {
  const unknown: string[] = [];
  const noun = (t: string) => NOUNS[t] ?? (unknown.push(t), words(t));
  let parts = action.split(".");
  let app: string | null = null;
  if (parts.length > 1 && APPS[parts[0]]) {
    app = APPS[parts[0]];
    parts = parts.slice(1);
  }
  /* `set-role`, `link-employee`: a verb first, joined by hyphens. */
  if (parts.length === 1 && parts[0].includes("-")) {
    const [v, ...rest] = parts[0].split("-");
    const verb = VERBS[v] ?? (unknown.push(v), words(v));
    return { says: [verb, aOrAn(rest.map(noun).join(" "))].filter(Boolean).join(" "), unknown };
  }
  const last = parts[parts.length - 1];
  let verb = VERBS[last];
  let nounTokens = parts.slice(0, -1);
  if (!verb && parts.length === 1 && NOUNS[last]) {
    /* `catalogue.sku`, `catalogue.brand`: the thing alone means it was edited. */
    verb = "edited";
    nounTokens = parts;
  } else if (!verb && parts.length > 2 && VERBS[parts[parts.length - 2]]) {
    /* `erp.purchase.billReceived.bulk`: a qualifier after the verb. */
    verb = `${VERBS[parts[parts.length - 2]]} (${words(last)})`;
    nounTokens = parts.slice(0, -2);
  } else if (!verb) {
    unknown.push(last);
    verb = words(last);
  }
  const bare = nounTokens.map(noun).filter(Boolean).join(" ");
  const object = aOrAn(bare);
  const where = app ? `in ${app}` : "";
  /* `{}` puts the object inside the phrase ("marked {} done"), `{0}` without
     its article ("applied the suggested {0}"). */
  if (/\{0?\}/.test(verb)) {
    const placed = verb.replace("{0}", bare || "item").replace("{}", object || "it");
    return { says: [placed, where].filter(Boolean).join(" "), unknown };
  }
  /* A verb that ends on a preposition ("added a rule to") takes the app as
     its object when nothing else is named; any other names the thing and
     then where it happened. */
  const tail = /\b(in|to|from|of|on|for)$/.test(verb)
    ? object || app || ""
    : [object, where].filter(Boolean).join(" ");
  const qualifier = /\((\w+)\)$/.exec(verb);
  if (qualifier) return { says: [verb.replace(/ \(\w+\)$/, ""), tail, `(${qualifier[1]})`].filter(Boolean).join(" "), unknown };
  return { says: [verb, tail].filter(Boolean).join(" "), unknown };
}

function aOrAn(noun: string): string {
  if (!noun) return "";
  if (/^(attendance|stock alerts|performance points)/.test(noun)) return noun;
  return `${/^[aeiouAEIOU]/.test(noun) ? "an" : "a"} ${noun}`;
}

/* ----------------------------------------------------------------- changes */

/** What every write touches and no reader asks about. */
const NOISE = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "createdById",
  "updatedById",
  "updatedByName",
  "amDecidedAt",
  "p",
  "aiFilled",
]);

const FIELD_LABEL: Record<string, string> = {
  gstin: "GST number",
  creditTermDays: "Credit term (days)",
  creditDays: "Credit days",
  cycleDays: "Buying cycle (days)",
  salesAmId: "Salesperson",
  backOfficeAmId: "Back office",
  ownerId: "Owner",
  leadManagerId: "Lead manager",
  managerId: "Reports to",
  assignedToUserId: "Assigned to",
  salesManagerId: "Sales manager",
  ratePaise: "Rate",
  discountBp: "Discount",
  gstBp: "GST",
  qtyCans: "Cans",
  slaDueAt: "Due by",
  leadPriority: "Priority",
  whatsappPhone: "WhatsApp number",
  tallyBillNo: "Tally bill number",
};

function fieldLabel(key: string): string {
  return FIELD_LABEL[key] ?? cap(words(key.replace(/(Paise|Bp|Id)$/, "")));
}

function valueWords(v: unknown, c: Ctx, key = ""): string {
  if (v === null || v === undefined || v === "") return "not set";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (/Paise$|^amount$/.test(key)) return money(v);
    if (/Bp$/.test(key)) return `${(v / 100).toLocaleString("en-IN")}%`;
    return v.toLocaleString("en-IN");
  }
  if (typeof v === "string") {
    if (/^usr_/.test(v)) return c.n.users[v] ?? "an account";
    if (/^cus_/.test(v)) return c.n.customers[v] ?? "a customer";
    if (/^emp_/.test(v)) return c.n.employees[v] ?? "an employee";
    if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) return shortDate(v);
    return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  }
  if (Array.isArray(v)) {
    if (!v.length) return "none";
    if (v.every((x) => typeof x !== "object" || x === null)) return v.map((x) => valueWords(x, c)).join(", ");
    return plural(v.length, "item");
  }
  return "changed";
}

/**
 * Before against after, field by field. Where only one side exists the row is
 * a creation or a deletion and the facts on it are listed as set or cleared.
 */
function diffStates(before: unknown, after: unknown, c: Ctx, limit = 10): Change[] {
  const b = obj(before);
  const a = obj(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter(
    (k) => !NOISE.has(k) && !["detail", "reason", "note", "remark"].includes(k),
  );
  const out: Change[] = [];
  for (const k of keys) {
    const inB = k in b;
    const inA = k in a;
    /* Only one side named this field: a creation lists it, an update that
       simply did not record the old value says what it is now. */
    if (inA && inB && JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
    const to = inA ? valueWords(a[k], c, k) : "removed";
    const from = inB ? valueWords(b[k], c, k) : "";
    if (!inB && to === "not set") continue;
    out.push({ field: fieldLabel(k), from, to });
    if (out.length >= limit) break;
  }
  return out;
}

/* --------------------------------------------------------------- describe */

export function describeAudit(e: AuditEvent, names: AuditNames): Description {
  const c = new Ctx(e, names);
  const written = DESCRIBE[e.action];
  if (written) {
    const r = written(c);
    const say: Say = Array.isArray(r) ? { says: r } : r;
    return {
      says: say.says.filter((p) => p !== ""),
      note: say.note === undefined ? c.reason() : say.note,
      changes: say.changes === false ? [] : (say.changes ?? diffStates(e.before, e.after, c)),
      translated: false,
    };
  }
  const t = translate(e.action);
  const subject = e.subjectId ?? (e.entityId && /^cus_/.test(e.entityId) ? e.entityId : null);
  const about = subject ? c.customer(subject, "") : "";
  return {
    says: [t.says, ...(about ? ["for", about] : [])],
    note: c.reason(),
    changes: diffStates(e.before, e.after, c),
    translated: true,
  };
}

/** Has a sentence of its own, rather than a translation. */
export function isDescribed(action: string): boolean {
  return action in DESCRIBE;
}

/** Plain text of a sentence, for search and for the page title of a row. */
export function piecesText(pieces: Piece[]): string {
  return pieces
    .map((p) => (typeof p === "string" ? p : "strong" in p ? p.strong : p.name))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,)])/g, "$1")
    .replace(/\(\s+/g, "(");
}

/**
 * Every id worth a name, from the entity and from both states. The service
 * resolves these in one query per kind, so a page of a hundred rows costs
 * three lookups rather than three hundred.
 */
export function idsToResolve(rows: ReadonlyArray<{ entityId: string | null; subjectId: string | null; actorId: string | null; before: unknown; after: unknown }>) {
  const users = new Set<string>();
  const customers = new Set<string>();
  const employees = new Set<string>();
  const visit = (v: unknown, depth = 0) => {
    if (depth > 3 || v === null || v === undefined) return;
    if (typeof v === "string") {
      if (/^usr_/.test(v)) users.add(v);
      else if (/^cus_/.test(v)) customers.add(v);
      else if (/^emp_/.test(v)) employees.add(v);
      return;
    }
    if (Array.isArray(v)) return v.slice(0, 50).forEach((x) => visit(x, depth + 1));
    if (typeof v === "object") Object.values(v as Obj).forEach((x) => visit(x, depth + 1));
  };
  for (const r of rows) {
    [r.entityId, r.subjectId, r.actorId, r.before, r.after].forEach((v) => visit(v));
  }
  return { users: [...users], customers: [...customers], employees: [...employees] };
}
