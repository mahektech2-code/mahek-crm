/**
 * THE VISIT ASSISTANT, against a real database.
 *
 *   npm run test:integration
 *
 * The pure engine has its own suite (`engines/visit-intel.test.ts`). This
 * pins what only a database can show:
 *
 *   - a salesman may ask about a shop in his book and nobody else's, by the
 *     SAME check every record from his handset passes;
 *   - with no language model it says so and writes nothing — not even a draft;
 *   - switched off, it is off, on the pull and at the door;
 *   - saving the visit writes what it was SAVED as onto HIS draft, through
 *     the real sync handler, and onto nobody else's.
 *
 * No key is spent: both provider keys are removed from the environment before
 * anything is imported that could read them, and `app_secrets` is truncated.
 */
delete process.env.OPENAI_API_KEY;
delete process.env.SARVAM_API_KEY;

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appSettings, callAiDrafts, customers, mbosDevices, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { mbosConfigPayload, type MbosPrincipal } from "@/lib/services/mbos-service";
import { analyseVisit } from "@/lib/services/visit-intel-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let salesman: typeof users.$inferSelect;
let colleague: typeof users.$inferSelect;
let mine: string;
let theirs: string;
let principal: MbosPrincipal;

async function makeUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "associate",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aa"), userId: row!.id, app: "field" });
  return row!;
}

async function shop(name: string, ownerId: string) {
  const cid = id("cus");
  await db.insert(customers).values({
    id: cid,
    name,
    phone: String(9822200000 + Math.floor(Math.random() * 99999)),
    city: "Nagpur",
    kind: "customer",
    ownerId,
    salesAmId: ownerId,
  } as never);
  return cid;
}

async function draft(over: Partial<typeof callAiDrafts.$inferInsert> = {}) {
  const did = id("vad");
  await db.insert(callAiDrafts).values({
    id: did,
    channel: "visit",
    customerId: mine,
    userId: salesman.id,
    analysis: {},
    suggestedOutcome: "order",
    ...over,
  });
  return did;
}

function visit(payload: Record<string, unknown>): SyncItem {
  const entityId = id("vis");
  return {
    queueId: id("q"),
    entityType: "visit",
    entityId,
    op: "create",
    idempotencyKey: `${entityId}:create:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    payload: {
      customerId: mine,
      checkInAt: Date.now() - 10 * 60_000,
      checkOutAt: Date.now(),
      outcome: "payment",
      notes: "20 hazar cash liya",
      nextFollowUpDate: "2026-10-05",
      ...payload,
    },
  };
}

const input = (customerId: string) => ({
  customerId,
  spoken: "",
  english: "",
  typedNote: "Order diya, 10 nano de do. Monday ko 20 hazar dega.",
  language: null,
  heardBy: "typed",
});

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table
      call_ai_drafts, mbos_visits, mbos_devices, timeline_events,
      notifications, audit_log, app_secrets, app_access, sessions,
      customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  salesman = await makeUser("Mahesh");
  colleague = await makeUser("Ramesh");
  mine = await shop("Sai Paint Depot", salesman.id);
  theirs = await shop("Ramesh's Hardware", colleague.id);
  await db
    .insert(mbosDevices)
    .values({ id: id("dev"), userId: salesman.id, deviceId: "probe-device", active: true });
  principal = {
    user: salesman,
    deviceId: "probe-device",
    role: "associate",
    scope: { kind: "own", userIds: [salesman.id] },
  } as MbosPrincipal;
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("with no model it says so plainly and writes nothing, not even a draft", async () => {
  const out = await analyseVisit(principal, input(mine));
  assert.equal(out.ok, false);
  assert.match(out.ok ? "" : out.error, /could not read this visit/);
  assert.equal((await db.select().from(callAiDrafts)).length, 0);
});

test("another salesman's shop is refused by the same check a visit passes", async () => {
  const out = await analyseVisit(principal, input(theirs));
  assert.equal(out.ok, false);
  assert.doesNotMatch(out.ok ? "" : out.error, /could not read/, "refused before any model is asked");
  assert.equal((await db.select().from(callAiDrafts)).length, 0);
});

test("switched off is off — at the door and on the pull", async () => {
  /* Written straight to the row: `seedConfig` has put it there, and what is
     under test is the reading of it, not the settings screen. */
  await db
    .update(appSettings)
    .set({ value: false })
    .where(eq(appSettings.key, "visitIntel.enabled"));
  invalidateConfig();
  const out = await analyseVisit(principal, input(mine));
  assert.equal(out.ok, false);
  assert.match(out.ok ? "" : out.error, /switched off/);
  const cfg = await mbosConfigPayload();
  assert.deepEqual(cfg["mbos.ai.visitAssistant"], { available: false });
});

test("with no key the handset is told not to draw the card", async () => {
  const cfg = await mbosConfigPayload();
  assert.deepEqual(cfg["mbos.ai.visitAssistant"], { available: false });
});

test("the saved visit is written onto HIS draft, and onto nobody else's", async () => {
  const his = await draft();
  const colleagues = await draft({ userId: colleague.id, customerId: theirs });
  const aCall = await draft({ channel: "call" });

  const mineVisit = visit({ aiDraftId: his });
  const [r1] = await ingestSyncBatch(principal, [mineVisit]);
  assert.equal(r1!.status, "accepted", JSON.stringify(r1));

  const [row] = await db.select().from(callAiDrafts).where(eq(callAiDrafts.id, his));
  assert.equal(row!.savedOutcome, "payment");
  assert.equal(row!.visitId, mineVisit.entityId);
  assert.ok(row!.savedAt);
  assert.deepEqual(row!.savedDetail, { nextFollowUpDate: "2026-10-05", suspectDecision: null });

  /* A payload naming a draft that is not his, or not a visit's, lands the
     visit and marks nothing. */
  for (const other of [colleagues, aCall]) {
    const [r] = await ingestSyncBatch(principal, [visit({ aiDraftId: other })]);
    assert.equal(r!.status, "accepted");
    const [d] = await db.select().from(callAiDrafts).where(eq(callAiDrafts.id, other));
    assert.equal(d!.savedOutcome, null);
    assert.equal(d!.visitId, null);
  }
});

test("a visit with no draft saves exactly as it always did", async () => {
  const [r] = await ingestSyncBatch(principal, [visit({})]);
  assert.equal(r!.status, "accepted", JSON.stringify(r));
});
