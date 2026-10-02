/**
 * A SALESMAN'S ANSWER TO WHERE HE WORKS, end to end.
 *
 *   npm run test:integration
 *
 * Sent as real payloads through `ingestSyncBatch`, decided through the real
 * `decideApproval`, and read back through the real bootstrap, delta and Team
 * screen — because every link in that chain is a place the answer can be
 * silently lost, and only the whole chain shows it arrives.
 *
 * Needs mahekone_test; `npm run test:db` creates it.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, mbosDevices, mbosUserTerritories, users } from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setTestUser } from "@/lib/auth";
import { decideApproval } from "@/lib/actions/sales";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { buildBootstrap, buildPull, type MbosPrincipal } from "@/lib/services/mbos-service";
import { fieldTeam, pendingApprovals } from "@/lib/services/sales-service";
import { areasSignature } from "@/lib/territory-signature";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let salesman: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;
let principal: MbosPrincipal;

const AREAS = [{ kind: "city", value: "Nagpur", parent: "Maharashtra" }];

function item(over: Partial<SyncItem> & Pick<SyncItem, "entityType">): SyncItem {
  const entityId = over.entityId ?? id("mbos_territory");
  return {
    queueId: id("q"),
    entityId,
    op: "create",
    idempotencyKey: `${entityId}:create:${randomUUID()}`,
    clientCreatedAt: Date.now(),
    payload: {},
    location: null,
    ...over,
  } as SyncItem;
}

async function makeUser(name: string, role: "associate" | "admin", app: "field" | "sales") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("acc"), userId: row.id, app, role });
  return row;
}

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
      mbos_territory_requests, mbos_approvals, mbos_devices, mbos_user_territories,
      notifications, audit_log, app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  salesman = await makeUser("Mahesh", "associate", "field");
  manager = await makeUser("Vikram", "admin", "sales");
  await db.insert(mbosUserTerritories).values({
    id: id("ut"),
    userId: salesman.id,
    kind: "city",
    region: "Nagpur",
    parent: "Maharashtra",
  });
  await db
    .insert(mbosDevices)
    .values({ id: id("dev"), userId: salesman.id, deviceId: "probe-device", active: true });
  principal = {
    user: salesman,
    deviceId: "probe-device",
    role: "associate",
    scope: { kind: "own", userIds: [salesman.id] },
  } as MbosPrincipal;
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("an acceptance lands, comes back down, and the Team screen sees it as current", async () => {
  const [result] = await ingestSyncBatch(principal, [
    item({
      entityType: "territory_request",
      payload: {
        kind: "accept",
        currentPlaces: ["Nagpur, Maharashtra"],
        requestedPlaces: [],
        signature: areasSignature(AREAS),
        state: "accepted",
      },
    }),
  ]);
  assert.equal(result.status, "accepted", JSON.stringify(result));

  const boot = await buildBootstrap(principal);
  const rows = boot.territoryRequests as Array<{ kind: string; state: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "accepted");

  const team = await fieldTeam();
  const me = team.find((t) => t.id === salesman.id);
  assert.ok(me?.areaAnswer, "the Team screen does not see the answer");
  assert.equal(me.areaAnswer.kind, "accept");
  assert.equal(
    me.areaAnswer.signature,
    areasSignature(me.territories),
    "the office and the handset disagree about which allocation was accepted",
  );
});

test("a change with no cities is refused, and one with cities goes to Approvals and back", async () => {
  const [refused] = await ingestSyncBatch(principal, [
    item({
      entityType: "territory_request",
      payload: { kind: "change", requestedPlaces: [], reason: "closer to home", signature: "" },
    }),
  ]);
  assert.equal(refused.status, "rejected", JSON.stringify(refused));

  const requestId = id("mbos_territory");
  const approvalId = id("mbos_approval");
  const results = await ingestSyncBatch(principal, [
    item({
      entityType: "territory_request",
      entityId: requestId,
      payload: {
        kind: "change",
        currentPlaces: ["Nagpur, Maharashtra"],
        requestedPlaces: ["Wardha", "Amravati"],
        reason: "I live in Wardha and know the dealers",
        signature: areasSignature(AREAS),
        state: "pending",
      },
    }),
    item({
      entityType: "approval",
      entityId: approvalId,
      dependsOn: [requestId],
      payload: {
        type: "territory",
        subjectType: "territory_request",
        subjectId: requestId,
        reason: "I live in Wardha and know the dealers",
      },
    }),
  ]);
  for (const r of results) assert.equal(r.status, "accepted", JSON.stringify(r));

  const queue = await pendingApprovals();
  const mine = queue.find((q) => q.id === approvalId);
  assert.ok(mine, "the request never reached the Approvals queue");
  assert.equal(mine.summary, "Wants to work Wardha, Amravati instead of Nagpur, Maharashtra");

  const boot = await buildBootstrap(principal);
  const decided = await decideApproval({ approvalId, decision: "approved", note: "From Monday" });
  assert.ok(decided.ok, JSON.stringify(decided));

  const delta = await buildPull(principal, boot.cursor);
  const back = (delta.territoryRequests ?? []) as Array<{ id: string; state: string; decisionNote: string }>;
  const answer = back.find((r) => r.id === requestId);
  assert.ok(answer, "deciding the approval did not put the request back on the delta");
  assert.equal(answer.state, "approved");
  assert.equal(answer.decisionNote, "From Monday");
});
