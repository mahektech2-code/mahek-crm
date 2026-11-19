/**
 * THE STUDIO'S WHATSAPP INBOX, against a real database and a FAKE Kapso (a stand-in for the HTTP calls — never real
 * conversations, never a real message). What it proves: a sandbox number is never shown as the company's; a webhook is
 * verified, stored once and never duplicated; a status only moves forward; the CRM name is matched at read time; a send
 * is refused outside the 24-hour window and for a do-not-contact customer; one press of Send is one message even when the
 * webhook arrives first; and the refresh adds nothing twice.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, studioWaConversations, studioWaMessages, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { refreshFromKapso, sendForward, sendPoster, sendText } from "@/lib/actions/studio-inbox";
import { GET as attachmentsRoute } from "@/app/api/studio/inbox/attachments/route";
import { GET as previewAssetRoute } from "@/app/api/studio/inbox/preview-asset/route";
import { POST as uploadRoute } from "@/app/api/studio/forwards/upload/route";
import { POST as webhook } from "@/app/api/studio/whatsapp/webhook/route";
import { signBody } from "./domain/inbox-signature";
import { applyWebhook, connection, getConversation, listConversationRows, resetConnectionCache, threadMessages } from "./inbox-service";
import { setKapsoFetch } from "./kapso";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const COMPANY = "919137466424";
const SECRET = "test-webhook-secret";
process.env.KAPSO_API_KEY = "test-key";
process.env.KAPSO_WEBHOOK_SECRET = SECRET;

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let numbers: Record<string, unknown>[] = [];
let kapsoConversations: unknown[] = [];
let kapsoMessages: Record<string, unknown[]> = {};
let onSend: (() => Promise<void>) | null = null;
let sendAnswer: { status: number; body: unknown } | "throw" | null = null;
let nextWamid = "wamid.SENT1";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function installFake() {
  setKapsoFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    let body: unknown = init?.body ?? null;
    if (typeof body === "string") body = JSON.parse(body);
    else if (body instanceof FormData) body = { form: true };
    calls.push({ url, method, body });
    if (url.includes("/whatsapp/phone_numbers")) return json(200, { data: numbers, meta: { page: 1, total_pages: 1 } });
    if (url.includes("/whatsapp/conversations")) return json(200, { data: kapsoConversations, paging: { cursors: {}, next: null } });
    if (url.includes("/whatsapp/messages")) {
      const c = new URL(url).searchParams.get("conversation_id") ?? "";
      return json(200, { data: kapsoMessages[c] ?? [], paging: { cursors: {}, next: null } });
    }
    if (url.endsWith("/media")) return json(200, { id: "MEDIA1" });
    if (url.endsWith("/messages") && method === "POST") {
      if (sendAnswer === "throw") throw new Error("socket hang up");
      if (sendAnswer) return json(sendAnswer.status, sendAnswer.body);
      if (onSend) await onSend();
      return json(200, { messages: [{ id: nextWamid }] });
    }
    return json(404, { error: "no such route in the fake" });
  });
}

const live = (over: Record<string, unknown> = {}) => ({ phone_number_id: "PN1", name: "Mahek", display_phone_number: "+91 91374 66424", display_phone_number_normalized: COMPANY, status: "CONNECTED", is_coexistence: true, meta_app_id: "app1", ...over });
const sandbox = { phone_number_id: "SB1", name: "Sandbox WhatsApp", display_phone_number: "+1 555 000 1111", display_phone_number_normalized: "15550001111", status: "CONNECTED", meta_app_id: null };

const inboundBody = (wamid: string, over: { conv?: string; phone?: string; name?: string | null; at?: string; text?: string; pn?: string } = {}) => ({
  phone_number_id: over.pn ?? "PN1",
  is_new_conversation: false,
  message: { id: wamid, timestamp: over.at ?? String(Math.floor(Date.now() / 1000)), type: "text", from: over.phone ?? "919820011111", text: { body: over.text ?? "Hi" }, kapso: { direction: "inbound", status: "received", origin: "cloud_api", has_media: false } },
  conversation: { id: over.conv ?? "conv-1", phone_number: over.phone ?? "919820011111", phone_number_id: over.pn ?? "PN1", kapso: { contact_name: over.name === undefined ? "Shree WA" : over.name, last_inbound_at: new Date().toISOString() } },
});
const outboundBody = (wamid: string, status: string, conv = "conv-1", pn = "PN1") => ({
  phone_number_id: pn,
  message: { id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", to: "919820011111", text: { body: "Sure" }, kapso: { direction: "outbound", status, origin: "cloud_api" } },
  conversation: { id: conv, phone_number: "919820011111", phone_number_id: pn, kapso: { contact_name: "Shree WA" } },
});

async function post(event: string, body: unknown, key: string, opts: { secret?: string; sign?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Webhook-Event": event, "X-Idempotency-Key": key };
  if (opts.sign !== false) headers["X-Webhook-Signature"] = signBody(raw, opts.secret ?? SECRET);
  return webhook(new Request("http://x/api/studio/whatsapp/webhook", { method: "POST", headers, body: raw }));
}

async function makeUser(name: string, modules: string[]) {
  const [row] = await db.insert(users).values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", role: "associate", initials: name.slice(0, 2).toUpperCase() }).returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "studio", role: "associate" });
  for (const m of modules) await db.insert(appModuleAccess).values({ id: id("amx"), userId: row.id, app: "studio", module: m });
  return row;
}

let priya: typeof users.$inferSelect;
const sends = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/messages"));
const count = async () => Number((await db.select({ n: sql<number>`count(*)::int` }).from(studioWaMessages))[0].n);

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table studio_wa_messages, studio_wa_conversations, studio_wa_events, studio_forward_recipients, studio_forwards, studio_poster_shares, studio_posters,
      customer_contacts, customers, attachment_bytes, audit_log, app_module_access, app_access, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  resetConnectionCache();
  calls = [];
  numbers = [live()];
  kapsoConversations = [];
  kapsoMessages = {};
  onSend = null;
  sendAnswer = null;
  nextWamid = "wamid.SENT1";
  installFake();
  priya = await makeUser("Priya Sharma", ["studio.inbox", "studio.forward"]);
  setTestUser(priya);
});

after(async () => {
  setKapsoFetch(null);
  setTestUser(null);
  await db.$client.end();
});

describe("the connection is judged from Kapso's own list", () => {
  test("only a sandbox number is NOT the company's WhatsApp", async () => {
    numbers = [sandbox];
    const c = await connection({ force: true });
    assert.equal(c.state, "not_connected");
    if (c.state === "not_connected") assert.equal(c.reason, "sandbox_only");
    const page = await listConversationRows();
    assert.equal(page.rows.length, 0);
  });
  test("a live number that is not the company's is 'number missing', and the company number is connected when present", async () => {
    numbers = [live({ display_phone_number_normalized: "919999999999", phone_number_id: "OTHER" })];
    const c = await connection({ force: true });
    assert.equal(c.state === "not_connected" && c.reason, "number_missing");
    numbers = [sandbox, live()];
    const d = await connection({ force: true });
    assert.equal(d.state, "connected");
    if (d.state === "connected") assert.equal(d.phoneNumberId, "PN1");
  });
  test("an unreachable or rejecting Kapso is said, never papered over", async () => {
    setKapsoFetch(async () => json(401, { error: "bad key" }));
    const c = await connection({ force: true });
    assert.equal(c.state, "rejected");
  });
});

describe("the webhook", () => {
  test("is refused without a valid signature and stores nothing", async () => {
    assert.equal((await post("whatsapp.message.received", inboundBody("wamid.A"), "k1", { sign: false })).status, 401);
    assert.equal((await post("whatsapp.message.received", inboundBody("wamid.A"), "k1", { secret: "wrong" })).status, 401);
    assert.equal(await count(), 0);
  });

  test("stores a received message once, however many times Kapso retries it", async () => {
    const r1 = await post("whatsapp.message.received", inboundBody("wamid.IN1"), "key-1");
    assert.equal(r1.status, 200);
    assert.equal(((await r1.json()) as { result: string }).result, "stored");
    const r2 = await post("whatsapp.message.received", inboundBody("wamid.IN1"), "key-1");
    assert.equal(((await r2.json()) as { result: string }).result, "duplicate");
    assert.equal(await count(), 1);
    const conv = await getConversation("conv-1");
    assert.equal(conv?.unread, 1);
    assert.equal(conv?.windowOpen, true);
  });

  test("the same message under a NEW key (another status) merges into the one row, and a status never moves backwards", async () => {
    await post("whatsapp.message.received", inboundBody("wamid.IN1"), "k-in");
    await post("whatsapp.message.sent", outboundBody("wamid.OUT1", "sent"), "k-s");
    await post("whatsapp.message.read", outboundBody("wamid.OUT1", "read"), "k-r");
    await post("whatsapp.message.delivered", outboundBody("wamid.OUT1", "delivered"), "k-d");
    const msgs = await threadMessages("conv-1");
    const out = msgs.filter((m) => m.direction === "outbound");
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "read");
  });

  test("a message for another number in the project is ignored, and nothing is filed while the company number is unconfirmed", async () => {
    const r = await post("whatsapp.message.received", inboundBody("wamid.X", { pn: "OTHER" }), "k-o");
    assert.equal(((await r.json()) as { result: string }).result, "ignored");
    assert.equal(await count(), 0);
    resetConnectionCache();
    numbers = [sandbox];
    const u = await post("whatsapp.message.received", inboundBody("wamid.Y"), "k-u");
    assert.equal(u.status, 503);
    assert.equal(await count(), 0);
  });
});

describe("names come from the CRM where the number is a customer's", () => {
  test("matched on the last ten digits of any phone on the record; else WhatsApp's name; else the number", async () => {
    const [owner] = await db.select().from(users).limit(1);
    await db.insert(customers).values({ id: id("cus"), name: "Shree Paints (CRM)", companyName: "Shree Paints", phone: "98200 11111", city: "Nagpur", kind: "customer", ownerId: owner.id, salesAmId: owner.id } as never);
    await post("whatsapp.message.received", inboundBody("wamid.1", { conv: "c-crm", phone: "919820011111", name: "Shree WA" }), "m1");
    await post("whatsapp.message.received", inboundBody("wamid.2", { conv: "c-wa", phone: "919811122233", name: "Walk-in Buyer" }), "m2");
    await post("whatsapp.message.received", inboundBody("wamid.3", { conv: "c-num", phone: "919833344455", name: null }), "m3");
    const { rows } = await listConversationRows();
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(by["c-crm"].title, "Shree Paints (CRM)");
    assert.equal(by["c-crm"].nameSource, "crm");
    assert.equal(by["c-wa"].title, "Walk-in Buyer");
    assert.equal(by["c-wa"].nameSource, "whatsapp");
    assert.equal(by["c-num"].title, "+919833344455");
    const found = await listConversationRows({ q: "walk" });
    assert.deepEqual(found.rows.map((r) => r.id), ["c-wa"]);
    const byCrm = await listConversationRows({ q: "shree" });
    assert.deepEqual(byCrm.rows.map((r) => r.id), ["c-crm"]);
  });
});

describe("sending", () => {
  beforeEach(async () => {
    await post("whatsapp.message.received", inboundBody("wamid.IN0"), "seed-in");
    calls = [];
  });

  test("a text goes once, is recorded with who sent it, and a second press of the same Send is not a second message", async () => {
    const a = await sendText({ conversationId: "conv-1", body: "On its way", clientKey: "clientkey-0001" });
    assert.ok(a.ok, a.ok ? "" : a.error);
    const b = await sendText({ conversationId: "conv-1", body: "On its way", clientKey: "clientkey-0001" });
    assert.ok(b.ok);
    assert.equal(sends().length, 1);
    assert.deepEqual((sends()[0].body as { to: string; text: { body: string } }).to, "919820011111");
    const out = (await threadMessages("conv-1")).filter((m) => m.direction === "outbound");
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "sent");
    assert.equal(out[0].sentByName, "Priya Sharma");
    assert.equal(out[0].body, "On its way");
  });

  test("the webhook arriving BEFORE the send call returns still leaves one row", async () => {
    nextWamid = "wamid.RACE";
    onSend = async () => {
      await post("whatsapp.message.delivered", outboundBody("wamid.RACE", "delivered"), "race-1");
    };
    const r = await sendText({ conversationId: "conv-1", body: "Race", clientKey: "clientkey-0002" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const out = (await threadMessages("conv-1")).filter((m) => m.direction === "outbound");
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "delivered");
    assert.equal(out[0].sentByName, "Priya Sharma");
  });

  test("outside the 24-hour window nothing is sent — the refusal says why", async () => {
    await db.update(studioWaConversations).set({ lastInboundAt: new Date(Date.now() - 30 * 3_600_000) }).where(eq(studioWaConversations.id, "conv-1"));
    const r = await sendText({ conversationId: "conv-1", body: "Hello?", clientKey: "clientkey-0003" });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /24 hours/);
    assert.equal(sends().length, 0);
  });

  test("a do-not-contact customer and a WhatsApp-DND customer are never messaged from the Studio", async () => {
    const [owner] = await db.select().from(users).limit(1);
    const cid = id("cus");
    await db.insert(customers).values({ id: cid, name: "Blocked Co", companyName: "Blocked Co", phone: "9820011111", city: "Nagpur", kind: "customer", ownerId: owner.id, salesAmId: owner.id, doNotContact: true } as never);
    const a = await sendText({ conversationId: "conv-1", body: "Hi", clientKey: "clientkey-0004" });
    assert.equal(a.ok, false);
    assert.match(a.ok ? "" : a.error, /do not contact/i);
    await db.update(customers).set({ doNotContact: false, whatsappDnd: true }).where(eq(customers.id, cid));
    const b = await sendText({ conversationId: "conv-1", body: "Hi", clientKey: "clientkey-0005" });
    assert.equal(b.ok, false);
    assert.match(b.ok ? "" : b.error, /not to be messaged on WhatsApp/i);
    assert.equal(sends().length, 0);
  });

  test("a refusal from Kapso is recorded as failed, with its reason, and never retried", async () => {
    sendAnswer = { status: 422, body: { error: { message: "Template required", code: 131047 } } };
    const r = await sendText({ conversationId: "conv-1", body: "Hi", clientKey: "clientkey-0006" });
    assert.equal(r.ok, false);
    const out = (await threadMessages("conv-1")).filter((m) => m.direction === "outbound");
    assert.equal(out[0].status, "failed");
    assert.match(out[0].errorText ?? "", /Template required/);
    assert.equal(sends().length, 1);
  });

  test("a lost connection is marked failed AND says it is not known whether the message went", async () => {
    sendAnswer = "throw";
    const r = await sendText({ conversationId: "conv-1", body: "Hi", clientKey: "clientkey-0007" });
    assert.equal(r.ok, false);
    const out = (await threadMessages("conv-1")).filter((m) => m.direction === "outbound");
    assert.equal(out[0].status, "failed");
    assert.match(out[0].errorText ?? "", /not known whether/);
  });

  test("a user without the Inbox cannot send, and nothing reaches Kapso", async () => {
    const nobody = await makeUser("No Inbox", ["studio.home"]);
    setTestUser(nobody);
    const r = await sendText({ conversationId: "conv-1", body: "Hi", clientKey: "clientkey-0008" });
    assert.equal(r.ok, false);
    assert.equal(sends().length, 0);
  });

  test("a poster picture goes up as media and is sent with its caption in one message", async () => {
    const png = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#ff8800" } }).png().toBuffer();
    const form = new FormData();
    form.set("title", "Diwali greeting");
    form.set("file", new File([new Uint8Array(png)], "poster.png", { type: "image/png" }));
    const up = (await (await uploadRoute(new Request("http://x/api/studio/forwards/upload", { method: "POST", body: form }))).json()) as { ok: boolean; data: { id: string } };
    assert.ok(up.ok);
    const r = await sendForward({ conversationId: "conv-1", forwardId: up.data.id, caption: "Happy Diwali from Mahek", clientKey: "clientkey-0009" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(calls.filter((c) => c.url.endsWith("/media")).length, 1);
    const body = sends()[0].body as { type: string; image: { id: string; caption: string } };
    assert.equal(body.type, "image");
    assert.equal(body.image.id, "MEDIA1");
    assert.equal(body.image.caption, "Happy Diwali from Mahek");
    const out = (await threadMessages("conv-1")).filter((m) => m.direction === "outbound");
    assert.equal(out.length, 1);
    assert.equal(out[0].hasMedia, true);
    assert.equal(out[0].caption, "Happy Diwali from Mahek");
  });
});

describe("refresh from Kapso", () => {
  test("fills conversations and messages (including ones written on the phone), and a second refresh adds nothing", async () => {
    const t = Math.floor(Date.now() / 1000);
    kapsoConversations = [{ id: "sync-1", phone_number: "919820011111", phone_number_id: "PN1", kapso: { contact_name: "Shree WA", last_message_timestamp: String(t), last_message_text: "Thanks", last_inbound_at: new Date(t * 1000).toISOString() } }];
    kapsoMessages = {
      "sync-1": [
        { id: "wamid.S2", timestamp: String(t), type: "text", text: { body: "Thanks" }, kapso: { direction: "inbound", status: "received", origin: "cloud_api" } },
        { id: "wamid.S1", timestamp: String(t - 60), type: "text", to: "919820011111", text: { body: "Sent from the phone" }, kapso: { direction: "outbound", status: "delivered", origin: "business_app" } },
      ],
    };
    const r = await refreshFromKapso();
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(await count(), 2);
    const msgs = await threadMessages("sync-1");
    assert.deepEqual(msgs.map((m) => m.body), ["Sent from the phone", "Thanks"]);
    assert.equal(msgs[0].origin, "business_app");
    const conv = await getConversation("sync-1");
    assert.equal(conv?.unread, 0, "a first fill does not make every old message unread");
    const again = await refreshFromKapso();
    assert.ok(again.ok);
    assert.equal(await count(), 2);
  });

  test("says so when the company number is not connected, and fills nothing", async () => {
    numbers = [sandbox];
    const r = await refreshFromKapso();
    assert.equal(r.ok, false);
    assert.equal(await count(), 0);
  });
});

describe("a webhook helper straight on the service", () => {
  test("an event other than a message is ignored, not stored", async () => {
    const r = await applyWebhook({ event: "whatsapp.conversation.created", key: "z", body: {} });
    assert.equal(r.result, "ignored");
  });
});

describe("the local preview (sample data) is in memory only, and switching it off restores the real, disconnected inbox", () => {
  const prev = process.env.STUDIO_INBOX_PREVIEW;
  after(() => {
    if (prev === undefined) delete process.env.STUDIO_INBOX_PREVIEW;
    else process.env.STUDIO_INBOX_PREVIEW = prev;
  });

  test("with the switch on it lists labelled sample conversations, sends nothing to Kapso and writes nothing to the database", async () => {
    process.env.STUDIO_INBOX_PREVIEW = "1";
    calls = [];
    const page = await listConversationRows();
    assert.equal(page.connection.state, "preview");
    assert.ok(page.rows.length >= 6);
    const open = page.rows.find((r) => r.windowOpen && !r.blocked);
    assert.ok(open);
    const r = await sendText({ conversationId: open.id, body: "Preview only", clientKey: "clientkey-pv01" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const again = await sendText({ conversationId: open.id, body: "Preview only", clientKey: "clientkey-pv01" });
    assert.ok(again.ok);
    const thread = await threadMessages(open.id);
    assert.equal(thread.filter((m) => m.body === "Preview only").length, 1);
    assert.equal(calls.length, 0, "no call reached Kapso");
    assert.equal(await count(), 0, "no message row was stored");
    assert.equal(Number((await db.select({ n: sql<number>`count(*)::int` }).from(studioWaConversations))[0].n), 0);
    const closed = page.rows.find((r) => !r.windowOpen);
    assert.ok(closed);
    const refused = await sendText({ conversationId: closed.id, body: "x", clientKey: "clientkey-pv02" });
    assert.equal(refused.ok, false);
    const blocked = page.rows.find((r) => r.blocked);
    assert.ok(blocked);
    assert.equal((await sendText({ conversationId: blocked.id, body: "x", clientKey: "clientkey-pv03" })).ok, false);
  });

  test("with the switch off the Inbox is the genuine one: no sample rows, and the real connection state", async () => {
    delete process.env.STUDIO_INBOX_PREVIEW;
    numbers = [sandbox];
    resetConnectionCache();
    const page = await listConversationRows();
    assert.equal(page.connection.state, "not_connected");
    assert.equal(page.rows.length, 0);
  });
});

describe("the preview's pictures are generic and local-only", () => {
  const prev = process.env.STUDIO_INBOX_PREVIEW;
  after(() => {
    if (prev === undefined) delete process.env.STUDIO_INBOX_PREVIEW;
    else process.env.STUDIO_INBOX_PREVIEW = prev;
  });

  test("with the preview on, both picker tabs list labelled sample pictures — never a database poster or forward — and sending one adds only to the sample chat", async () => {
    process.env.STUDIO_INBOX_PREVIEW = "1";
    calls = [];
    const posters = (await (await attachmentsRoute(new Request("http://x/api/studio/inbox/attachments?kind=posters"))).json()) as { items: { id: string; title: string }[] };
    const forwards = (await (await attachmentsRoute(new Request("http://x/api/studio/inbox/attachments?kind=forwards"))).json()) as { items: { id: string; title: string }[] };
    assert.ok(posters.items.length >= 3 && posters.items.every((i) => /^pvp-\d$/.test(i.id) && /sample/i.test(i.title)));
    assert.ok(forwards.items.length >= 2 && forwards.items.every((i) => /^pvf-\d$/.test(i.id) && /sample/i.test(i.title)));
    const png = await previewAssetRoute(new Request("http://x/api/studio/inbox/preview-asset?id=pvp-1"));
    assert.equal(png.status, 200);
    assert.equal((await previewAssetRoute(new Request("http://x/api/studio/inbox/preview-asset?id=not-an-asset"))).status, 404);
    const { rows } = await listConversationRows();
    const open = rows.find((r) => r.windowOpen && !r.blocked);
    assert.ok(open);
    const r = await sendPoster({ conversationId: open.id, posterId: "pvp-2", caption: "Sample caption", clientKey: "clientkey-pv11" });
    assert.ok(r.ok, r.ok ? "" : r.error);
    const f = await sendForward({ conversationId: open.id, forwardId: "pvf-1", caption: "", clientKey: "clientkey-pv12" });
    assert.ok(f.ok, f.ok ? "" : f.error);
    const sent = (await threadMessages(open.id)).filter((m) => m.hasMedia && m.sentByName === "Priya Sharma" && m.posterId?.startsWith("pv"));
    assert.ok(sent.length >= 2);
    assert.equal(calls.length, 0);
    assert.equal(await count(), 0);
  });

  test("a DND sample conversation refuses a poster too, and with the preview off the pictures route does not exist", async () => {
    process.env.STUDIO_INBOX_PREVIEW = "1";
    const { rows } = await listConversationRows();
    const dnd = rows.find((r) => r.blocked === "whatsapp_dnd");
    assert.ok(dnd);
    const refused = await sendPoster({ conversationId: dnd.id, posterId: "pvp-1", caption: "", clientKey: "clientkey-pv13" });
    assert.equal(refused.ok, false);
    delete process.env.STUDIO_INBOX_PREVIEW;
    assert.equal((await previewAssetRoute(new Request("http://x/api/studio/inbox/preview-asset?id=pvp-1"))).status, 404);
    const off = await sendPoster({ conversationId: dnd.id, posterId: "pvp-1", caption: "", clientKey: "clientkey-pv14" });
    assert.equal(off.ok, false, "with the preview off a preview picture id is just an unknown poster");
  });
});
