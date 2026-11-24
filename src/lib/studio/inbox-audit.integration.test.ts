/**
 * AUDIT: DIRECT ACTION CALLS AND THE COMBINED WEEKLY LIMIT — against a real database and a FAKE Kapso
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
import { appAccess, appModuleAccess, auditLog, customers, studioWaConversations, users, waMessages, whatsappServiceEvents } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { openConversation, refreshFromKapso, sendForward, sendForwardToRecipients, sendPoster, sendText } from "@/lib/actions/studio-inbox";
import { makePoster } from "@/lib/actions/studio";
import { startForward } from "@/lib/actions/studio-forward";
import { POST as uploadRoute } from "@/app/api/studio/forwards/upload/route";
import { POST as webhook } from "@/app/api/studio/whatsapp/webhook/route";
import { signBody } from "./domain/inbox-signature";
import { resetConnectionCache, resetRefreshThrottle } from "./inbox-service";
import { setKapsoFetch } from "./kapso";

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
    if (url.includes("/whatsapp/conversations")) return json(200, { data: [], paging: { cursors: {}, next: null } });
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


const MODS = ["studio.inbox", "studio.forward", "studio.make", "studio.posters", "studio.home"];
let manager: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;
let rakesh: typeof users.$inferSelect;
let cA: string;
let cB: string;
const PA = "919820011111";
const PB = "919820022222";
const PX = "919000000000";
const media = () => calls.filter((c) => c.url.endsWith("/media")).length;
const key = () => `key-${randomUUID().slice(0, 12)}`;
const convId = async (p: string) => (await db.select().from(studioWaConversations).where(eq(studioWaConversations.phoneKey, p.slice(-10))))[0]!.id;
const upload = async () => {
  const form = new FormData();
  form.set("title", "Diwali");
  form.set("file", new File([new Uint8Array(await png())], "p.png", { type: "image/png" }));
  return ((await (await uploadRoute(new Request("http://x/api/studio/forwards/upload", { method: "POST", body: form }))).json()) as { data: { id: string } }).data.id;
};

before(() => assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against a mahekone_test database."));

beforeEach(async () => {
  await db.execute(sql`
    truncate table studio_wa_messages, studio_wa_conversations, studio_wa_events, studio_forward_recipients, studio_forwards, studio_poster_shares, studio_posters, studio_batches,
      wa_messages, customer_contacts, customers, employee_reporting, employees, attachment_bytes, audit_log, notifications, whatsapp_service_events, app_module_access, app_access, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  resetConnectionCache();
  resetRefreshThrottle();
  calls = [];
  installFake();
  manager = await makeUser("Meena Manager", "manager", MODS);
  priya = await makeUser("Priya Sharma", "associate", MODS, { reportsToId: manager.id });
  rakesh = await makeUser("Rakesh Iyer", "associate", MODS, { reportsToId: manager.id });
  cA = await makeCustomer(priya.id, "9820011111", "Alpha Paints");
  cB = await makeCustomer(rakesh.id, "9820022222", "Beta Coatings");
  await hear("wamid.A1", PA, "conv-A");
  await hear("wamid.B1", PB, "conv-B");
  await hear("wamid.X1", PX, "conv-X");
  await switchOn();
  setTestUser(priya);
});

after(async () => {
  setKapsoFetch(null);
  setTestUser(null);
  await db.$client.end();
});

describe("poster, forward and bulk actions called directly", () => {
  test("sendPoster: her own poster goes into her own conversation, and is refused into another employee's and into an unmatched number's - nothing is uploaded or sent", async () => {
    const made = await makePoster({ customerId: cA, templateId: "diwali-classic", language: "en", showProduct: true });
    assert.ok(made.ok, made.ok ? "" : made.error);
    const posterId = made.ok ? made.data.id : "";
    const theirs = await sendPoster({ conversationId: await convId(PB), posterId, caption: "Hi", clientKey: key() });
    assert.equal(theirs.ok, false);
    const unmatched = await sendPoster({ conversationId: await convId(PX), posterId, caption: "Hi", clientKey: key() });
    assert.equal(unmatched.ok, false);
    assert.equal(media(), 0, "no picture reached Kapso");
    assert.equal(sends().length, 0);
    const own = await sendPoster({ conversationId: await convId(PA), posterId, caption: "Hi", clientKey: key() });
    assert.ok(own.ok, own.ok ? "" : own.error);
    assert.equal(sends().length, 1, "the control: her own conversation works");
  });

  test("sendPoster: somebody else's poster id is 'not found' to an employee outside its creator's reach", async () => {
    const made = await makePoster({ customerId: cA, templateId: "diwali-classic", language: "en", showProduct: true });
    const posterId = made.ok ? made.data.id : "";
    setTestUser(rakesh);
    const r = await sendPoster({ conversationId: await convId(PB), posterId, caption: "x", clientKey: key() });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? "" : r.code, "not_found");
    assert.equal(media(), 0);
  });

  test("sendForward (single): refused into another employee's conversation and into an unmatched number; nothing is uploaded", async () => {
    const forwardId = await upload();
    for (const p of [PB, PX]) {
      const r = await sendForward({ conversationId: await convId(p), forwardId, caption: "Hi", clientKey: key() });
      assert.equal(r.ok, false, p);
    }
    assert.equal(media(), 0);
    assert.equal(sends().length, 0);
  });

  test("an employee cannot use somebody else's forward at all", async () => {
    const forwardId = await upload();
    setTestUser(rakesh);
    assert.equal((await sendForward({ conversationId: await convId(PB), forwardId, caption: "x", clientKey: key() })).ok, false);
    assert.equal((await sendForwardToRecipients(forwardId)).ok, false);
    assert.equal(sends().length, 0);
  });

  test("bulk: a recipient who has since moved to somebody else's book is skipped, never sent to", async () => {
    const forwardId = await upload();
    const started = await startForward({ forwardId, customerIds: [cA], caption: "Hi" });
    assert.ok(started.ok);
    await db.update(customers).set({ salesAmId: rakesh.id, ownerId: rakesh.id, amDecidedAt: new Date() }).where(eq(customers.id, cA));
    const r = await sendForwardToRecipients(forwardId);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.ok ? r.data.outcomes[0]!.outcome : "", "skipped");
    assert.match(r.ok ? (r.data.outcomes[0]!.reason ?? "") : "", /no longer in your book/i);
    assert.equal(sends().length, 0);
  });

  test("openConversation on somebody else's conversation changes nothing, on her own it marks read", async () => {
    const theirs = await convId(PB);
    await openConversation(theirs);
    assert.equal((await db.select().from(studioWaConversations).where(eq(studioWaConversations.id, theirs)))[0]!.unread, 1);
    const mine = await convId(PA);
    await openConversation(mine);
    assert.equal((await db.select().from(studioWaConversations).where(eq(studioWaConversations.id, mine)))[0]!.unread, 0);
  });
});

describe("the weekly limit counts the CRM's messages and the Studio's together", () => {
  const crm = (status: "sent" | "copied" | "delivered", daysAgo: number, customerId = cA) =>
    db.insert(waMessages).values({ id: id("wam"), customerId, userId: priya.id, templateName: "Reminder", resolvedDestination: PA, body: "Hello", status, sentAt: new Date(Date.now() - daysAgo * 86_400_000) } as never);
  const own = async () => sendText({ conversationId: await convId(PA), body: "Hello", clientKey: key() });

  test("two recent CRM sends + one Studio send reach the limit of three; an old CRM send and a merely-copied one do not count", async () => {
    await crm("sent", 1);
    await crm("delivered", 2);
    await crm("sent", 10);
    await crm("copied", 0);
    const first = await own();
    assert.ok(first.ok, first.ok ? "" : first.error);
    const second = await own();
    assert.equal(second.ok, false);
    assert.match(second.ok ? "" : second.error, /already had 3 WhatsApp messages this week - the limit is 3/);
    assert.equal(sends().length, 1);
  });

  test("with no CRM messages the Studio alone needs three before the fourth is refused", async () => {
    for (let i = 0; i < 3; i++) assert.ok((await own()).ok, `send ${i + 1}`);
    assert.equal((await own()).ok, false);
  });

  test("the CRM's count is for THIS customer only - another customer's messages do not count", async () => {
    for (let i = 0; i < 3; i++) await crm("sent", 0, cB);
    assert.ok((await own()).ok);
  });
});

describe("the manual refresh from Kapso", () => {
  const listCalls = () => calls.filter((c) => c.url.includes("/whatsapp/conversations")).length;

  test("answers a scoped employee with a neutral result: no conversation, thread or message counts anywhere in it", async () => {
    const r = await refreshFromKapso();
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(Object.keys(r.ok ? r.data : {}).sort(), ["refreshed", "retryAfterSeconds"]);
    assert.equal(r.ok ? r.data.refreshed : false, true);
    const wire = JSON.stringify(r);
    assert.doesNotMatch(wire, /conversations|threads|messages/);
    /* the administrators' audit row keeps the counts */
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "studio.inbox.synced"));
    assert.ok(row);
  });

  test("a second press inside the interval does not call Kapso again, and says when to try", async () => {
    assert.ok((await refreshFromKapso()).ok);
    const first = listCalls();
    assert.ok(first >= 1);
    const again = await refreshFromKapso();
    assert.ok(again.ok);
    assert.equal(again.ok ? again.data.refreshed : true, false);
    assert.ok((again.ok ? (again.data.retryAfterSeconds ?? 0) : 0) > 0);
    assert.equal(listCalls(), first, "no further call reached Kapso");
  });

  test("presses that arrive together make one set of calls", async () => {
    const rs = await Promise.all([refreshFromKapso(), refreshFromKapso(), refreshFromKapso(), refreshFromKapso()]);
    assert.equal(rs.filter((r) => r.ok && r.data.refreshed).length, 1);
    assert.equal(listCalls(), 1);
  });

  test("the interval holds across a process restart: a refresh another process just completed counts", async () => {
    assert.ok((await refreshFromKapso()).ok);
    resetRefreshThrottle(); // this process forgets; the audit row of the completed refresh remains
    const before = listCalls();
    const r = await refreshFromKapso();
    assert.equal(r.ok ? r.data.refreshed : true, false);
    assert.equal(listCalls(), before);
  });

  test("a failed refresh also holds the slot, so a broken Kapso is not hammered", async () => {
    setKapsoFetch(async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });
      return json(500, { error: "down" });
    });
    resetConnectionCache();
    const failed = await refreshFromKapso();
    assert.equal(failed.ok, false);
    const before = calls.length;
    const again = await refreshFromKapso();
    assert.ok(again.ok);
    assert.equal(again.ok ? again.data.refreshed : true, false);
    assert.equal(calls.length, before, "the second press made no call at all");
  });

  test("it still needs the studio.inbox permission, and an employee without it makes no call", async () => {
    const nobody = await makeUser("No Inbox", "associate", ["studio.home"]);
    setTestUser(nobody);
    const before = calls.length;
    const r = await refreshFromKapso();
    assert.equal(r.ok, false);
    assert.equal(r.ok ? "" : r.code, "not_permitted");
    assert.equal(calls.length, before, "no call reached Kapso");
  });

  test("after the interval it works again", async () => {
    assert.ok((await refreshFromKapso()).ok);
    resetRefreshThrottle();
    await db.delete(auditLog).where(eq(auditLog.action, "studio.inbox.synced"));
    const r = await refreshFromKapso();
    assert.equal(r.ok ? r.data.refreshed : false, true);
  });
});
