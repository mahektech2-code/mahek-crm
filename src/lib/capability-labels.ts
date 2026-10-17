import type { AppId } from "./apps";
import { CAPABILITIES, can, type Capability } from "./capability-matrix";
import { modulesForApp } from "./modules";
import type { Role } from "./role-levels";

/* ---------------------------------------------------------------------------
 * WHAT A LEVEL CARRIES, IN WORDS, READ OFF THE REAL MATRIX.
 *
 * The Access dialog asks "Associate, Manager or Admin?" beside every app, and
 * for as long as it has asked, the answer was a word with nothing under it.
 * Whoever was choosing had to know — from memory, or from AGENTS.md — that a
 * CRM manager may deactivate a customer and an Accounts manager may approve an
 * order and a CRM manager may not. That is the decision with the largest
 * consequence on the page, made blind.
 *
 * So the screen says it, and it says it from `capability-matrix.ts` — the
 * same table `can()` reads on the server — rather than from a sentence typed
 * beside the select. A typed sentence is a second answer to "what does an
 * Accounts associate hold", and the copy that drifts is always the one being
 * read at the moment somebody decides.
 *
 * PURE AND CLIENT-SAFE, like the matrix itself: the dialog is a client
 * component.
 *
 * A `Record` over every capability, so a capability added to the matrix fails
 * the build here until somebody says in plain English what it lets a person
 * do. A capability the screen cannot name is one a person can be granted
 * without anybody being told.
 * ------------------------------------------------------------------------- */

export const CAPABILITY_LABELS: Record<Capability, string> = {
  "customer.read": "Read customer records",
  "customer.write": "Edit customer records",
  "customer.export": "Export customer lists",
  "customer.deactivate": "Deactivate customers",
  "lead.trash": "Move leads to the trash",
  "lead.restore": "Restore leads from the trash",
  "call.log": "Log calls",
  "order.capture": "Take orders",
  "reminder.write": "Set reminders",
  "reminder.close": "Close a reminder by hand",
  "target.set": "Set and publish targets",
  "target.shortfall": "Read target shortfalls",
  "complaint.resolve": "Resolve complaints",
  "whatsapp.bulk": "Send WhatsApp in bulk",
  "whatsapp.template.write": "Write WhatsApp templates",
  "team.report": "Read the whole team's reports",
  "config.write": "Change settings",
  "order.approve": "Approve and decline orders",
  "payment.record": "Record a payment",
  "payment.confirm": "Confirm, hold and reverse payments",
  "creditnote.issue": "Issue credit notes",
  "sheet.import": "Run the sheet imports",
  "customer.reassign": "Move accounts between salespeople",
  "customer.assignSalesManager": "Name an account's sales manager",
  "customer.handOver": "Hand converted accounts over",
  "customer.classify": "Mark shops as third-party customers",
  "lead.gstValidate": "Check a lead's GSTIN",
  "expense.policy.write": "Draft the expense policy",
  "expense.policy.publish": "Publish the expense policy",
  "lead.work": "Work leads",
  "lead.override": "Pass a lead through a shut gate",
  "lead.verify": "Verify qualified leads",
  "sample.approve": "Approve samples",
  "distributor.terms": "Set a distributor's terms",
  "distributor.approve": "Appoint distributors",
  "pricelist.read": "Read price lists",
  "pricelist.manage": "Change price lists",
  "whatsapp.activate": "Switch WhatsApp sending on and off",
  "access.manage": "Change who can open what",
};

/** What a hat holds, capability by capability, off the one table. */
function heldBy(app: AppId, level: Role): Capability[] {
  return CAPABILITIES.filter((c) => can({ app, role: level }, c));
}

/*
 * WHAT EVERYBODY HOLDS, which is therefore not worth saying about anybody.
 *
 * Asked of a hat with no app at all: whatever it still holds, every signed-in
 * person holds — today that is recording a payment, the one SHARED
 * capability. Listing it under every level of every app would put the same
 * line beside eleven selects and teach the reader to skip the list.
 */
const EVERYBODY: ReadonlySet<Capability> = new Set(
  CAPABILITIES.filter((c) => can({ app: null, role: "associate" }, c)),
);

/*
 * THE BOOK'S ORDINARY WORK — reading and editing customers, logging calls,
 * taking orders, setting reminders, working leads — said as ONE line.
 *
 * Derived rather than listed: it is whatever every app that works the book
 * hands its associates, which is `BOOK_WORK` in the matrix. Seven separate
 * lines of it would bury the two that actually separate a manager from an
 * associate, and those two are the reason the list is on the screen.
 */
const BOOK_APPS: readonly AppId[] = ["crm", "sales", "field"];
const BOOK: readonly Capability[] = CAPABILITIES.filter(
  (c) => !EVERYBODY.has(c) && BOOK_APPS.every((app) => can({ app, role: "associate" }, c)),
);
export const BOOK_LINE = "Works the book — customers, calls, orders, reminders and leads";

/** The apps whose levels are not where their power lives. */
const POWER_APPS: Partial<Record<AppId, string>> = {
  hrms: "HRMS",
  erp: "ERP",
};

/**
 * What choosing this level on this app lets somebody DO, as short lines for
 * the Access dialog, beyond what every signed-in person can do already.
 *
 * Never empty: a level that carries nothing beyond the screens says so,
 * because a blank space under a select reads as "still loading" rather than
 * as "nothing".
 */
export function levelCarries(app: AppId, level: Role): string[] {
  /* The one hat that is not about its own app. */
  if (app === "admin" && level === "admin") {
    return [
      "Everything, in every app — this is the platform administrator",
      CAPABILITY_LABELS["access.manage"],
    ];
  }

  const powerApp = POWER_APPS[app];
  if (powerApp) {
    /* HRMS and the ERP decide what somebody may DO by their powers, granted a
       person at a time below, and neither has a capability in the matrix. The
       level says how much of the app's own reach they have; the administrator
       is the one level that holds every power without a tick. */
    return level === "admin"
      ? [`Every ${powerApp} power, without a tick`]
      : [`Does what the ${powerApp} powers ticked below allow, on the screens ticked below`];
  }

  const held = heldBy(app, level).filter((c) => !EVERYBODY.has(c));
  const lines: string[] = [];
  const worksBook = BOOK.length > 0 && BOOK.every((c) => held.includes(c));
  if (worksBook) lines.push(BOOK_LINE);
  for (const c of held) {
    if (worksBook && BOOK.includes(c)) continue;
    lines.push(CAPABILITY_LABELS[c]);
  }

  /* WHAT ADMIN ADDS ON ANY OTHER APP. It holds that app's manager
     capabilities — `can()` reads an admin hat against its own app — so the
     list above is identical to the manager's, and without this line the two
     options would read as the same choice. What the administrator does get
     is every screen the app hands out a person at a time (`offByDefault`),
     whatever is ticked; a seat marked `explicitOnly` still has to be ticked
     for them like for anybody, so it is not promised here. */
  if (level === "admin") {
    const handedOut = modulesForApp(app).filter((m) => m.offByDefault && !m.explicitOnly);
    if (handedOut.length) {
      lines.push(`Also opens ${handedOut.map((m) => m.label).join(", ")}, whatever is ticked`);
    }
  }

  return lines.length ? lines : ["Opens the screens ticked below, and nothing more"];
}
