import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { OUTCOMES_BY_TYPE, OUTCOME_LABEL } from "@/db/catalogue";
import { FOLLOW_UP_REASONS, NO_ANSWER_REASONS, NO_ORDER_REASONS } from "@/lib/call-outcomes";
import { COMPLAINT_PRIORITIES } from "@/lib/complaint-labels";
import { saveInteractionAction, createCustomer, logComplaint, sendWhatsAppNow, queueMessage } from "@/lib/actions/crm";
import { createReminder as createReminderService } from "@/lib/services/worklist-services";
import { recordReceiptAction } from "@/lib/actions/payments";
import { decidePriceRequest } from "@/lib/actions/price-lists";
import { whatsappServiceState } from "@/lib/services/whatsapp-switch-service";
import { parseRupees } from "@/lib/format";
import { crore } from "./format";
import { fromOwning, refusal, type Ctx } from "./provider";
import { providerFor } from "./registry";
import type { FormSpec, Result, SectionKey } from "./types";

/* ---------------------------------------------------------------------------
 * THE DESIGN'S EIGHT QUICK ACTIONS — "Start from anywhere" — each running the
 * owning app's own action (PRD §6.5, P15). The forms carry real options:
 * payment modes and complaint categories from configuration, the approved
 * templates, the requests actually waiting, the sources actually syncable.
 * ------------------------------------------------------------------------- */

export const QUICK_ITEMS: [string, string][] = [
  ["Log a call or an order received", "Pick the customer, then the outcome"],
  ["Record a payment", "Confirmed at once when you enter it"],
  ["Raise a complaint", "Routed to the owning desk"],
  ["Set a reminder", "For you or for someone else"],
  ["Create a lead or a customer", "Checked for duplicates first"],
  ["Send a WhatsApp message", "Through the API or prepared to paste"],
  ["Approve a special price", "From the requests waiting"],
  ["Run a sync", "Order sheet, HR sheet or customer master"],
];

/**
 * WHICH SECTION EACH QUICK ACTION ACTS IN, by index into `QUICK_ITEMS`.
 *
 * The quick actions run the owning app's own action, and that action asks its
 * own capability — but a capability rides on the APP grant, not on the Command
 * Centre module, so a delegate narrowed to Money could still raise a complaint
 * or send a WhatsApp message from here. Each item is an act in one section and
 * is asked as one, through `requireActIn`, exactly as a row action is. The two
 * desks associates have always run (WhatsApp and price lists) keep that through
 * the same function rather than through an index check of their own.
 */
export const QUICK_SECTION: readonly SectionKey[] = [
  "calling", // log a call or an order received
  "money", // record a payment
  "service", // raise a complaint
  "calling", // set a reminder
  "customers", // create a lead or a customer
  "whatsapp", // send a WhatsApp message
  "prices", // approve a special price
  "system", // run a sync
];

const opt = (v: string, l?: string) => ({ v, l: l ?? v });

export async function quickForm(ctx: Ctx, index: number): Promise<FormSpec> {
  const config = await getConfig();
  const day = await today();
  switch (index) {
    case 0: {
      const outcomes = [...new Set([...OUTCOMES_BY_TYPE.outbound_call, ...OUTCOMES_BY_TYPE.inbound_call])];
      const orderish = ["order_taken"];
      return {
        title: "Log a call or an order received",
        sub: "Logged as you, against the customer’s timeline",
        submit: "Log it",
        fields: [
          { k: "cust", label: "Customer", type: "customer", search: "any", req: true, ph: "Search by name, city or phone" },
          { k: "how", label: "How it happened", type: "select", req: true, options: [opt("outbound_call", "We called them"), opt("inbound_call", "They called us"), opt("order_received", "Order received, no call")] },
          { k: "out", label: "Outcome", type: "select", req: true, options: outcomes.map((o) => opt(o, OUTCOME_LABEL[o])), when: { k: "how", in: ["outbound_call", "inbound_call"] } },
          { k: "callerRole", label: "Who called", type: "select", req: true, when: { k: "how", in: ["inbound_call"] }, options: ["Owner / Proprietor", "Purchase Person", "Accounts Person", "Store / Warehouse", "Production", "Other"].map((x) => opt(x)) },
          { k: "callReason", label: "Why did they call", type: "select", req: true, when: { k: "how", in: ["inbound_call"] }, options: ["Place an Order", "Price / Quotation", "Product Enquiry", "Stock Availability", "Payment / Outstanding", "Delivery / Transport", "Complaint", "Product / Technical Support", "Follow-up on Previous Discussion", "Other"].map((x) => opt(x)) },
          { k: "whyNoOrder", label: "Why no order", type: "select", req: true, when: { k: "out", in: ["no_order"] }, options: NO_ORDER_REASONS.map((r) => opt(r.code, r.label)) },
          { k: "noOrderNext", label: "When do we call back", type: "date", when: { k: "out", in: ["no_order"] }, hint: "Leave it empty if they would not commit to a date." },
          { k: "whyNoAnswer", label: "Why no answer", type: "select", req: true, when: { k: "out", in: ["no_answer"] }, options: NO_ANSWER_REASONS.map((r) => opt(r.code, r.label)) },
          { k: "followUpReason", label: "What are we waiting for", type: "select", req: true, when: { k: "out", in: ["follow_up"] }, options: FOLLOW_UP_REASONS.map((r) => opt(r.code, r.label)) },
          { k: "followUpDate", label: "Follow-up date", type: "date", req: true, when: { k: "out", in: ["follow_up"] }, hint: "It becomes a reminder you will see on the day." },
          { k: "promiseDate", label: "Payment date", type: "date", when: { k: "out", in: ["payment_promised"] } },
          { k: "orderDate", label: "Order date", type: "date", req: true, when: { k: "how", in: ["order_received"] } },
          { k: "p1", label: "Product", type: "product", when: { k: "out", in: orderish } },
          { k: "q1", label: "Cans", type: "number", when: { k: "out", in: orderish } },
          { k: "p2", label: "Second product", type: "product", when: { k: "out", in: orderish } },
          { k: "q2", label: "Cans", type: "number", when: { k: "out", in: orderish } },
          { k: "note", label: "Notes", type: "area", ph: "What was said" },
        ],
        init: { how: "outbound_call", out: "order_taken", orderDate: day },
      };
    }
    case 1:
      return {
        title: "Record a payment",
        sub: "Money you have seen in the bank",
        submit: "Record and confirm",
        consequence: "Recorded as confirmed: the oldest open bills are settled first, outstanding drops, and the customer leaves the collections list.",
        fields: [
          { k: "cust", label: "Customer", type: "customer", search: "customer", req: true, ph: "Search by name, city or phone" },
          { k: "amt", label: "Amount received (₹)", type: "money", ph: "1,00,000", req: true },
          { k: "mode", label: "How", type: "select", req: true, options: config["payments.modes"].map((m) => opt(m)) },
          { k: "ref", label: "Reference", cond: "needed unless cash", ph: "UTR or cheque number", hint: "This is how accounts finds it in the bank statement again." },
          { k: "chequeDate", label: "Date on the cheque", type: "date", when: { k: "mode", in: config["payments.datedModes"] } },
          { k: "on", label: "Received on", type: "date", req: true },
        ],
        init: { mode: config["payments.modes"][0] ?? "", on: day },
      };
    case 2:
      return {
        title: "Raise a complaint",
        sub: `The ${config["complaints.slaHours"][config["complaints.defaultSeverity"]]}-hour clock starts when you save`,
        submit: "Raise it",
        fields: [
          { k: "cust", label: "Customer", type: "customer", search: "any", req: true, ph: "Search by name, city or phone" },
          { k: "cat", label: "Category", type: "select", req: true, options: config["complaints.categories"].map((c) => opt(c)) },
          { k: "desc", label: "What happened", type: "area", req: true, ph: "Two drums arrived with broken seals" },
          { k: "prio", label: "Priority", type: "select", req: true, options: COMPLAINT_PRIORITIES.map((p) => opt(p.value, p.label)) },
        ],
        init: { cat: config["complaints.categories"][0] ?? "", prio: "medium" },
      };
    case 3:
      return {
        title: "Set a reminder",
        sub: "It appears on their dashboard on the day",
        submit: "Set reminder",
        fields: [
          { k: "who", label: "For", type: "person", search: "staff", ph: "You, unless you pick somebody" },
          { k: "cust", label: "Customer", type: "customer", search: "any", req: true, ph: "Search by name, city or phone" },
          { k: "due", label: "Due", type: "date", req: true },
          { k: "what", label: "What was promised", type: "area", req: true, ph: "Call back with the revised drum rate" },
        ],
        init: { due: day },
      };
    case 4:
      return {
        title: "Create a lead or a customer",
        sub: "Matched against existing phone numbers and names before it is saved",
        submit: "Create",
        consequence: "It is created as a lead either way: a shop becomes a customer on its first order, never by being typed in.",
        fields: [
          { k: "type", label: "Create as", type: "select", req: true, options: [opt("Lead"), opt("Customer")] },
          { k: "name", label: "Business name", req: true, ph: "Siddhi Colour Centre" },
          { k: "contact", label: "Contact person", ph: "Rahul Deshmukh" },
          { k: "phone", label: "Mobile", req: true, ph: "98230 11224" },
          { k: "city", label: "City", req: true, ph: "Amravati" },
        ],
        init: { type: "Lead" },
      };
    case 5: {
      const [templates, state] = await Promise.all([
        db.execute<{ id: string; name: string }>(sql`select id, name from wa_templates where active order by name`),
        whatsappServiceState(),
      ]);
      return {
        title: "Send a WhatsApp message",
        sub: "Only the approved templates can be sent",
        submit: "Send",
        consequence: state.active
          ? "The switch is ON: a template linked to Wati goes through the API; anything else is prepared for you to paste."
          : "The switch is OFF, so this will be prepared for you to paste, not sent through the API.",
        fields: [
          { k: "cust", label: "Customer", type: "customer", search: "any", req: true, ph: "Search by name, city or phone" },
          { k: "tpl", label: "Template", type: "select", req: true, options: templates.map((t) => opt(t.id, t.name)) },
        ],
        init: { tpl: templates[0]?.id ?? "" },
      };
    }
    case 6: {
      const reqs = await db.execute<{ id: string; name: string; product: string; asked: string }>(sql`
        select r.id, c.name, p.name as product, r.requested_rate_ex_gst_paise::text as asked
          from price_requests r join customers c on c.id = r.customer_id join products p on p.id = r.product_id
         where r.status = 'pending' order by r.created_at
      `);
      return {
        title: "Decide a special price request",
        sub: reqs.length ? `${reqs.length} waiting on you` : "Nothing is waiting on you",
        submit: "Save decision",
        fields: [
          { k: "req", label: "Request", type: "select", req: true, options: reqs.map((r) => opt(r.id, `${r.name} · ${r.product} · ${crore(Number(r.asked))} ex-GST`)) },
          { k: "dec", label: "Decision", type: "select", req: true, options: [opt("approved", "Approve"), opt("refused", "Refuse")] },
          { k: "why", label: "Reason", cond: "needed to refuse", type: "area", ph: "Seen by the telecaller, who rings the shop back" },
        ],
        init: { req: reqs[0]?.id ?? "", dec: "approved" },
      };
    }
    default: {
      const sys = await providerFor("system");
      const payload = await sys.section(ctx);
      const t = payload.tables.find((x) => (x.acts ?? []).some((a) => a.key === "run"));
      const sources = t?.page.rows.filter((r) => !r.acts || r.acts.includes("run")) ?? [];
      return {
        title: "Run a sync",
        sub: "Every run writes a result record",
        submit: "Start",
        fields: [
          { k: "src", label: "Source", type: "select", req: true, options: sources.map((r) => opt(`${t!.key}|${r.id}`, r.cells[0]?.t ?? r.id)) },
          { k: "mode", label: "Mode", type: "select", req: true, options: [opt("dry", "Dry run — show what would change"), opt("run", "Run now — write the changes")] },
        ],
        init: { src: sources[0] ? `${t!.key}|${sources[0].id}` : "", mode: "dry" },
      };
    }
  }
}

function need(fe: Record<string, string>, k: string, v: string | undefined, msg: string) {
  if (!v || !String(v).trim()) fe[k] = msg;
}

export async function quickRun(ctx: Ctx, index: number, v: Record<string, string>): Promise<Result> {
  const fe: Record<string, string> = {};
  try {
    switch (index) {
      case 0: {
        need(fe, "cust", v.cust, "Customer is needed");
        if (Object.keys(fe).length) return { ok: false, error: "Not saved yet", fieldErrors: fe };
        const how = v.how as "outbound_call" | "inbound_call" | "order_received";
        const quantities: Record<string, number> = {};
        for (const [p, q] of [["p1", "q1"], ["p2", "q2"]] as const) {
          if (v[p]) quantities[v[p]] = Math.round(Number(v[q] || 0));
        }
        const outcome = how === "order_received" ? null : v.out;
        const outcomeDetail: Record<string, string> = {};
        if (outcome === "no_order" && v.whyNoOrder) outcomeDetail.whyNoOrder = v.whyNoOrder;
        if (outcome === "no_answer" && v.whyNoAnswer) outcomeDetail.whyNoAnswer = v.whyNoAnswer;
        if (outcome === "follow_up" && v.followUpReason) outcomeDetail.followUpReason = v.followUpReason;
        const r = await saveInteractionAction({
          customerId: v.cust,
          interactionType: how,
          outcome,
          notes: v.note ?? "",
          productQuantities: Object.keys(quantities).length ? quantities : undefined,
          followUpDate: outcome === "follow_up" ? v.followUpDate : undefined,
          noOrderNextCallDate: outcome === "no_order" && v.noOrderNext ? v.noOrderNext : undefined,
          noOrderNoCommitment: outcome === "no_order" && !v.noOrderNext ? true : undefined,
          paymentPromiseDate: outcome === "payment_promised" && v.promiseDate ? v.promiseDate : undefined,
          callerRole: how === "inbound_call" ? v.callerRole : undefined,
          callReason: how === "inbound_call" ? v.callReason : undefined,
          outcomeDetail: Object.keys(outcomeDetail).length ? outcomeDetail : undefined,
          orderDate: how === "order_received" ? v.orderDate : undefined,
          idempotencyKey: `cc-${randomUUID()}`,
        } as Parameters<typeof saveInteractionAction>[0]);
        return fromOwning(r, `Logged · ${outcome ? OUTCOME_LABEL[outcome as keyof typeof OUTCOME_LABEL] : "Order received"}`);
      }
      case 1: {
        need(fe, "cust", v.cust, "Customer is needed");
        const paise = parseRupees(v.amt ?? "");
        if (!paise || paise <= 0) fe.amt = "Enter an amount above zero";
        need(fe, "mode", v.mode, "How is needed");
        need(fe, "on", v.on, "Received on is needed");
        if (v.mode && !/cash/i.test(v.mode) && !v.ref?.trim()) fe.ref = "A reference is needed for this mode";
        if (Object.keys(fe).length) return { ok: false, error: "Not saved yet", fieldErrors: fe };
        const r = await recordReceiptAction({
          customerId: v.cust,
          amount: paise!,
          receivedAt: v.on,
          mode: v.mode,
          reference: v.ref || undefined,
          instrumentDate: v.chequeDate || undefined,
          source: "accounts",
          idempotencyKey: `cc-${randomUUID()}`,
        });
        return fromOwning(r, `${crore(paise!)} recorded`);
      }
      case 2: {
        need(fe, "cust", v.cust, "Customer is needed");
        need(fe, "desc", v.desc, "Say what happened, in the customer’s words");
        if (Object.keys(fe).length) return { ok: false, error: "Not saved yet", fieldErrors: fe };
        const r = await logComplaint({ customerId: v.cust, category: v.cat, description: v.desc, priority: v.prio });
        return fromOwning(r, "Complaint raised");
      }
      case 3: {
        need(fe, "cust", v.cust, "Customer is needed");
        need(fe, "due", v.due, "Due is needed");
        need(fe, "what", v.what, "Write what was promised — this is what they will read back later");
        if (Object.keys(fe).length) return { ok: false, error: "Not saved yet", fieldErrors: fe };
        const r = await createReminderService({ customerId: v.cust, dueDate: v.due, note: v.what, assignedUserId: v.who || undefined }, { skipCustomerScope: true });
        return fromOwning(r, `Reminder set for ${v.due}`);
      }
      case 4: {
        const digits = (v.phone ?? "").replace(/\D/g, "").slice(-10);
        const r = await createCustomer({ name: v.name, contactPerson: v.contact, phone: digits, city: v.city, leadSource: "Founder Command Centre" });
        return fromOwning(r, `Lead created · ${v.name}, ${v.city}`);
      }
      case 5: {
        need(fe, "cust", v.cust, "Customer is needed");
        need(fe, "tpl", v.tpl, "Template is needed");
        if (Object.keys(fe).length) return { ok: false, error: "Not saved yet", fieldErrors: fe };
        const state = await whatsappServiceState();
        if (state.active) {
          const sent = await sendWhatsAppNow({ customerId: v.cust, templateId: v.tpl });
          if (sent.ok) return { ok: true, message: "Sent through the WhatsApp API" };
        }
        const [tpl] = await db.execute<{ body: string }>(sql`select body from wa_templates where id = ${v.tpl}`);
        const r = await queueMessage({ customerId: v.cust, templateId: v.tpl, body: tpl?.body ?? "", edited: false, destKind: "personal" });
        return fromOwning(r, "Prepared to paste · confirm it once sent, on the WhatsApp desk");
      }
      case 6: {
        need(fe, "req", v.req, "Request is needed");
        if (v.dec === "refused" && !v.why?.trim()) fe.why = "Say why — the telecaller has to repeat it";
        if (Object.keys(fe).length) return { ok: false, error: "Not saved yet", fieldErrors: fe };
        const r = await decidePriceRequest(v.req, { decision: v.dec as "approved" | "refused", note: v.why || undefined });
        return fromOwning(r, v.dec === "approved" ? "Approved" : "Refused");
      }
      default: {
        need(fe, "src", v.src, "Source is needed");
        if (Object.keys(fe).length) return { ok: false, error: "Not saved yet", fieldErrors: fe };
        const [table, id] = String(v.src).split("|");
        const sys = await providerFor("system");
        return sys.act(ctx, table!, v.mode === "run" ? "run" : "dry", id!, {});
      }
    }
  } catch (e) {
    return refusal(e);
  }
}
