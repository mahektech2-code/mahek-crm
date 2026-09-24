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
import { applyWatiEvent, sendNow } from "@/lib/services/whatsapp-service";
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
        ],
        total: 1,
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
      follow_up_attempts, follow_up_states, audit_log, app_access, sessions,
      customers, users, app_settings
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
