/**
 * THE STUDIO TIMELINE against a real database and a FAKE Kapso (no real message is ever sent). What it proves:
 * every recipient of a bulk send has a row of their own (sent, or not sent with the reason); a Kapso send shows only
 * what Kapso reported and only moves forward; a mark made by hand is never worded as a delivery; the right sender and
 * recipient are on every row; a row is seen only by somebody the CRM lets see its customer, through the page's read
 * AND the history API; and the history outlives the content, the customer and the employee it names.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, studioActivities, studioForwards, studioWaMessages, users, whatsappServiceEvents } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { sendForward, sendForwardToRecipients, sendText } from "@/lib/actions/studio-inbox";
import { markRecipient, openRecipientChat, startForward } from "@/lib/actions/studio-forward";
import { makeBatch } from "@/lib/actions/studio";
import { GET as zipRoute } from "@/app/api/studio/batches/[id]/zip/route";
import { GET as timelineRoute } from "@/app/api/studio/timeline/route";
import { POST as uploadRoute } from "@/app/api/studio/forwards/upload/route";
import { POST as webhook } from "@/app/api/studio/whatsapp/webhook/route";
import { signBody } from "./domain/inbox-signature";
import { resetConnectionCache } from "./inbox-service";
import { setKapsoFetch } from "./kapso";
import { recordBatchZipDownload, timelineRows } from "./timeline-service";

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

async function post(event: string, body: unknown, key: string) {
  const raw = JSON.stringify(body);
  const res = await webhook(new Request("http://x/api/studio/whatsapp/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Event": event, "X-Idempotency-Key": key, "X-Webhook-Signature": signBody(raw, SECRET) }, body: raw }));
  assert.equal(res.status, 200);
}
const inbound = (wamid: string, phone: string, conv: string, ageHours = 0) => {
  const at = Math.floor(Date.now() / 1000) - ageHours * 3600;
  return { phone_number_id: "PN1", is_new_conversation: false, message: { id: wamid, timestamp: String(at), type: "text", from: phone, text: { body: "Hello" }, kapso: { direction: "inbound", status: "received", origin: "cloud_api", has_media: false } }, conversation: { id: conv, phone_number: phone, phone_number_id: "PN1", kapso: { contact_name: "WA name", last_inbound_at: new Date(at * 1000).toISOString() } } };
};
const hear = (wamid: string, phone: string, conv: string, ageHours = 0) => post("whatsapp.message.received", inbound(wamid, phone, conv, ageHours), wamid);
const outboundEvent = (wamid: string, status: string, phone: string, conv: string) => ({
  phone_number_id: "PN1",
  message: { id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "image", to: phone, kapso: { direction: "outbound", status, origin: "cloud_api", has_media: true } },
  conversation: { id: conv, phone_number: phone, phone_number_id: "PN1", kapso: { contact_name: "WA name" } },
});

async function makeUser(name: string, level: "associate" | "manager" | "admin", modules: string[], over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", role: level, initials: name.slice(0, 2).toUpperCase(), ...over } as never)
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "studio", role: level });
  for (const m of modules) await db.insert(appModuleAccess).values({ id: id("amx"), userId: row.id, app: "studio", module: m });
  return row;
}
async function makeCustomer(owner: string, phone: string, name: string) {
  const cid = id("cus");
  await db.insert(customers).values({ id: cid, name, companyName: name, phone, city: "Nagpur", kind: "customer", ownerId: owner, salesAmId: owner } as never);
  return cid;
}
const png = () => sharp({ create: { width: 600, height: 800, channels: 3, background: "#ff8800" } }).png().toBuffer();
const MODS = ["studio.inbox", "studio.forward", "studio.make", "studio.posters", "studio.home", "studio.bulk"];
const PA = "919820011111";
const PB = "919820022222";
const key = () => `key-${randomUUID().slice(0, 12)}`;
const convOf = async (phone: string) => (await db.execute(sql`select id from studio_wa_conversations where phone_key = ${phone.slice(-10)}`) as unknown as { id: string }[])[0]!.id;

let manager: typeof users.$inferSelect;
let priya: typeof users.$inferSelect;
let rakesh: typeof users.$inferSelect;
let cA: string;
let cB: string;

const upload = async (title = "Diwali") => {
  const form = new FormData();
  form.set("title", title);
  form.set("file", new File([new Uint8Array(await png())], "p.png", { type: "image/png" }));
  return ((await (await uploadRoute(new Request("http://x/api/studio/forwards/upload", { method: "POST", body: form }))).json()) as { data: { id: string } }).data.id;
};

before(() => assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against a mahekone_test database."));

beforeEach(async () => {
  await db.execute(sql`
    truncate table studio_activities, studio_wa_messages, studio_wa_conversations, studio_wa_events, studio_forward_recipients, studio_forwards, studio_poster_shares, studio_posters, studio_batches,
      wa_messages, customer_contacts, customers, attachment_bytes, audit_log, notifications, whatsapp_service_events, app_module_access, app_access, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  resetConnectionCache();
  calls = [];
  installFake();
  manager = await makeUser("Meena Manager", "manager", MODS);
  priya = await makeUser("Priya Sharma", "associate", MODS, { reportsToId: manager.id });
  rakesh = await makeUser("Rakesh Iyer", "associate", MODS, { reportsToId: manager.id });
  cA = await makeCustomer(priya.id, "9820011111", "Alpha Paints");
  cB = await makeCustomer(rakesh.id, "9820022222", "Beta Coatings");
  await hear("wamid.A1", PA, "conv-A");
  await hear("wamid.B1", PB, "conv-B");
  await db.insert(whatsappServiceEvents).values({ id: id("wse"), active: true, changedByName: "Founder" });
  setTestUser(priya);
});

after(async () => {
  setKapsoFetch(null);
  setTestUser(null);
  await db.$client.end();
});

const all = async (scopeIds: string[] | null, raw: Record<string, string> = {}) => (await timelineRows(scopeIds, raw)).rows;

describe("a bulk send leaves a row for EVERY recipient", () => {
  test("sent, and not sent with the reason — each with its own recipient and the right sender, grouped by the forward", async () => {
    const cNo = await makeCustomer(priya.id, "9820033333", "Gamma Traders");
    const cOld = await makeCustomer(priya.id, "9820055555", "Old Window Ltd");
    await hear("wamid.O1", "919820055555", "conv-O", 30);
    const fid = await upload("Diwali greeting");
    assert.ok((await startForward({ forwardId: fid, customerIds: [cA, cNo, cOld], caption: "Happy Diwali" })).ok);
    const r = await sendForwardToRecipients(fid);
    assert.ok(r.ok, r.ok ? "" : r.error);
    const rows = await all([priya.id]);
    assert.equal(rows.length, 3, "one row per recipient, not one per campaign");
    const by = Object.fromEntries(rows.map((x) => [x.recipientName, x]));
    for (const x of rows) {
      assert.equal(x.senderName, "Priya Sharma");
      assert.equal(x.contentName, "Diwali greeting");
      assert.equal(x.mode, "bulk");
      assert.equal(x.batchRef, fid);
      assert.equal(x.channel, "kapso");
    }
    assert.equal(by["Alpha Paints"]!.action, "kapso_handed");
    assert.equal(by["Alpha Paints"]!.caption, "Happy Diwali");
    assert.equal(by["Gamma Traders"]!.action, "not_sent");
    assert.match(by["Gamma Traders"]!.reason ?? "", /no open WhatsApp window/);
    assert.equal(by["Old Window Ltd"]!.action, "not_sent");
    assert.match(by["Old Window Ltd"]!.reason ?? "", /24 hours/);
    assert.equal(sends().length, 1, "only the open-window recipient reached Kapso");
  });
});

describe("status accuracy", () => {
  test("a Kapso send shows only what Kapso reported, and only forward; a hand-made mark is never a delivery", async () => {
    const fid = await upload();
    assert.ok((await startForward({ forwardId: fid, customerIds: [cA], caption: "Hi" })).ok);
    assert.ok((await sendForwardToRecipients(fid)).ok);
    const [msg] = await db.select().from(studioWaMessages).where(eq(studioWaMessages.direction, "outbound"));
    const label = async () => (await all([priya.id])).find((x) => x.channel === "kapso")!.status;
    assert.equal((await label()).label, "Sent (Kapso)");
    assert.equal((await label()).confirmedByProvider, true);
    await post("whatsapp.message.delivered", outboundEvent(msg!.wamid, "delivered", PA, "conv-A"), "d1");
    assert.equal((await label()).label, "Delivered (Kapso)");
    await post("whatsapp.message.read", outboundEvent(msg!.wamid, "read", PA, "conv-A"), "r1");
    await post("whatsapp.message.delivered", outboundEvent(msg!.wamid, "delivered", PA, "conv-A"), "d2");
    assert.equal((await label()).label, "Read (Kapso)", "a late delivered does not demote read");

    /* by hand: the same forward, a person ticks it */
    const [rec] = await db.execute<{ id: string }>(sql`select id from studio_forward_recipients where forward_id = ${fid}`);
    assert.ok((await openRecipientChat(rec!.id)).ok);
    assert.ok((await markRecipient(rec!.id, "sent")).ok);
    const manual = (await all([priya.id])).filter((x) => x.channel === "whatsapp_chat");
    assert.deepEqual(manual.map((x) => x.action).sort(), ["chat_opened", "marked_sent"]);
    for (const x of manual) {
      assert.equal(x.status.confirmedByProvider, false);
      assert.doesNotMatch(x.status.label, /deliver|read|kapso/i);
      assert.equal(x.provider, null);
    }
  });

  test("a failed Kapso send shows Failed with Kapso's reason", async () => {
    const fid = await upload();
    setKapsoFetch(async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/whatsapp/phone_numbers")) return json(200, { data: [{ phone_number_id: "PN1", name: "Mahek", display_phone_number: "+91 91374 66424", display_phone_number_normalized: COMPANY, status: "CONNECTED", is_coexistence: true, meta_app_id: "app1" }], meta: { page: 1, total_pages: 1 } });
      if (url.endsWith("/media")) return json(200, { id: "MEDIA1" });
      return json(422, { error: { message: "Template required", code: 131047 } });
    });
    const r = await sendForward({ conversationId: await convOf(PA), forwardId: fid, caption: "x", clientKey: key() });
    assert.equal(r.ok, false);
    const row = (await all([priya.id]))[0]!;
    assert.equal(row.status.label, "Failed (Kapso)");
    assert.match(row.providerError ?? "", /Template required/);
  });

  test("an Inbox message is a 'message' row with its text, to the right person", async () => {
    assert.ok((await sendText({ conversationId: await convOf(PA), body: "On its way", clientKey: key() })).ok);
    const row = (await all([priya.id]))[0]!;
    assert.equal(row.kind, "message");
    assert.equal(row.contentName, "On its way");
    assert.equal(row.recipientName, "Alpha Paints");
    assert.equal(row.mode, "inbox");
  });
});

describe("who may read the Timeline — page read and history API alike", () => {
  const apiRows = async (user: typeof users.$inferSelect, qs = "") => {
    setTestUser(user);
    const res = await timelineRoute(new Request(`http://x/api/studio/timeline${qs}`));
    return { status: res.status, body: (await res.json()) as { rows?: { recipientName: string }[]; total?: number } };
  };

  beforeEach(async () => {
    const f1 = await upload("For Alpha");
    assert.ok((await startForward({ forwardId: f1, customerIds: [cA], caption: "a" })).ok);
    assert.ok((await sendForwardToRecipients(f1)).ok);
    setTestUser(rakesh);
    const f2 = await upload("For Beta");
    assert.ok((await startForward({ forwardId: f2, customerIds: [cB], caption: "b" })).ok);
    assert.ok((await sendForwardToRecipients(f2)).ok);
    setTestUser(priya);
  });

  test("each employee reads the rows about their own customers; the manager reads the team's; the whole-book reader reads everything; nobody's reach reads nothing", async () => {
    assert.deepEqual((await all([priya.id])).map((x) => x.recipientName), ["Alpha Paints"]);
    assert.deepEqual((await all([rakesh.id])).map((x) => x.recipientName), ["Beta Coatings"]);
    assert.deepEqual((await all([manager.id, priya.id, rakesh.id])).map((x) => x.recipientName).sort(), ["Alpha Paints", "Beta Coatings"]);
    assert.equal((await all(null)).length, 2);
    assert.equal((await all([])).length, 0);
  });

  test("the API gives the same answers, and refuses somebody without the Make a poster module", async () => {
    assert.deepEqual((await apiRows(priya)).body.rows!.map((x) => x.recipientName), ["Alpha Paints"]);
    assert.deepEqual((await apiRows(rakesh)).body.rows!.map((x) => x.recipientName), ["Beta Coatings"]);
    const nobody = await makeUser("No Make", "associate", ["studio.home"]);
    assert.equal((await apiRows(nobody)).status, 404);
    setTestUser(priya);
  });

  test("a customer reassigned to somebody else takes their rows with them", async () => {
    await db.update(customers).set({ salesAmId: rakesh.id, ownerId: rakesh.id, amDecidedAt: new Date() }).where(eq(customers.id, cA));
    assert.deepEqual((await all([priya.id])).map((x) => x.recipientName), []);
    assert.deepEqual((await all([rakesh.id])).map((x) => x.recipientName).sort(), ["Alpha Paints", "Beta Coatings"]);
  });

  test("filters are applied inside the scope: another employee's rows cannot be reached by searching for them", async () => {
    assert.deepEqual((await all([priya.id], { q: "Beta" })).length, 0);
    assert.deepEqual((await all([priya.id], { sender: "Rakesh" })).length, 0);
    assert.equal((await all([manager.id, priya.id, rakesh.id], { sender: "Rakesh" })).length, 1);
    assert.equal((await all([manager.id, priya.id, rakesh.id], { kind: "image" })).length, 2);
    assert.equal((await all([manager.id, priya.id, rakesh.id], { kind: "poster" })).length, 0);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal((await all(null, { from: today, to: today })).length, 2);
    assert.equal((await all(null, { to: "2020-01-01" })).length, 0);
    assert.equal((await all(null, { from: "not-a-date" })).length, 2, "a bad date is dropped, not guessed");
  });
});

describe("history outlives what it names", () => {
  test("a removed forward, a deleted customer and a departed employee leave the rows readable, with the names as they were", async () => {
    const fid = await upload("Diwali greeting");
    assert.ok((await startForward({ forwardId: fid, customerIds: [cA], caption: "Hi" })).ok);
    assert.ok((await sendForwardToRecipients(fid)).ok);
    await db.delete(studioForwards).where(eq(studioForwards.id, fid));
    await db.delete(customers).where(eq(customers.id, cA));
    const row = (await all([priya.id]))[0]!;
    assert.equal(row.contentName, "Diwali greeting");
    assert.equal(row.recipientName, "Alpha Paints");
    assert.equal(row.senderName, "Priya Sharma");
    assert.equal(row.customerId, null);
    /* with the record gone the row is its sender's (and their manager's) - not a colleague's */
    assert.equal((await all([rakesh.id])).length, 0);
    assert.equal((await all([manager.id, priya.id, rakesh.id])).length, 1);
    await db.update(users).set({ name: "Renamed Later" }).where(eq(users.id, priya.id));
    assert.equal((await all([priya.id]))[0]!.senderName, "Priya Sharma", "the sender's name is as it was when it happened");
    assert.equal((await db.select().from(studioActivities)).length, 1);
  });
});

describe("the bulk poster run", () => {
  let cC: string;
  beforeEach(async () => {
    cC = await makeCustomer(priya.id, "9820066666", "Delta Stores");
  });
  const run = async () => {
    const r = await makeBatch({ list: "customer", templateId: "diwali-classic", language: "en", showProduct: true, customerIds: [cA, cC] });
    assert.ok(r.ok, r.ok ? "" : r.error);
    return r.ok ? r.data.id : "";
  };
  const zip = async (user: typeof users.$inferSelect, batchId: string) => {
    setTestUser(user);
    return zipRoute(new Request(`http://x/api/studio/batches/${batchId}/zip`), { params: Promise.resolve({ id: batchId }) });
  };
  const noSendWords = /deliver|read|kapso|sent/i;

  test("generating a run is ONE entry for the run - who, when, which design, how many - and invents no recipient", async () => {
    const batchId = await run();
    const rows = await all([priya.id]);
    assert.equal(rows.length, 1, "one row for the run, none per recipient");
    const r = rows[0]!;
    assert.equal(r.action, "batch_generated");
    assert.equal(r.senderName, "Priya Sharma");
    assert.equal(r.mode, "bulk");
    assert.equal(r.channel, "studio");
    assert.equal(r.kind, "poster");
    assert.equal(r.batchRef, batchId);
    assert.equal(r.customerId, null);
    assert.equal(r.recipientName, "Bulk run - 2 posters");
    assert.match(r.contentName, /bulk run/);
    assert.equal(r.status.label, "Generated as a bulk run (nothing sent)");
    assert.equal(r.status.confirmedByProvider, false);
    assert.equal(r.provider, null);
    assert.ok(Math.abs(r.at.getTime() - Date.now()) < 60_000, "stamped when it happened");
    assert.ok(!rows.some((x) => /Alpha Paints|Delta Stores/.test(x.recipientName)), "no fake recipient entries");
    /* it is the generator's: a colleague outside the reach does not see it, the manager above does */
    assert.equal((await all([rakesh.id])).length, 0);
    assert.equal((await all([manager.id, priya.id, rakesh.id])).length, 1);
  });

  test("a ZIP with recipient mapping leaves one DOWNLOAD row per poster-recipient pair - never a send", async () => {
    const batchId = await run();
    const res = await zip(priya, batchId);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/zip");
    const rows = (await all([priya.id])).filter((x) => x.action === "zip_downloaded");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((x) => x.recipientName).sort(), ["Alpha Paints", "Delta Stores"]);
    for (const x of rows) {
      assert.equal(x.senderName, "Priya Sharma");
      assert.equal(x.kind, "poster");
      assert.equal(x.channel, "download");
      assert.equal(x.mode, "bulk");
      assert.equal(x.batchRef, batchId);
      assert.ok(x.customerId, "linked to the lead or customer while it exists");
      assert.equal(x.status.label, "Downloaded in a ZIP (not sent)");
      assert.equal(x.status.confirmedByProvider, false);
      assert.equal(x.provider, null);
      assert.doesNotMatch(x.status.label.replace("not sent", ""), noSendWords, "a download never reads as sent, delivered or read");
    }
    assert.equal((await all([priya.id])).filter((x) => x.action === "zip_downloaded_batch").length, 0, "mapped, so no batch-level row");
    /* each download is its own history: a second one adds its own rows */
    assert.equal((await zip(priya, batchId)).status, 200);
    assert.equal((await all([priya.id])).filter((x) => x.action === "zip_downloaded").length, 4);
    /* and the CRM's access still rules: Rakesh sees none of them, and cannot download Priya's run */
    assert.equal((await all([rakesh.id])).filter((x) => x.action === "zip_downloaded").length, 0);
    const before = (await db.select().from(studioActivities)).length;
    assert.equal((await zip(rakesh, batchId)).status, 404);
    assert.equal((await db.select().from(studioActivities)).length, before, "a refused download writes nothing");
  });

  test("a ZIP with NO recipient mapping is one batch-level entry for the whole run", async () => {
    const batchId = await run();
    setTestUser(priya);
    await recordBatchZipDownload(priya.id, { id: batchId, templateName: "Diwali classic" }, [
      { id: "pst_a", customerId: null, recipient: { company: "", contact: null, city: "", state: "", product: null }, templateName: "Diwali classic" },
      { id: "pst_b", customerId: null, recipient: { company: "  ", contact: null, city: "", state: "", product: null }, templateName: "Diwali classic" },
    ] as never);
    const rows = (await all([priya.id])).filter((x) => x.action === "zip_downloaded" || x.action === "zip_downloaded_batch");
    assert.equal(rows.length, 1, "no recipient could be mapped: one row, not one per poster");
    const r = rows[0]!;
    assert.equal(r.action, "zip_downloaded_batch");
    assert.equal(r.senderName, "Priya Sharma");
    assert.equal(r.customerId, null);
    assert.equal(r.recipientName, "Whole bulk run - 2 posters");
    assert.equal(r.channel, "download");
    assert.equal(r.batchRef, batchId);
    assert.match(r.reason ?? "", /carry no recipient/);
    assert.equal(r.status.label, "ZIP of the whole run downloaded (not sent)");
    assert.equal(r.status.confirmedByProvider, false);
    assert.equal((await all([rakesh.id])).filter((x) => x.action === "zip_downloaded_batch").length, 0);
  });

  test("a ZIP with some posters mapped and some not: a row for each mapped pair plus ONE batch-level row for the rest", async () => {
    const batchId = await run();
    setTestUser(priya);
    await recordBatchZipDownload(priya.id, { id: batchId, templateName: "Diwali classic" }, [
      { id: "pst_a", customerId: cA, recipient: { company: "Alpha Paints", contact: null, city: "", state: "", product: null }, templateName: "Diwali classic" },
      { id: "pst_b", customerId: null, recipient: { company: "", contact: null, city: "", state: "", product: null }, templateName: "Diwali classic" },
    ] as never);
    const rows = await all([priya.id]);
    assert.equal(rows.filter((x) => x.action === "zip_downloaded").length, 1);
    assert.equal(rows.filter((x) => x.action === "zip_downloaded_batch").length, 1);
    assert.match(rows.find((x) => x.action === "zip_downloaded_batch")!.reason ?? "", /1 poster in this ZIP carry no recipient/);
  });

  test("the run and its downloads outlive the run: delete it and the history still reads", async () => {
    const batchId = await run();
    assert.equal((await zip(priya, batchId)).status, 200);
    await db.execute(sql`delete from studio_batches where id = ${batchId}`);
    const rows = await all([priya.id]);
    assert.equal(rows.filter((x) => x.action === "batch_generated").length, 1);
    assert.equal(rows.filter((x) => x.action === "zip_downloaded").length, 2);
    assert.ok(rows.every((x) => x.senderName === "Priya Sharma"));
  });
});
