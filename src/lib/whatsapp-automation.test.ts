/**
 * The founder's WhatsApp rules, run end to end against a real database — with
 * Wati replaced by a stub so nothing reaches a customer.
 *
 * Pins: preview never sends · nothing outside the window · a Live rule sends
 * once, and a second pass the same day sends nothing more · the highest
 * priority wins and a customer gets one message a day · the service switch
 * turns Live into "would send" · a rule's repeat gap holds.
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
  customers,
  users,
  waAutomationRuns,
  waAutomationSettings,
  waMessages,
  waTemplates,
  waTriggers,
  whatsappServiceEvents,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { runAutomation } from "@/lib/services/whatsapp-automation-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ------------------------------------------------------------ Wati, stubbed */

let sends: Array<{ template_name: string; recipients: Array<{ phone_number: string }> }> = [];
const realFetch = globalThis.fetch;
const BODY = "*PAYMENT FOLLOW-UP – {{customer_name}}*\n{{as_of_date}}\n{{bills_list}}\n₹{{total_overdue}}\nPlease tap an option below.";
const PARAMS = ["customer_name", "as_of_date", "bills_list", "total_overdue"];

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against mahekone_test.");
  process.env.WATI_API_TOKEN = "wati_test_token";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://live-mt-server.wati.io/")) return realFetch(input, init);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/messageTemplates/send")) {
      sends.push(JSON.parse(String(init?.body)));
      return json({ success: true, broadcast_id: "bc", recipients: [{ errors: [] }] });
    }
    if (url.includes("/messageTemplates")) {
      return json({
        templates: [
          { name: "payment_followup_1_v2", status: "APPROVED", body: BODY, custom_params: PARAMS.map((n) => ({ name: n })) },
          {
            name: "payment_credit_hold_v2",
            status: "APPROVED",
            body: "{{customer_name}} {{bills_list}} ₹{{total_overdue}} {{oldest_overdue_days}} days",
            custom_params: ["customer_name", "bills_list", "total_overdue", "oldest_overdue_days"].map((n) => ({ name: n })),
          },
        ],
        total: 2,
      });
    }
    return json({ channels: [] });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  setTestUser(null);
  await db.$client.end();
});

/* ---------------------------------------------------------------- fixtures */

let founder: typeof users.$inferSelect;
let shopId: string;
/** Today in India, and an instant on it at a given time. */
const todayIst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const at = (hm: string, offsetDays = 0) =>
  new Date(new Date(`${todayIst()}T${hm}:00+05:30`).getTime() + offsetDays * 86_400_000);
const daysAgo = (n: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() - n * 86_400_000));

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      wa_automation_runs, wa_triggers, wa_automation_settings, whatsapp_service_events,
      wa_replies, wa_messages, wa_runs, wa_templates, follow_up_attempts, follow_up_states,
      payment_receipts, payments, bills, orders, audit_log, app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  sends = [];

  [founder] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Founder", email: `f-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role: "manager", initials: "FO" })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: founder.id, app: "founder", role: "manager" });

  shopId = id("cus");
  await db.insert(customers).values({ id: shopId, name: "Colour Camp", contactPerson: "O", phone: "9820011001", city: "Nagpur" });
  // Due 35 days ago: 35 days overdue.
  await db.insert(bills).values({
    id: id("bil"), customerId: shopId, billNo: "MMI/1", billDate: daysAgo(65), dueDate: daysAgo(35),
    amount: 1_642_400, paymentPosition: "stated",
  });

  // Every day allowed, so the suite passes on a Sunday too; the hours are Mahek's.
  await db.insert(waAutomationSettings).values({ id: "default", windowStartHour: 10, windowEndHour: 13, weekdays: [1, 2, 3, 4, 5, 6, 7], dailyCap: 300 });
});

async function template(spec: string, watiName: string) {
  const tid = id("tpl");
  await db.insert(waTemplates).values({ id: tid, name: spec, category: "payment_reminder", body: BODY, watiSpec: spec, watiTemplateName: watiName });
  return tid;
}
async function rule(templateId: string, over: Partial<typeof waTriggers.$inferInsert> = {}) {
  const rid = id("trg");
  await db.insert(waTriggers).values({
    id: rid, templateId, status: "live", fromDay: 1, toDay: null, repeatEveryDays: 4, priority: 50,
    updatedById: founder.id, updatedByName: "Founder", ...over,
  });
  return rid;
}
async function serviceOn(active = true) {
  await db.insert(whatsappServiceEvents).values({ id: id("wsv"), active, changedById: founder.id, changedByName: "Founder" });
}

/* ------------------------------------------------------------------ tests */

test("a preview works everything out and sends nothing", async () => {
  await serviceOn();
  const r1 = await rule(await template("payment_followup_1", "payment_followup_1_v2"), { status: "preview" });
  const s = await runAutomation({ source: "preview" });
  assert.equal(s.sent, 0);
  assert.equal(s.wouldSend, 1);
  assert.equal(s.rules.find((x) => x.ruleId === r1)?.rows[0].outcome, "would_send");
  assert.equal(sends.length, 0);
  assert.equal((await db.select().from(waAutomationRuns)).length, 1, "the preview is in the log");
});

test("at 1 pm or later nothing is even checked", async () => {
  await serviceOn();
  await rule(await template("payment_followup_1", "payment_followup_1_v2"));
  for (const hm of ["13:00", "18:30", "09:59"]) {
    const s = await runAutomation({ source: "schedule", now: at(hm) });
    assert.match(s.note, /Outside the sending window/, hm);
  }
  assert.equal(sends.length, 0);
});

test("inside the window a Live rule sends — once, however many times the check runs that day", async () => {
  await serviceOn();
  const r1 = await rule(await template("payment_followup_1", "payment_followup_1_v2"));
  const first = await runAutomation({ source: "schedule", now: at("10:52") });
  assert.equal(first.sent, 1, first.note);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].recipients[0].phone_number, "919820011001");
  const [m] = await db.select().from(waMessages).where(eq(waMessages.customerId, shopId));
  assert.equal(m.triggerId, r1);
  assert.equal(m.status, "sent");

  await runAutomation({ source: "schedule", now: at("11:52") });
  await runAutomation({ source: "schedule", now: at("12:52") });
  assert.equal(sends.length, 1, "the 11:52 and 12:52 checks add nothing");
});

test("one message a day: the lower priority number wins, the other waits", async () => {
  await serviceOn();
  const hold = await rule(await template("payment_credit_hold", "payment_credit_hold_v2"), { fromDay: 30, priority: 10 });
  const gentle = await rule(await template("payment_followup_1", "payment_followup_1_v2"), { fromDay: 1, priority: 40 });
  const s = await runAutomation({ source: "schedule", now: at("11:00") });
  assert.equal(s.sent, 1);
  assert.equal(sends[0].template_name, "payment_credit_hold_v2");
  assert.equal(s.rules.find((x) => x.ruleId === hold)?.sent, 1);
  assert.equal(s.rules.find((x) => x.ruleId === gentle)?.sent, 0);
});

test("with the service switched off, a Live rule is logged as 'would send' and nothing leaves", async () => {
  await serviceOn(false);
  await rule(await template("payment_followup_1", "payment_followup_1_v2"));
  const s = await runAutomation({ source: "schedule", now: at("11:00") });
  assert.equal(s.sent, 0);
  assert.equal(s.wouldSend, 1);
  assert.match(s.note, /switched off/);
  assert.equal(sends.length, 0);
});

test("a rule's repeat gap holds across days", async () => {
  await serviceOn();
  const tid = await template("payment_followup_1", "payment_followup_1_v2");
  const r1 = await rule(tid, { repeatEveryDays: 4 });
  // Sent by this rule two days ago.
  await db.insert(waMessages).values({
    id: id("wam"), customerId: shopId, templateId: tid, userId: founder.id, destKind: "personal",
    resolvedDestination: "9820011001", body: "x", status: "sent", mode: "automatic", triggerId: r1,
    sentAt: new Date(Date.now() - 2 * 86_400_000), preparedAt: new Date(Date.now() - 2 * 86_400_000),
  });
  const s = await runAutomation({ source: "schedule", now: at("11:00") });
  assert.equal(s.sent, 0);
  assert.match(s.rules[0].rows[0].reason ?? "", /2 days ago; it repeats every 4/);
});

test("outside the rule's day range the customer is not touched at all", async () => {
  await serviceOn();
  await rule(await template("payment_followup_1", "payment_followup_1_v2"), { fromDay: 1, toDay: 15 });
  const s = await runAutomation({ source: "schedule", now: at("11:00") });
  assert.equal(s.rules[0].inRange, 0, "35 days overdue is past 15");
  assert.equal(sends.length, 0);
});

test("the tracker follows one message from send to read to reply, and says which rule applies", async () => {
  const { applyWatiEvent } = await import("@/lib/services/whatsapp-service");
  const { parseWatiEvent } = await import("@/lib/whatsapp-delivery");
  const { latestMessageFor, messagesForCustomer, ruleOutlookFor, trackerPage } = await import(
    "@/lib/services/whatsapp-tracker-service"
  );
  await serviceOn();
  const r1 = await rule(await template("payment_followup_1", "payment_followup_1_v2"));
  await runAutomation({ source: "schedule", now: at("10:52") });
  const [m] = await db.select().from(waMessages).where(eq(waMessages.customerId, shopId));

  await applyWatiEvent(parseWatiEvent({ eventType: "sentMessageDELIVERED_v2", localMessageId: m.id }));
  await applyWatiEvent(parseWatiEvent({ eventType: "sentMessageREAD_v2", localMessageId: m.id }));
  await applyWatiEvent(parseWatiEvent({ eventType: "message", waId: "919820011001", whatsappMessageId: "wamid.R1", text: "Will pay Friday" }));

  const latest = (await latestMessageFor([shopId]))[shopId];
  assert.equal(latest.status, "read");
  assert.ok(latest.deliveredAt && latest.readAt && latest.repliedAt, "every receipt is carried");
  assert.equal(latest.viaRule, true);

  const history = await messagesForCustomer(shopId);
  assert.equal(history.length, 1);

  const outlook = await ruleOutlookFor(shopId, "payment");
  const mine = outlook.find((o) => o.ruleId === r1)!;
  assert.equal(mine.inRange, true);
  assert.match(mine.verdict, /35 days overdue — inside/);

  const page = await trackerPage({ days: 7 });
  assert.equal(page.funnel.read, 1);
  assert.equal(page.funnel.replied, 1);
  assert.equal((await trackerPage({ days: 7, source: "person" })).rows.length, 0);
});
