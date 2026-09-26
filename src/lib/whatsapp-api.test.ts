/**
 * WhatsApp through Wati, end to end against a real database — with Wati itself
 * replaced by a stub, so nothing here ever reaches a customer.
 *
 * What it pins, in the order it matters:
 *   1. Nothing is sent while the founder's switch is off — not by the button,
 *      not by the service, and Wati is never even called.
 *   2. Only the founder's desk can switch it — not a telecaller, and not an
 *      administrator who was never given the Founder Dashboard.
 *   3. Switched on, a linked template goes to the right number with the right
 *      variables, and the customer is stamped only once Wati accepts it.
 *   4. Webhooks move status forward, file replies, and a failure takes the
 *      stamp back.
 *
 * They need mahekone_test, which `npm run test:db` creates.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  bills,
  orders,
  paymentReceipts,
  customers,
  followUpAttempts,
  followUpStates,
  users,
  waMessages,
  waReplies,
  waTemplates,
  whatsappServiceEvents,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setWhatsappService } from "@/lib/services/whatsapp-switch-service";
import { applyWatiEvent, prepareMessage, sendNow } from "@/lib/services/whatsapp-service";
import { parseWatiEvent } from "@/lib/whatsapp-delivery";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ------------------------------------------------------------ Wati, stubbed */

const WATI_TEMPLATE = "payment_reminder_v1";
let sends: Array<Record<string, unknown>> = [];
let refuseNext: string | null = null;
const realFetch = globalThis.fetch;

function stubWati() {
  process.env.WATI_API_TOKEN = "wati_test_token";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://live-mt-server.wati.io/")) return realFetch(input, init);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/messageTemplates/send")) {
      const body = JSON.parse(String(init?.body));
      sends.push(body);
      if (refuseNext) {
        const why = refuseNext;
        refuseNext = null;
        return json({ success: true, recipients: [{ errors: [why] }] });
      }
      return json({ success: true, broadcast_id: "bc_1", recipients: [{ errors: [] }] });
    }
    if (url.includes("/messageTemplates")) {
      return json({
        templates: [
          {
            name: WATI_TEMPLATE,
            status: "APPROVED",
            body: "Dear {{customer}}, {{outstanding}} is due.",
            custom_params: [{ name: "customer" }, { name: "outstanding" }],
          },
          {
            name: "payment_followup_1_v2",
            status: "APPROVED",
            body: "*PAYMENT FOLLOW-UP – {{customer_name}}*\n{{as_of_date}}\n{{bills_list}}\n*Total Overdue: ₹{{total_overdue}}*\nPlease tap an option below.",
            custom_params: [{ name: "customer_name" }, { name: "as_of_date" }, { name: "bills_list" }, { name: "total_overdue" }],
          },
          {
            name: "order_followup_due_passed_v2",
            status: "APPROVED",
            body: "{{customer_name}} {{cycle_days}} {{expected_order_date}} {{last_order_date}} {{days_since_last_order}} {{last_products}} Please tap an option below.",
            custom_params: [
              { name: "customer_name" }, { name: "cycle_days" }, { name: "expected_order_date" },
              { name: "last_order_date" }, { name: "days_since_last_order" }, { name: "last_products" },
            ],
          },
        ],
        total: 3,
      });
    }
    if (url.includes("/channels")) return json({ channels: [{ name: "Default", channel: "WhatsApp" }] });
    return new Response("not stubbed", { status: 404 });
  }) as typeof fetch;
}

/* ---------------------------------------------------------------- fixtures */

let founder: typeof users.$inferSelect;
let caller: typeof users.$inferSelect;
let adminOnly: typeof users.$inferSelect;
let shop: typeof customers.$inferSelect;
let templateId: string;

async function makeUser(
  name: string,
  role: "manager" | "associate" | "admin",
  apps: Array<{ app: "crm" | "founder" | "admin"; role: "manager" | "associate" | "admin" }>,
) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`,
      passwordHash: "scrypt$00$00",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const a of apps) {
    await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: a.app, role: a.role });
  }
  return row;
}

async function makeShop(name: string, phone: string) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name,
      contactPerson: "Owner",
      phone,
      city: "Nagpur",
      ownerId: caller.id,
      salesAmId: caller.id,
      outstanding: 5_908_600,
    })
    .returning();
  return row;
}

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
  stubWati();
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      whatsapp_service_events, wa_replies, wa_messages, wa_runs, wa_templates,
      follow_up_attempts, follow_up_states, payment_receipts, payments, bills,
      orders, audit_log, app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  sends = [];
  refuseNext = null;

  founder = await makeUser("Founder", "manager", [{ app: "founder", role: "manager" }]);
  caller = await makeUser("Priya", "associate", [{ app: "crm", role: "associate" }]);
  adminOnly = await makeUser("Admin", "admin", [{ app: "admin", role: "admin" }]);
  shop = await makeShop("Colour Camp", "98200 11001");

  templateId = id("tpl");
  await db.insert(waTemplates).values({
    id: templateId,
    name: "Stage 1 reminder",
    category: "payment_reminder",
    escalationStage: 1,
    body: "Dear {{customer}}, {{outstanding}} is due.",
    watiTemplateName: WATI_TEMPLATE,
  });
  setTestUser(caller);
});

after(async () => {
  globalThis.fetch = realFetch;
  setTestUser(null);
  await db.$client.end();
});

async function switchOn() {
  setTestUser(founder);
  const r = await setWhatsappService({ active: true, note: "test" });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  setTestUser(caller);
}

const send = () => sendNow({ customerId: shop.id, templateId, idempotencyKey: randomUUID() });

/* --------------------------------------------------------------- the switch */

test("with the switch never touched, nothing is sent and Wati is never called", async () => {
  const r = await send();
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /Founder Dashboard/);
  assert.equal(sends.length, 0);

  const [c] = await db.select().from(customers).where(eq(customers.id, shop.id));
  assert.equal(c.lastConfirmedWhatsappDate, null, "an unsent message must not hold anybody off the Call Log");
});

test("a telecaller cannot switch it on", async () => {
  setTestUser(caller);
  await assert.rejects(() => setWhatsappService({ active: true }), /not|permitted|allowed/i);
  assert.equal((await db.select().from(whatsappServiceEvents)).length, 0);
});

test("an administrator without the Founder Dashboard cannot switch it on", async () => {
  setTestUser(adminOnly);
  await assert.rejects(() => setWhatsappService({ active: true }));
  assert.equal((await db.select().from(whatsappServiceEvents)).length, 0);
});

test("the founder switches it on, and the decision is a row with a name on it", async () => {
  await switchOn();
  const rows = await db.select().from(whatsappServiceEvents);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].changedByName, "Founder");
});

/* ------------------------------------------------------------------ sending */

test("switched on, it goes to the customer's own number as the approved template", async () => {
  await switchOn();
  const r = await send();
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;

  assert.equal(sends.length, 1);
  const body = sends[0] as {
    template_name: string;
    recipients: Array<{ phone_number: string; local_message_id: string; custom_params: Array<{ name: string; value: string }> }>;
  };
  assert.equal(body.template_name, WATI_TEMPLATE);
  assert.equal(body.recipients[0].phone_number, "919820011001");
  assert.equal(body.recipients[0].local_message_id, r.data.messageId, "webhooks are matched on our own id");
  assert.deepEqual(
    body.recipients[0].custom_params.map((p) => p.name),
    ["customer", "outstanding"],
  );
  assert.equal(body.recipients[0].custom_params[0].value, "Colour Camp");

  const [m] = await db.select().from(waMessages).where(eq(waMessages.id, r.data.messageId));
  assert.equal(m.status, "sent");
  assert.equal(m.mode, "automatic");
  const [c] = await db.select().from(customers).where(eq(customers.id, shop.id));
  assert.notEqual(c.lastConfirmedWhatsappDate, null);
});

test("switched off again, the very next message does not go", async () => {
  await switchOn();
  setTestUser(founder);
  await setWhatsappService({ active: false });
  setTestUser(caller);
  const r = await send();
  assert.equal(r.ok, false);
  assert.equal(sends.length, 0);
});

test("an unlinked template is refused rather than sent as something else", async () => {
  await switchOn();
  await db.update(waTemplates).set({ watiTemplateName: null }).where(eq(waTemplates.id, templateId));
  const r = await send();
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /not linked/);
  assert.equal(sends.length, 0);
});

test("a number shared by three shops is a placeholder and is refused", async () => {
  await switchOn();
  await makeShop("Second", "9820011001");
  await makeShop("Third", "+91 9820011001");
  const r = await send();
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /placeholder/);
  assert.equal(sends.length, 0);
});

test("when Wati refuses, the message is failed with its words and nobody is stamped", async () => {
  await switchOn();
  refuseNext = "Invalid WhatsApp number";
  const r = await send();
  assert.equal(r.ok, false);

  const [m] = await db.select().from(waMessages).where(eq(waMessages.customerId, shop.id));
  assert.equal(m.status, "failed");
  assert.match(m.failureReason ?? "", /Invalid WhatsApp number/);
  const [c] = await db.select().from(customers).where(eq(customers.id, shop.id));
  assert.equal(c.lastConfirmedWhatsappDate, null);
});

test("a payment reminder that went is a collections attempt, once", async () => {
  await db.insert(followUpStates).values({
    customerId: shop.id,
    stage: 1,
    stageEnteredAt: new Date(),
    nextChannel: "whatsapp",
  });
  await switchOn();
  const r = await send();
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  const attempts = await db.select().from(followUpAttempts).where(eq(followUpAttempts.customerId, shop.id));
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].channel, "whatsapp");
});

/* ----------------------------------------------------------------- webhooks */

test("delivered then read moves forward, and a late delivered does not undo read", async () => {
  await switchOn();
  const r = await send();
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const mid = r.data.messageId;

  await applyWatiEvent(parseWatiEvent({ eventType: "sentMessageDELIVERED_v2", localMessageId: mid, whatsappMessageId: "wamid.A" }));
  await applyWatiEvent(parseWatiEvent({ eventType: "sentMessageREAD_v2", localMessageId: mid }));
  await applyWatiEvent(parseWatiEvent({ eventType: "sentMessageDELIVERED_v2", localMessageId: mid }));

  const [m] = await db.select().from(waMessages).where(eq(waMessages.id, mid));
  assert.equal(m.status, "read");
  assert.equal(m.providerRef, "wamid.A");
  assert.ok(m.readAt && m.deliveredAt);
});

test("a failure reported later takes back the stamp the send put on the customer", async () => {
  await switchOn();
  const r = await send();
  assert.equal(r.ok, true);
  if (!r.ok) return;

  await applyWatiEvent(
    parseWatiEvent({ eventType: "templateMessageFailed", localMessageId: r.data.messageId, failedCode: "131026", failedDetail: "Message undeliverable" }),
  );
  const [m] = await db.select().from(waMessages).where(eq(waMessages.id, r.data.messageId));
  assert.equal(m.status, "failed");
  const [c] = await db.select().from(customers).where(eq(customers.id, shop.id));
  assert.equal(c.lastConfirmedWhatsappDate, null, "a message that never arrived must not hold them off the Call Log");
});

test("a reply is filed against the customer, once, and a stranger's is kept rather than dropped", async () => {
  const reply = { eventType: "message", waId: "919820011001", whatsappMessageId: "wamid.IN1", text: "Will pay Friday", senderName: "Ramesh" };
  await applyWatiEvent(parseWatiEvent(reply));
  await applyWatiEvent(parseWatiEvent(reply));
  await applyWatiEvent(parseWatiEvent({ ...reply, waId: "919999999999", whatsappMessageId: "wamid.IN2" }));

  const rows = await db.select().from(waReplies);
  assert.equal(rows.length, 2, "Wati retrying a webhook must not file a reply twice");
  const mine = rows.find((r) => r.providerMessageId === "wamid.IN1");
  const stranger = rows.find((r) => r.providerMessageId === "wamid.IN2");
  assert.equal(mine?.customerId, shop.id);
  assert.equal(stranger?.customerId, null);
});

/* ------------------------------------------------------ rule-set templates */

async function specTemplate(key: string, body: string, watiName: string | null) {
  const tid = id("tpl");
  await db.insert(waTemplates).values({
    id: tid,
    name: key,
    category: key.startsWith("payment") ? "payment_reminder" : "reactivation",
    body,
    watiSpec: key,
    watiTemplateName: watiName,
  });
  return tid;
}

/** Days before today, as a YYYY-MM-DD in IST. */
function daysAgo(n: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(Date.now() - n * 86_400_000),
  );
}

async function overdueBill(no: string, rupees: number, ageDays: number) {
  await db.insert(bills).values({
    id: id("bil"),
    customerId: shop.id,
    billNo: no,
    billDate: daysAgo(ageDays),
    dueDate: daysAgo(ageDays - 30),
    amount: rupees * 100,
    paymentPosition: "stated",
  });
}

test("a payment template sends the customer's real overdue bills, fresh at the moment of sending", async () => {
  await overdueBill("MMI/1", 16424, 70);
  await overdueBill("MMI/2", 8200, 50);
  await overdueBill("MMI/NOTDUE", 5000, 5); // due in 25 days — not overdue
  const tid = await specTemplate("payment_followup_1", "{{customer_name}} {{as_of_date}} {{bills_list}} ₹{{total_overdue}} Please tap an option below.", "payment_followup_1_v2");
  await switchOn();

  const r = await sendNow({ customerId: shop.id, templateId: tid, idempotencyKey: randomUUID() });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  const sent = sends[0] as { template_name: string; recipients: Array<{ custom_params: Array<{ name: string; value: string }> }> };
  assert.equal(sent.template_name, "payment_followup_1_v2");
  const p = Object.fromEntries(sent.recipients[0].custom_params.map((x) => [x.name, x.value]));
  assert.equal(p.customer_name, "Colour Camp");
  assert.match(p.bills_list, /MMI\/1 – ₹16,424 \| .*MMI\/2 – ₹8,200$/);
  assert.doesNotMatch(p.bills_list, /NOTDUE/);
  assert.equal(p.total_overdue, "24,624");
});

test("a customer who has reported a payment is refused, and Wati is never called", async () => {
  await overdueBill("MMI/1", 16424, 70);
  await db.insert(paymentReceipts).values({
    id: id("rcp"),
    customerId: shop.id,
    amount: 1_642_400,
    receivedAt: daysAgo(1),
    status: "reported",
    idempotencyKey: randomUUID(),
  });
  const tid = await specTemplate("payment_followup_1", "{{customer_name}} {{as_of_date}} {{bills_list}} {{total_overdue}}", "payment_followup_1_v2");
  await switchOn();
  const r = await sendNow({ customerId: shop.id, templateId: tid, idempotencyKey: randomUUID() });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /reported a payment/);
  assert.equal(sends.length, 0);
});

test("with the switch off, the same template is a paste-able copy that asks for a reply, not a tap", async () => {
  await overdueBill("MMI/1", 16424, 70);
  const tid = await specTemplate("payment_followup_1", "{{customer_name}} {{as_of_date}} {{bills_list}} ₹{{total_overdue}}\n\nPlease tap an option below.", "payment_followup_1_v2");
  const r = await prepareMessage({ customerId: shop.id, templateId: tid, idempotencyKey: randomUUID() });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.data.mode, "manual");
  assert.match(r.data.body, /Please reply to this message\./);
  assert.doesNotMatch(r.data.body, /tap/);
  assert.match(r.data.body, /₹16,424/);
});

test("an order follow-up reads the last order, its products and the measured cycle", async () => {
  await db.update(customers).set({ cycleDays: 28, cycleIsDefault: false }).where(eq(customers.id, shop.id));
  await db.insert(orders).values({
    id: id("ord"),
    customerId: shop.id,
    orderedAt: new Date(`${daysAgo(40)}T10:00:00+05:30`),
    totalAmount: 4_850_000,
    status: "confirmed",
    lineItems: [
      { product: "Nano Thinner 20L", quantity: 2, unitPrice: 0, amount: 0 },
      { product: "PU Clear 4L", quantity: 1, unitPrice: 0, amount: 0 },
    ],
  });
  const tid = await specTemplate(
    "order_followup_due_passed",
    "{{customer_name}} {{cycle_days}} {{expected_order_date}} {{last_order_date}} {{days_since_last_order}} {{last_products}}",
    "order_followup_due_passed_v2",
  );
  await switchOn();
  const r = await sendNow({ customerId: shop.id, templateId: tid, idempotencyKey: randomUUID() });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  const p = Object.fromEntries(
    (sends[0] as { recipients: Array<{ custom_params: Array<{ name: string; value: string }> }> }).recipients[0].custom_params.map((x) => [x.name, x.value]),
  );
  assert.equal(p.cycle_days, "28");
  assert.equal(p.days_since_last_order, "40");
  assert.equal(p.last_products, "Nano Thinner 20L, PU Clear 4L");
});

test("the same order follow-up is refused while the cycle is only the default", async () => {
  await db.insert(orders).values({
    id: id("ord"),
    customerId: shop.id,
    orderedAt: new Date(`${daysAgo(40)}T10:00:00+05:30`),
    totalAmount: 4_850_000,
    status: "confirmed",
    lineItems: [{ product: "Nano Thinner 20L", quantity: 2, unitPrice: 0, amount: 0 }],
  });
  const tid = await specTemplate("order_followup_due_passed", "{{customer_name}}", "order_followup_due_passed_v2");
  await switchOn();
  const r = await sendNow({ customerId: shop.id, templateId: tid, idempotencyKey: randomUUID() });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /not been measured/);
  assert.equal(sends.length, 0);
});

test("an administrator who also holds the Founder Dashboard can switch it — whichever hat is credited", async () => {
  const both = await makeUser("Owner", "admin", [
    { app: "crm", role: "admin" },
    { app: "admin", role: "admin" },
    { app: "founder", role: "admin" },
  ]);
  setTestUser(both);
  const r = await setWhatsappService({ active: true });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  assert.equal((await db.select().from(whatsappServiceEvents)).length, 1);
});
