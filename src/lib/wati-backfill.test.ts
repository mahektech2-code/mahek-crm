/**
 * REPLIES FROM BEFORE THE WEBHOOK, read back from a fake Wati: what is
 * imported, what is skipped because the webhook already has it, what arrives
 * handled because somebody answered it in Wati, and that a second run is the
 * same as the first.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, users, waReplies } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { backfillWatiReplies } from "@/lib/services/wati-reply-backfill-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const realFetch = globalThis.fetch;
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/* Two conversations: a customer's, and a number nobody has. */
const HISTORY: Record<string, unknown[]> = {
  "919820011001": [
    // newest first, as Wati sends it
    { id: "w5", eventType: "message", owner: false, type: "text", text: "Any update?", created: ago(2), whatsappMessageId: "wamid.NEW" },
    { id: "w4", eventType: "message", owner: true, type: "text", text: "Checking with accounts", created: ago(20) },
    { id: "w3", eventType: "message", owner: false, type: "button", text: "Already paid", created: ago(21), whatsappMessageId: "wamid.PAID" },
    { id: "w2", eventType: "broadcastMessage", created: ago(30) },
    { id: "w1", eventType: "message", owner: false, type: "text", text: "Webhook already has me", created: ago(1), whatsappMessageId: "wamid.SEEN" },
  ],
  "919811122233": [
    { id: "u1", eventType: "message", owner: false, type: "image", text: null, created: ago(5), whatsappMessageId: "wamid.IMG" },
  ],
};

let founder: typeof users.$inferSelect;
let shopId: string;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against mahekone_test.");
  process.env.WATI_API_TOKEN = "wati_test_token";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://live-mt-server.wati.io/")) return realFetch(input, init);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/api/ext/v3/contacts")) {
      return json({
        contact_list: [
          { wa_id: "919820011001", name: "Colour Camp Owner", last_updated: ago(2) },
          { wa_id: "919811122233", name: "New Shop", last_updated: ago(5) },
        ],
      });
    }
    const m = /getMessages\/(\d+)\?.*pageNumber=(\d+)/.exec(url);
    if (m) return json({ messages: { items: m[2] === "1" ? (HISTORY[m[1]] ?? []) : [] } });
    return new Response("not stubbed", { status: 404 });
  }) as typeof fetch;
});

beforeEach(async () => {
  await db.execute(sql`truncate table wa_replies, audit_log, app_access, sessions, customers, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  [founder] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Founder", email: `f-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role: "manager", initials: "FO" })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: founder.id, app: "founder", role: "manager" });
  shopId = id("cus");
  await db.insert(customers).values({ id: shopId, name: "Colour Camp", contactPerson: "O", phone: "9820011001", city: "Nagpur" });
  // What the webhook already delivered.
  await db.insert(waReplies).values({ id: id("war"), customerId: shopId, message: "Webhook already has me", waId: "919820011001", providerMessageId: "wamid.SEEN", receivedAt: new Date(ago(1)) });
});

after(async () => {
  globalThis.fetch = realFetch;
  setTestUser(null);
  await db.$client.end();
});

test("a preview counts what would come in and writes nothing", async () => {
  setTestUser(founder);
  const r = await backfillWatiReplies({ dryRun: true });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.data.contacts, 2);
  assert.equal(r.data.found, 4, "the customers' messages, not ours, not the broadcast");
  assert.equal(r.data.alreadyHere, 1, "the one the webhook delivered");
  assert.equal(r.data.imported, 3);
  assert.equal(r.data.matched, 2);
  assert.equal(r.data.unmatched, 1);
  assert.equal(r.data.answeredInWati, 1);
  assert.equal((await db.select().from(waReplies)).length, 1, "nothing written");
});

test("the import files each reply as the webhook would, marks Wati-answered ones handled, and a second run adds nothing", async () => {
  setTestUser(founder);
  const r = await backfillWatiReplies({ dryRun: false });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.data.imported, 3);

  const rows = await db.select().from(waReplies);
  const by = (k: string) => rows.find((x) => x.providerMessageId === k)!;
  assert.equal(by("wamid.PAID").customerId, shopId);
  assert.equal(by("wamid.PAID").message, "Already paid");
  assert.equal(by("wamid.PAID").actioned, true, "answered in Wati: arrives handled");
  assert.equal(by("wamid.NEW").actioned, false, "nobody answered: waiting for a reply");
  assert.equal(by("wamid.IMG").customerId, null, "a number on nobody's book");
  assert.equal(by("wamid.IMG").message, "[image]");
  assert.equal(by("wamid.IMG").senderName, "New Shop");
  assert.equal(rows.filter((x) => x.providerMessageId === "wamid.SEEN").length, 1, "never doubled");

  const again = await backfillWatiReplies({ dryRun: false });
  assert.equal(again.ok && again.data.imported, 0);
  assert.equal((await db.select().from(waReplies)).length, 4);
});

test("only the founder's desk can run it", async () => {
  const [other] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Priya", email: `p-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role: "associate", initials: "PR" })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: other.id, app: "crm", role: "associate" });
  setTestUser(other);
  await assert.rejects(() => backfillWatiReplies({ dryRun: true }));
  assert.equal((await db.select().from(waReplies).where(eq(waReplies.customerId, shopId))).length, 1);
});
