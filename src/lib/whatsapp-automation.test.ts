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
  waReplies,
  waTemplates,
  waTriggers,
  whatsappServiceEvents,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ruleAudience, runAutomation } from "@/lib/services/whatsapp-automation-service";

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

test("opening a rule shows who it reaches, even an Off rule, and writes and sends nothing", async () => {
  await serviceOn();
  const r1 = await rule(await template("payment_followup_1", "payment_followup_1_v2"), { status: "off", fromDay: 30 });
  setTestUser(founder);
  const s = await ruleAudience(r1);
  setTestUser(null);
  const mine = s.rules.find((x) => x.ruleId === r1);
  assert.equal(mine?.inRange, 1);
  assert.equal(mine?.rows[0].outcome, "would_send");
  assert.equal(s.runId, null);
  assert.equal(sends.length, 0);
  assert.equal(
    (await db.select().from(waAutomationRuns)).length,
    0,
    "looking at a rule is not a run — the log stays a record of real checks",
  );
});

test("a pass that can send is logged whatever the caller asks", async () => {
  await serviceOn();
  await rule(await template("payment_followup_1", "payment_followup_1_v2"));
  await runAutomation({ source: "schedule", now: at("11:00"), record: false });
  assert.equal((await db.select().from(waAutomationRuns)).length, 1);
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

test("the collections strip counts today's and yesterday's payment reminders, by who sent them, over the reader's own book", async () => {
  const { paymentReminderSummary, latestMessageFor } = await import("@/lib/services/whatsapp-tracker-service");
  await serviceOn();
  const tid = await template("payment_followup_1", "payment_followup_1_v2");
  await rule(tid);
  await runAutomation({ source: "schedule", now: at("10:52") });
  // Yesterday a person pasted one by hand and confirmed it.
  await db.insert(waMessages).values({
    id: id("wam"), customerId: shopId, templateId: tid, userId: founder.id, destKind: "personal",
    resolvedDestination: "9820011001", body: "Yesterday's words", status: "sent_manually", mode: "manual",
    preparedAt: at("16:00", -1), confirmedSentAt: at("16:05", -1),
  });
  // An order confirmation today is not a payment reminder.
  const orderTpl = id("tpl");
  await db.insert(waTemplates).values({ id: orderTpl, name: "order", category: "order_confirmation", body: "x" });
  await db.insert(waMessages).values({
    id: id("wam"), customerId: shopId, templateId: orderTpl, userId: founder.id, destKind: "personal",
    resolvedDestination: "9820011001", body: "x", status: "sent_manually", mode: "manual",
    preparedAt: at("11:30"), confirmedSentAt: at("11:31"),
  });

  const grant = async (role: "admin" | "associate") => {
    const [u] = await db.insert(users).values({
      id: id("usr"), name: role, email: `${role}-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role, initials: "XX",
    }).returning();
    await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "crm", role });
    return u;
  };

  setTestUser(await grant("admin"));
  const s = await paymentReminderSummary(todayIst(), daysAgo(1));
  assert.equal(s.today.total, 1, "the rule's send, not the order confirmation");
  assert.equal(s.today.byRule, 1);
  assert.equal(s.today.byPerson, 0);
  assert.equal(s.yesterday.total, 1);
  assert.equal(s.yesterday.byPerson, 1);
  assert.equal(s.yesterday.customers, 1);
  assert.ok(s.lastRun, "the runner's pass is reported");
  assert.ok(s.lastSendingRun, "and the pass that actually sent, separately");

  // The newest message carries its words and where it went.
  const latest = (await latestMessageFor([shopId]))[shopId];
  assert.equal(latest.destination, "9820011001");
  assert.ok(latest.body.length > 0);

  // A telecaller sees only their own book: nothing, until the shop is theirs.
  const tc = await grant("associate");
  setTestUser(tc);
  assert.equal((await paymentReminderSummary(todayIst(), daysAgo(1))).today.total, 0);
  await db.update(customers).set({ ownerId: tc.id }).where(eq(customers.id, shopId));
  assert.equal((await paymentReminderSummary(todayIst(), daysAgo(1))).today.total, 1);
  setTestUser(null);
});

test("the Chats list shows a telecaller only their own customers' conversations, both directions, and an admin the unknown numbers too", async () => {
  const { listConversations, getThread, markThreadHandled } = await import("@/lib/services/whatsapp-chat-service");
  const { actionReply } = await import("@/lib/services/whatsapp-service");
  const person = async (name: string, role: "admin" | "associate") => {
    const [u] = await db.insert(users).values({
      id: id("usr"), name, email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role, initials: "XX",
    }).returning();
    await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "crm", role });
    return u;
  };
  const priya = await person("Priya", "associate");
  const rakesh = await person("Rakesh", "associate");
  const boss = await person("Boss", "admin");

  await db.update(customers).set({ ownerId: priya.id }).where(eq(customers.id, shopId));
  const leadId = id("cus");
  await db.insert(customers).values({ id: leadId, name: "Rakesh Lead", kind: "lead", ownerId: rakesh.id, contactPerson: "L", phone: "9820099999", city: "Pune" });

  const tid = await template("payment_followup_1", "payment_followup_1_v2");
  await db.insert(waMessages).values({
    id: id("wam"), customerId: shopId, templateId: tid, templateName: "Payment follow-up", userId: priya.id, destKind: "personal",
    resolvedDestination: "9820011001", body: "Your bill MMI/1 is overdue.", status: "sent_manually", mode: "manual",
    preparedAt: at("10:00"), confirmedSentAt: at("10:01"),
  });
  const mine = id("wrp");
  await db.insert(waReplies).values([
    { id: mine, customerId: shopId, message: "Will pay Friday", receivedAt: at("10:30"), waId: "919820011001" },
    { id: id("wrp"), customerId: leadId, message: "Send me the rate list", receivedAt: at("10:40"), waId: "919820099999" },
    { id: id("wrp"), customerId: null, message: "Do you supply in Nashik?", receivedAt: at("10:50"), waId: "919811122233", senderName: "New Shop" },
  ]);

  setTestUser(priya);
  let list = await listConversations({ show: "open" });
  assert.deepEqual(list.rows.map((r) => r.key), [shopId], "only her own customer — not Rakesh's lead, not the stranger");
  assert.equal(list.rows[0].unanswered, 1);
  assert.equal(list.rows[0].lastText, "Will pay Friday");
  assert.equal(list.seesUnknown, false);

  const thread = await getThread(shopId);
  assert.equal(thread.ok, true);
  if (!thread.ok) return;
  assert.deepEqual(
    thread.data.events.map((e) => [e.fromThem, e.text]),
    [[false, "Your bill MMI/1 is overdue."], [true, "Will pay Friday"]],
    "both directions, oldest first",
  );
  await assert.rejects(() => getThread(leadId), "nobody else's customer");
  assert.equal((await getThread("n:9811122233")).ok, false, "nor a number on nobody's book");

  // Handling the thread clears it from Needs reply, and records who.
  assert.equal((await markThreadHandled(shopId)).ok, true);
  list = await listConversations({ show: "open" });
  assert.equal(list.rows.length, 0);
  const [handled] = await db.select().from(waReplies).where(eq(waReplies.id, mine));
  assert.equal(handled.actionedById, priya.id);
  assert.equal((await actionReply(mine, false)).ok, true, "and can be put back");

  setTestUser(boss);
  list = await listConversations({ show: "all" });
  assert.equal(list.rows.length, 3);
  assert.equal(list.seesUnknown, true);
  const unknown = await listConversations({ show: "unknown" });
  assert.deepEqual(unknown.rows.map((r) => [r.key, r.name]), [["n:9811122233", "New Shop"]]);
  assert.equal((await listConversations({ show: "all", q: "Nashik" })).rows.length, 1, "search reads the messages");
  assert.equal((await getThread("n:9811122233")).ok, true);
  setTestUser(null);
});

test("the Log shows a telecaller every message to their own customers, including the ones an automatic rule sent", async () => {
  const { listMessages, messageCount } = await import("@/lib/services/whatsapp-service");
  const person = async (name: string) => {
    const [u] = await db.insert(users).values({
      id: id("usr"), name, email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role: "associate", initials: "XX",
    }).returning();
    await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "crm", role: "associate" });
    return u;
  };
  const poonam = await person("Poonam");
  const rakesh = await person("Rakesh");
  await db.update(customers).set({ ownerId: poonam.id }).where(eq(customers.id, shopId));
  const rakeshShop = id("cus");
  await db.insert(customers).values({ id: rakeshShop, name: "Rakesh Shop", ownerId: rakesh.id, contactPerson: "R", phone: "9820077777", city: "Pune" });

  const msg = (customerId: string, userId: string, over: Partial<typeof waMessages.$inferInsert> = {}) => ({
    id: id("wam"), customerId, userId, destKind: "personal" as const, resolvedDestination: "9820011001",
    body: "x", status: "sent" as const, mode: "automatic" as const, ...over,
  });
  const ruleSent = msg(shopId, founder.id, { triggerId: "trg_x" });
  const hersElsewhere = msg(rakeshShop, poonam.id, { status: "copied", mode: "manual" });
  const rakeshs = msg(rakeshShop, rakesh.id);
  await db.insert(waMessages).values([ruleSent, hersElsewhere, rakeshs]);

  setTestUser(poonam);
  const log = await listMessages();
  const seen = new Map(log.map((m) => [m.id, m]));
  assert.ok(seen.has(ruleSent.id), "the rule's reminder to her customer is in her log");
  assert.equal(seen.get(ruleSent.id)!.sentInScope, false, "but it is not her copy to confirm");
  assert.equal(seen.get(hersElsewhere.id)?.sentInScope, true, "what she sent stays hers");
  assert.ok(!seen.has(rakeshs.id), "nobody else's customer");
  assert.equal(await messageCount(), 2, "the count agrees with the list");
  setTestUser(null);
});

test("the chat list holds everybody we messaged, as WhatsApp does — with our last message's ticks — and Needs reply only those owed an answer", async () => {
  const { listConversations } = await import("@/lib/services/whatsapp-chat-service");
  const [boss] = await db.insert(users).values({
    id: id("usr"), name: "Boss", email: `boss-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role: "admin", initials: "BO",
  }).returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: boss.id, app: "crm", role: "admin" });
  // A reminder that went and was read, and no answer yet.
  await db.insert(waMessages).values({
    id: id("wam"), customerId: shopId, userId: boss.id, destKind: "personal", resolvedDestination: "9820011001",
    body: "Your bill MMI/1 is overdue.", status: "read", mode: "automatic", preparedAt: at("09:00"), sentAt: at("09:01"),
  });
  setTestUser(boss);
  const all = await listConversations({ show: "all" });
  const row = all.rows.find((r) => r.customerId === shopId);
  assert.ok(row, "a customer we only messaged is a chat");
  assert.equal(row!.lastFromThem, false);
  assert.equal(row!.lastStatus, "read", "the ticks on our last message");
  assert.equal(row!.unanswered, 0);
  assert.equal((await listConversations({ show: "open" })).rows.length, 0, "nothing is owed an answer");
  setTestUser(null);
});
