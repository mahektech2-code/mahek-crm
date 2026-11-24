/**
 * THE INBOX IS SCOPED, EXPLICIT, AND NEVER FREE-TEXTS OUTSIDE THE WINDOW — against a real database and a FAKE Kapso
 * (a stand-in for the HTTP calls: no real message is ever sent). What it proves, allowed AND denied:
 *
 *   1. `studio.inbox` is explicit-only: not carried by holding the whole Studio, by being its manager or admin, or by being
 *      the platform administrator without a row;
 *   2. a conversation is read, searched, opened, marked read and answered only by somebody the CRM lets see its lead or
 *      customer — and an unmatched number is read by the whole-book reader alone;
 *   3. a bulk send of an uploaded poster answers EVERY recipient (sent / skipped / failed) and never sends free text outside
 *      the 24-hour window, or while the founder's switch is off;
 *   4. the future Org Chart approval routing is OFF, picks only somebody explicitly given Approve designs, and notifies nobody.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/db";
import { appAccess, appModuleAccess, appSettings, customers, employeeReporting, employees, notifications, studioWaConversations, users, whatsappServiceEvents } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { sendForwardToRecipients, sendText } from "@/lib/actions/studio-inbox";
import { startForward } from "@/lib/actions/studio-forward";
import { GET as inboxRoute } from "@/app/api/studio/inbox/route";
import { POST as uploadRoute } from "@/app/api/studio/forwards/upload/route";
import { POST as webhook } from "@/app/api/studio/whatsapp/webhook/route";
import { designApproverFor } from "./approval-routing";
import { signBody } from "./domain/inbox-signature";
import { getConversation, listConversationRows, markRead, resetConnectionCache, threadMessages } from "./inbox-service";
import { setKapsoFetch } from "./kapso";
import { resolveStudioScope } from "./scope";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const COMPANY = "919137466424";
const SECRET = "test-webhook-secret";
process.env.KAPSO_API_KEY = "test-key";
process.env.KAPSO_WEBHOOK_SECRET = SECRET;

let calls: { url: string; method: string }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sends = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/messages"));

function installFake() {
  setKapsoFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.includes("/whatsapp/phone_numbers")) return json(200, { data: [{ phone_number_id: "PN1", name: "Mahek", display_phone_number: "+91 91374 66424", display_phone_number_normalized: COMPANY, status: "CONNECTED", is_coexistence: true, meta_app_id: "app1" }], meta: { page: 1, total_pages: 1 } });
    if (url.endsWith("/media")) return json(200, { id: "MEDIA1" });
    if (url.endsWith("/messages") && method === "POST") return json(200, { messages: [{ id: `wamid.OUT${calls.length}` }] });
    return json(404, { error: "no such route in the fake" });
  });
}

const inboundBody = (wamid: string, phone: string, conv: string, ageHours = 0) => {
  const at = Math.floor(Date.now() / 1000) - ageHours * 3600;
  return {
    phone_number_id: "PN1",
    is_new_conversation: false,
    message: { id: wamid, timestamp: String(at), type: "text", from: phone, text: { body: `Hello from ${phone}` }, kapso: { direction: "inbound", status: "received", origin: "cloud_api", has_media: false } },
    conversation: { id: conv, phone_number: phone, phone_number_id: "PN1", kapso: { contact_name: "WA name", last_inbound_at: new Date(at * 1000).toISOString() } },
  };
};
async function hear(wamid: string, phone: string, conv: string, ageHours = 0) {
  const raw = JSON.stringify(inboundBody(wamid, phone, conv, ageHours));
  const res = await webhook(new Request("http://x/api/studio/whatsapp/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Event": "whatsapp.message.received", "X-Idempotency-Key": wamid, "X-Webhook-Signature": signBody(raw, SECRET) }, body: raw }));
  assert.equal(res.status, 200);
}

async function makeUser(name: string, level: "associate" | "manager" | "admin", modules: string[], over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase(), ...over } as never)
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "studio", role: level });
  for (const m of modules) await db.insert(appModuleAccess).values({ id: id("amx"), userId: row.id, app: "studio", module: m });
  return row;
}
async function makeCustomer(owner: string, phone: string, name: string, over: Record<string, unknown> = {}) {
  const cid = id("cus");
  await db.insert(customers).values({ id: cid, name, companyName: name, phone, city: "Nagpur", kind: "customer", ownerId: owner, salesAmId: owner, ...over } as never);
  return cid;
}
const png = () => sharp({ create: { width: 600, height: 800, channels: 3, background: "#ff8800" } }).png().toBuffer();
const switchOn = async () => void (await db.insert(whatsappServiceEvents).values({ id: id("wse"), active: true, changedByName: "Founder" }));
const INBOX = ["studio.inbox", "studio.forward", "studio.home"];

let manager: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;
let rakesh: typeof users.$inferSelect;
let cA: string;
let cB: string;
const PA = "919820011111";
const PB = "919820022222";
const PX = "919000000000";

before(() => assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against a mahekone_test database."));

beforeEach(async () => {
  await db.execute(sql`
    truncate table studio_wa_messages, studio_wa_conversations, studio_wa_events, studio_forward_recipients, studio_forwards, studio_poster_shares, studio_posters,
      customer_contacts, customers, employee_reporting, employees, attachment_bytes, audit_log, notifications, whatsapp_service_events, app_module_access, app_access, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  resetConnectionCache();
  calls = [];
  installFake();
  manager = await makeUser("Meena Manager", "manager", INBOX);
  priya = await makeUser("Priya Sharma", "associate", INBOX, { reportsToId: manager.id });
  rakesh = await makeUser("Rakesh Iyer", "associate", INBOX, { reportsToId: manager.id });
  cA = await makeCustomer(priya.id, "9820011111", "Alpha Paints");
  cB = await makeCustomer(rakesh.id, "9820022222", "Beta Coatings");
  await hear("wamid.A1", PA, "conv-A");
  await hear("wamid.B1", PB, "conv-B");
  await hear("wamid.X1", PX, "conv-X");
  setTestUser(priya);
});

after(async () => {
  setKapsoFetch(null);
  setTestUser(null);
  await db.$client.end();
});

const convId = async (k: string) => (await db.select().from(studioWaConversations).where(eq(studioWaConversations.phoneKey, k.slice(-10))))[0]!.id;

describe("studio.inbox is explicit-only", () => {
  test("a Studio manager, a Studio admin and a whole-Studio grant do not hold it; a ticked row does", async () => {
    const mgr = await makeUser("Plain Manager", "manager", ["studio.home"]);
    const adm = await makeUser("Studio Admin", "admin", ["studio.home"]);
    const whole = await makeUser("Whole App", "associate", []);
    assert.equal(await canOpenModule(mgr.id, "studio.inbox"), false);
    assert.equal(await canOpenModule(adm.id, "studio.inbox"), false);
    assert.equal(await canOpenModule(whole.id, "studio.inbox"), false, "no module rows means every module — except an explicit-only one");
    assert.equal(await canOpenModule(priya.id, "studio.inbox"), true);
  });
  test("the platform administrator holds it only when it is ticked for them too", async () => {
    const boss = await makeUser("Platform Admin", "admin", ["studio.home"]);
    await db.insert(appAccess).values({ id: id("aca"), userId: boss.id, app: "admin", role: "admin" });
    assert.equal(await canOpenModule(boss.id, "studio.inbox"), false);
    await db.insert(appModuleAccess).values({ id: id("amx"), userId: boss.id, app: "studio", module: "studio.inbox" });
    assert.equal(await canOpenModule(boss.id, "studio.inbox"), true);
  });
  test("the screen's own API refuses somebody without it", async () => {
    const nobody = await makeUser("No Inbox", "associate", ["studio.home"]);
    setTestUser(nobody);
    assert.equal((await inboxRoute(new Request("http://x/api/studio/inbox"))).status, 404);
  });
});

describe("a conversation is seen only by somebody who may see its lead or customer", () => {
  const titles = async (scopeIds: string[] | null, q?: string) => (await listConversationRows({ scopeIds, ...(q ? { q } : {}) })).rows.map((r) => r.title).sort();

  test("listing: each salesman sees their own customer; the manager sees the team's; an unmatched number is for the whole book only", async () => {
    assert.deepEqual(await titles([priya.id]), ["Alpha Paints"]);
    assert.deepEqual(await titles([rakesh.id]), ["Beta Coatings"]);
    assert.deepEqual(await titles([manager.id, priya.id, rakesh.id]), ["Alpha Paints", "Beta Coatings"]);
    assert.deepEqual(await titles([]), [], "nobody's reach, nothing");
    const all = await titles(null);
    assert.equal(all.length, 3, "the whole-book reader also sees the number that matches no record");
  });

  test("searching cannot reach a record outside the viewer's book, by name or by number", async () => {
    assert.deepEqual(await titles([priya.id], "Beta"), []);
    assert.deepEqual(await titles([priya.id], "9820022222"), []);
    assert.deepEqual(await titles([priya.id], "Alpha"), ["Alpha Paints"]);
  });

  test("opening, reading the thread and marking read answer 'not there' for somebody else's conversation, and work for one's own", async () => {
    const mine = await convId(PA);
    const theirs = await convId(PB);
    assert.ok(await getConversation(mine, [priya.id]));
    assert.equal(await getConversation(theirs, [priya.id]), null);
    assert.equal((await threadMessages(theirs, [priya.id])).length, 0);
    assert.equal((await threadMessages(mine, [priya.id])).length, 1);
    await markRead(theirs, [priya.id]);
    assert.equal((await db.select().from(studioWaConversations).where(eq(studioWaConversations.id, theirs)))[0]!.unread, 1, "an outsider's markRead changed nothing");
    await markRead(mine, [priya.id]);
    assert.equal((await db.select().from(studioWaConversations).where(eq(studioWaConversations.id, mine)))[0]!.unread, 0);
  });

  test("the polling API returns only the viewer's conversations and refuses to open another's", async () => {
    const res = await inboxRoute(new Request(`http://x/api/studio/inbox?c=${await convId(PB)}`));
    const body = (await res.json()) as { conversations: { title: string }[]; active: unknown; messages: unknown[] };
    assert.deepEqual(body.conversations.map((c) => c.title), ["Alpha Paints"]);
    assert.equal(body.active, null);
    assert.equal(body.messages.length, 0);
  });

  test("sending: allowed into one's own conversation, refused (and nothing reaches Kapso) into somebody else's or an unmatched number's", async () => {
    await switchOn();
    const own = await sendText({ conversationId: await convId(PA), body: "Hello Alpha", clientKey: "key-own-0001" });
    assert.ok(own.ok, own.ok ? "" : own.error);
    assert.equal(sends().length, 1);
    const other = await sendText({ conversationId: await convId(PB), body: "Hi Beta", clientKey: "key-other-0001" });
    assert.equal(other.ok, false);
    const unmatched = await sendText({ conversationId: await convId(PX), body: "Who is this", clientKey: "key-unmatched01" });
    assert.equal(unmatched.ok, false);
    assert.equal(sends().length, 1, "only the one send to one's own conversation reached Kapso");
  });
});

describe("every Inbox send meets the CRM's safeguards", () => {
  const own = async () => sendText({ conversationId: await convId(PA), body: "Hello Alpha", clientKey: `key-${randomUUID().slice(0, 12)}` });

  test("the founder's switch off refuses a SINGLE send, and on lets it through", async () => {
    const off = await own();
    assert.equal(off.ok, false);
    assert.match(off.ok ? "" : off.error, /switched off/);
    assert.equal(sends().length, 0);
    await switchOn();
    assert.ok((await own()).ok);
    assert.equal(sends().length, 1);
  });

  test("a number any record marks do-not-contact is never messaged — even a record the sender cannot see", async () => {
    await switchOn();
    await makeCustomer(rakesh.id, "9820011111", "Alpha Sister Branch", { doNotContact: true });
    const r = await own();
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /do not contact/i);
    assert.equal(sends().length, 0);
  });

  test("a number that belongs to somebody who works at Mahek is refused", async () => {
    await switchOn();
    await db.update(users).set({ phone: "9820011111" }).where(eq(users.id, rakesh.id));
    const r = await own();
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /works at Mahek/);
    assert.equal(sends().length, 0);
  });

  test("the weekly contact limit (three by default) stops the next send, and zero means no limit", async () => {
    await switchOn();
    for (let i = 0; i < 3; i++) assert.ok((await own()).ok, `send ${i + 1}`);
    const fourth = await own();
    assert.equal(fourth.ok, false);
    assert.match(fourth.ok ? "" : fourth.error, /limit is 3/);
    assert.equal(sends().length, 3);
    await db.insert(appSettings).values({ key: "whatsapp.contactsPerWeekLimit", value: 0, valueType: "integer", category: "whatsapp", label: "x" }).onConflictDoUpdate({ target: appSettings.key, set: { value: 0 } });
    invalidateConfig();
    assert.ok((await own()).ok, "zero is no limit");
  });
});

describe("bulk-sending an uploaded poster answers every recipient and never free-texts outside the window", () => {
  async function startedForward(customerIds: string[]) {
    const form = new FormData();
    form.set("title", "Diwali");
    form.set("file", new File([new Uint8Array(await png())], "p.png", { type: "image/png" }));
    const res = await uploadRoute(new Request("http://x/api/studio/forwards/upload", { method: "POST", body: form }));
    const forwardId = ((await res.json()) as { data: { id: string } }).data.id;
    const started = await startForward({ forwardId, customerIds, caption: "Happy Diwali" });
    assert.ok(started.ok, started.ok ? "" : started.error);
    return forwardId;
  }

  test("the founder's switch off sends nothing", async () => {
    const fid = await startedForward([cA]);
    const r = await sendForwardToRecipients(fid);
    assert.equal(r.ok, false);
    assert.equal(sends().length, 0);
  });

  test("open window: sent; no conversation: skipped with the template limitation; marked-sent: skipped — one outcome per recipient", async () => {
    await switchOn();
    const cNo = await makeCustomer(priya.id, "9820033333", "Gamma Traders");
    const cDone = await makeCustomer(priya.id, "9820044444", "Delta Stores");
    await hear("wamid.D1", "919820044444", "conv-D");
    const fid = await startedForward([cA, cNo, cDone]);
    const [rec] = await db.execute<{ id: string }>(sql`select r.id from studio_forward_recipients r where r.customer_id = ${cDone}`);
    await db.execute(sql`update studio_forward_recipients set status = 'sent' where id = ${rec!.id}`);
    const r = await sendForwardToRecipients(fid);
    assert.ok(r.ok, r.ok ? "" : r.error);
    const byName = Object.fromEntries((r.ok ? r.data.outcomes : []).map((o) => [o.name, o]));
    assert.equal(Object.keys(byName).length, 3, "every recipient has an outcome");
    assert.equal(byName["Alpha Paints"]!.outcome, "sent");
    assert.equal(byName["Gamma Traders"]!.outcome, "skipped");
    assert.match(byName["Gamma Traders"]!.reason ?? "", /template sending is not set up/);
    assert.equal(byName["Delta Stores"]!.outcome, "skipped");
    assert.equal(sends().length, 1, "only the open-window recipient reached Kapso");
  });

  test("a recipient whose window closed 30 hours ago is skipped, never sent free text", async () => {
    await switchOn();
    const cOld = await makeCustomer(priya.id, "9820055555", "Old Window Ltd");
    await hear("wamid.O1", "919820055555", "conv-O", 30);
    const fid = await startedForward([cOld]);
    const r = await sendForwardToRecipients(fid);
    assert.ok(r.ok);
    assert.equal(r.ok ? r.data.outcomes[0]!.outcome : "", "skipped");
    assert.match(r.ok ? (r.data.outcomes[0]!.reason ?? "") : "", /24 hours/);
    assert.equal(sends().length, 0);
  });

  test("a recipient the sender may not see is refused at the start, and one who left the book is skipped", async () => {
    const form = new FormData();
    form.set("title", "T");
    form.set("file", new File([new Uint8Array(await png())], "p.png", { type: "image/png" }));
    const fid = ((await (await uploadRoute(new Request("http://x/api/studio/forwards/upload", { method: "POST", body: form }))).json()) as { data: { id: string } }).data.id;
    const started = await startForward({ forwardId: fid, customerIds: [cB], caption: "x" });
    assert.equal(started.ok, false, "Beta Coatings is Rakesh's");
  });
});

describe("design approval routing is off and picks only an explicit holder", () => {
  test("off: nothing is resolved and nobody is notified", async () => {
    assert.deepEqual(await designApproverFor(priya.id), { enabled: false });
    assert.equal((await db.select().from(notifications)).length, 0);
  });

  test("past the switch it climbs the Org Chart past managers who were not explicitly given Approve designs", async () => {
    const mid = await makeUser("Mid Manager", "manager", ["studio.home"]);
    const wholeApp = await makeUser("Whole App Boss", "admin", []);
    const boss = await makeUser("Senior Boss", "manager", ["studio.home", "studio.approve"]);
    let n = 8000;
    const emp = async (u: typeof users.$inferSelect) => {
      const [e] = await db.insert(employees).values({ id: id("emp"), rowNumber: ++n, employeeCode: `E${n}${randomUUID().slice(0, 4)}`, name: u.name, status: "active", raw: {}, rowHash: id("h") }).returning();
      await db.update(users).set({ employeeId: e.id }).where(eq(users.id, u.id));
      return e;
    };
    const [eP, eM, eW, eB] = [await emp(priya), await emp(mid), await emp(wholeApp), await emp(boss)];
    await db.insert(employeeReporting).values([
      { id: id("rep"), employeeId: eP.id, managerId: eM.id },
      { id: id("rep"), employeeId: eM.id, managerId: eW.id },
      { id: id("rep"), employeeId: eW.id, managerId: eB.id },
    ]);
    const r = await designApproverFor(priya.id, { ignoreSwitch: true });
    assert.ok(r.enabled && r.ok, JSON.stringify(r));
    assert.equal(r.enabled && r.ok ? r.approverId : "", boss.id, "neither the plain manager nor the whole-app admin has the explicit permission");
    assert.equal((await db.select().from(notifications)).length, 0);
  });
});

describe("who reads the company's book from the Studio", () => {
  test("a Studio admin is a manager (themselves and their reports); only a platform administrator is the whole book", async () => {
    const studioAdmin = await makeUser("Studio Admin", "admin", ["studio.home"]);
    await db.update(users).set({ reportsToId: studioAdmin.id }).where(eq(users.id, priya.id));
    setTestUser(studioAdmin);
    const { scope } = await resolveStudioScope();
    assert.notEqual(scope.userIds, null, "Studio admin is not the company");
    assert.ok(scope.userIds!.includes(studioAdmin.id) && scope.userIds!.includes(priya.id));
    assert.ok(!scope.userIds!.includes(rakesh.id), "Rakesh reports to somebody else");

    const platform = await makeUser("Platform Admin", "associate", ["studio.home"]);
    await db.insert(appAccess).values({ id: id("aca"), userId: platform.id, app: "admin", role: "admin" });
    setTestUser(platform);
    assert.equal((await resolveStudioScope()).scope.userIds, null, "a platform administrator keeps the whole book whatever their Studio level says");
  });
});
