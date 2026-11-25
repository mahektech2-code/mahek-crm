/**
 * A POSTER GOES AS THE APPROVED TEMPLATE where WhatsApp will take nothing else — against a real database and a FAKE Kapso
 * (no message is ever really sent). What it proves:
 *
 *   1. with no template named in the settings nothing is sent;
 *   2. a customer who has NEVER written gets the template (image header + body variables) and a chat appears in the Inbox;
 *   3. a customer whose 24-hour window closed gets it too, where a free poster would be refused;
 *   4. when that customer replies, the placeholder chat folds into Kapso's own conversation — one number is never two chats;
 *   5. every other safeguard still holds: the founder's switch, do-not-contact and a staff member's number.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/db";
import { customers, studioWaConversations, studioWaMessages, users, whatsappServiceEvents, appSettings } from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { POST as webhook } from "@/app/api/studio/whatsapp/webhook/route";
import { signBody } from "./domain/inbox-signature";
import { listConversationRows, resetConnectionCache, sendPosterAsTemplate } from "./inbox-service";
import { setKapsoFetch } from "./kapso";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const COMPANY = "919137466424";
const SECRET = "test-webhook-secret";
process.env.KAPSO_API_KEY = "test-key";
process.env.KAPSO_WEBHOOK_SECRET = SECRET;

let calls: { url: string; method: string; body: string | null }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const templateSends = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/messages") && (c.body ?? "").includes('"type":"template"'));

function installFake() {
  setKapsoFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
    if (url.includes("/whatsapp/phone_numbers")) return json(200, { data: [{ phone_number_id: "PN1", name: "Mahek", display_phone_number: "+91 91374 66424", display_phone_number_normalized: COMPANY, status: "CONNECTED", is_coexistence: true, meta_app_id: "app1" }], meta: { page: 1, total_pages: 1 } });
    if (url.endsWith("/media")) return json(200, { id: "MEDIA1" });
    if (url.endsWith("/messages") && method === "POST") return json(200, { messages: [{ id: `wamid.OUT${calls.length}` }] });
    return json(404, { error: "no such route in the fake" });
  });
}

const png = () => sharp({ create: { width: 600, height: 800, channels: 3, background: "#ff8800" } }).png().toBuffer();
const switchOn = async () => void (await db.insert(whatsappServiceEvents).values({ id: id("wse"), active: true, changedByName: "Founder" }));
const setSetting = async (key: string, value: unknown) => {
  await db.insert(appSettings).values({ key, value, valueType: "text", category: "attachments", label: "x" } as never).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  invalidateConfig();
};

let sender: typeof users.$inferSelect;
const PHONE = "9820077777";

async function send(over: Partial<{ phone: string; clientKey: string }> = {}) {
  return sendPosterAsTemplate(sender.id, {
    phone: over.phone ?? PHONE,
    values: { name: "Javed", company: "Gorle Furniture Works", sender: "Priya" },
    caption: "",
    clientKey: over.clientKey ?? `key-${randomUUID().slice(0, 12)}`,
    posterId: null,
    image: new Uint8Array(await png()),
    mime: "image/png",
    filename: "p.png",
    scopeIds: null,
  });
}

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
  const [u] = await db.insert(users).values({ id: id("usr"), name: "Priya Sharma", email: `priya-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", role: "associate", initials: "PS" } as never).returning();
  sender = u!;
});

after(async () => {
  setKapsoFetch(null);
  await db.$client.end();
});

describe("a poster sent as the approved template", () => {
  test("nothing is sent while no template is named", async () => {
    await switchOn();
    const r = await send();
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /No approved WhatsApp template/);
    assert.equal(templateSends().length, 0);
  });

  test("a customer who never wrote gets the template, and the chat appears in the Inbox", async () => {
    await switchOn();
    await setSetting("studio.inbox.posterTemplate", "festival_poster");
    await setSetting("studio.inbox.posterTemplateParams", "name,company");
    const r = await send();
    assert.ok(r.ok, r.ok ? "" : r.error);
    const sent = templateSends();
    assert.equal(sent.length, 1);
    const body = JSON.parse(sent[0]!.body ?? "{}") as { type: string; to: string; template: { name: string; language: { code: string }; components: { type: string; parameters: { type: string; text?: string; image?: { id: string } }[] }[] } };
    assert.equal(body.template.name, "festival_poster");
    assert.equal(body.template.language.code, "en");
    assert.equal(body.template.components[0]!.type, "header");
    assert.equal(body.template.components[0]!.parameters[0]!.image?.id, "MEDIA1");
    assert.deepEqual(body.template.components[1]!.parameters.map((p) => p.text), ["Javed", "Gorle Furniture Works"]);
    const rows = (await listConversationRows({ scopeIds: [] })).rows;
    assert.equal(rows.length, 1, "the chat is in the Inbox although the customer never wrote");
    assert.equal((await db.select().from(studioWaMessages)).length, 1);
  });

  test("a customer whose 24-hour window closed is sent the template, not refused", async () => {
    await switchOn();
    await setSetting("studio.inbox.posterTemplate", "festival_poster");
    await db.insert(studioWaConversations).values({ id: "conv-old", phoneNumberId: "PN1", phone: `91${PHONE}`, phoneKey: PHONE, lastInboundAt: new Date(Date.now() - 30 * 3_600_000), lastMessageAt: new Date(Date.now() - 30 * 3_600_000) });
    const r = await send();
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(templateSends().length, 1);
    assert.equal(r.ok ? r.data.conversationId : "", "conv-old", "it went into the chat that already existed");
  });

  test("when the customer replies the placeholder chat folds into Kapso's conversation", async () => {
    await switchOn();
    await setSetting("studio.inbox.posterTemplate", "festival_poster");
    const r = await send();
    assert.ok(r.ok, r.ok ? "" : r.error);
    const at = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify({
      phone_number_id: "PN1",
      is_new_conversation: false,
      message: { id: "wamid.IN1", timestamp: String(at), type: "text", from: `91${PHONE}`, text: { body: "Thanks!" }, kapso: { direction: "inbound", status: "received", origin: "cloud_api", has_media: false } },
      conversation: { id: "conv-kapso", phone_number: `91${PHONE}`, phone_number_id: "PN1", kapso: { contact_name: "Javed", last_inbound_at: new Date(at * 1000).toISOString() } },
    });
    const res = await webhook(new Request("http://x/api/studio/whatsapp/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Event": "whatsapp.message.received", "X-Idempotency-Key": "wamid.IN1", "X-Webhook-Signature": signBody(raw, SECRET) }, body: raw }));
    assert.equal(res.status, 200);
    const convs = await db.select().from(studioWaConversations).where(eq(studioWaConversations.phoneKey, PHONE));
    assert.equal(convs.length, 1, "one number, one chat");
    assert.equal(convs[0]!.id, "conv-kapso");
    const msgs = await db.select().from(studioWaMessages).where(eq(studioWaMessages.conversationId, "conv-kapso"));
    assert.equal(msgs.length, 2, "the template we sent and the reply are in one thread");
  });
});

describe("the other safeguards still hold for a template", () => {
  test("the founder's switch off sends nothing", async () => {
    await setSetting("studio.inbox.posterTemplate", "festival_poster");
    const r = await send();
    assert.equal(r.ok, false);
    assert.equal(templateSends().length, 0);
  });

  test("a do-not-contact number is never sent a template", async () => {
    await switchOn();
    await setSetting("studio.inbox.posterTemplate", "festival_poster");
    await db.insert(customers).values({ id: id("cus"), name: "Blocked Co", companyName: "Blocked Co", phone: PHONE, city: "Nagpur", kind: "customer", doNotContact: true } as never);
    const r = await send();
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /do not contact/i);
    assert.equal(templateSends().length, 0);
  });

  test("a number that belongs to somebody who works at Mahek is refused", async () => {
    await switchOn();
    await setSetting("studio.inbox.posterTemplate", "festival_poster");
    await db.update(users).set({ phone: PHONE }).where(eq(users.id, sender.id));
    const r = await send();
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /works at Mahek/);
    assert.equal(templateSends().length, 0);
  });

  test("pressing send twice with the same key sends once", async () => {
    await switchOn();
    await setSetting("studio.inbox.posterTemplate", "festival_poster");
    const key = "key-twice-0001";
    assert.ok((await send({ clientKey: key })).ok);
    await send({ clientKey: key });
    assert.equal(templateSends().length, 1);
  });
});
