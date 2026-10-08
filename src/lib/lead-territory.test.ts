/**
 * A LEAD IS RAISED INSIDE THE SALESMAN'S OWN AREA, and lands there.
 *
 * Two halves, and the second is the one that was broken in production. Mahek's
 * rule refuses a lead outside the area; and a lead inside it has to be filed
 * under a state, because every allocated city carries its state as a parent
 * and the territory clause ANDs the two. Handset leads arrived with no state at
 * all, so none of them — in the area or not — ever reached a Customers book,
 * their author's included. These go through `ingestSyncBatch`, the door the
 * phone actually uses, and then ask `customerIdsInScope` whether the lead is
 * where the salesman will look for it.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, mbosUserTerritories, users } from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { customerIdsInScope, type MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function person(role: "associate" | "admin", territories: { kind: string; region: string; parent?: string }[]) {
  const [user] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name: `Field ${role}`,
      email: `${id("f")}@test.local`,
      passwordHash: "x",
      role,
      initials: "FT",
    })
    .returning();
  await db.insert(appAccess).values({ id: id("acc"), userId: user.id, app: "field", role });
  for (const t of territories) {
    await db.insert(mbosUserTerritories).values({
      id: id("ut"),
      userId: user.id,
      kind: t.kind as "state",
      region: t.region,
      parent: t.parent ?? "",
    });
  }
  return {
    user,
    deviceId: "probe-device",
    role,
    scope: role === "admin" ? { kind: "all" } : { kind: "own", userIds: [user.id] },
  } as MbosPrincipal;
}

function lead(payload: Record<string, unknown>): SyncItem {
  const entityId = `mbos_lead_${randomUUID()}`;
  return {
    queueId: id("q"),
    entityType: "lead",
    entityId,
    op: "create",
    idempotencyKey: `${entityId}:create`,
    clientCreatedAt: Date.now(),
    payload: {
      name: "Test Shop",
      mobile: String(9800000000 + Math.floor(Math.random() * 99_999_999)),
      salesType: "direct",
      stage: "suspect",
      ...payload,
    },
  };
}

const stored = async (leadId: string) =>
  (await db.select().from(customers).where(eq(customers.id, leadId)))[0];

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table mbos_sync_receipts, mbos_user_territories, timeline_events,
      audit_log, notifications, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  /* The book's own reading of where Nagpur is — what an old build that sends
     no state is filed by. */
  await db.insert(customers).values({
    id: id("cus"),
    name: "Sai Paint Depot",
    phone: "9822200011",
    city: "Nagpur",
    territoryRegion: "Maharashtra",
    kind: "customer",
  });
});

after(async () => {
  await db.$client.end();
});

describe("A lead may only be raised inside the salesman's own area", () => {
  test("inside a state he holds, it is accepted, filed under it, and on his book", async () => {
    const rahul = await person("associate", [{ kind: "state", region: "Madhya Pradesh" }]);
    const item = lead({ city: "Rewa" });
    const [result] = await ingestSyncBatch(rahul, [item]);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    assert.equal((await stored(item.entityId)).territoryRegion, "Madhya Pradesh");
    assert.ok((await customerIdsInScope(rahul)).includes(item.entityId));
  });

  test("outside it, it is refused, the refusal names his area, and nothing is written", async () => {
    const rahul = await person("associate", [{ kind: "state", region: "Madhya Pradesh" }]);
    const item = lead({ city: "Nagpur" });
    const [result] = await ingestSyncBatch(rahul, [item]);
    assert.equal(result.status, "rejected", JSON.stringify(result));
    assert.match(JSON.stringify(result), /Nagpur is outside your area \(Madhya Pradesh\)/);
    assert.equal(await stored(item.entityId), undefined);
  });

  test("with no area at all, a salesman cannot raise one", async () => {
    const bharat = await person("associate", []);
    const [result] = await ingestSyncBatch(bharat, [lead({ city: "Pune" })]);
    assert.equal(result.status, "rejected", JSON.stringify(result));
    assert.match(JSON.stringify(result), /no area has been allocated/);
  });

  test("THE PRODUCTION CASE: Nagpur, no state on the wire, a region row for Maharashtra", async () => {
    /* Pritesh's handset, 1 October: the lead was accepted with no state and
       matched none of his territories, so it was on no screen he could open. */
    const pritesh = await person("admin", [
      { kind: "city", region: "Thane", parent: "Maharashtra" },
      { kind: "region", region: "Maharashtra" },
    ]);
    const item = lead({ city: "Nagpur" });
    const [result] = await ingestSyncBatch(pritesh, [item]);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    assert.equal((await stored(item.entityId)).territoryRegion, "Maharashtra");
    assert.ok((await customerIdsInScope(pritesh)).includes(item.entityId));
  });

  test("a city picked on the phone carries its state, and lands", async () => {
    const pritesh = await person("admin", [{ kind: "city", region: "Thane", parent: "Maharashtra" }]);
    const item = lead({ city: "Thane", state: "Maharashtra" });
    const [result] = await ingestSyncBatch(pritesh, [item]);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    assert.ok((await customerIdsInScope(pritesh)).includes(item.entityId));
  });

  test("a manager or admin whom nothing narrows is not refused", async () => {
    const boss = await person("admin", []);
    const [result] = await ingestSyncBatch(boss, [lead({ city: "Kolkata" })]);
    assert.equal(result.status, "accepted", JSON.stringify(result));
  });
});
