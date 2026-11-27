/**
 * A visit to a lead reaches every manager screen a customer visit reaches.
 * One customer visit beside it as the control: any read that shows the
 * customer visit and not the lead one is the bug.
 *
 * Each visit names its shop in `dependsOn`, as 1.31.0 does. The customer is an
 * office shop (`cus_…`), which is what the server refused on 27 Nov 2026 as
 * "not a kind of record MahekOne holds" — six of one salesman's visits lost
 * in a morning, only their follow-up tasks reaching the dashboard.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, mbosDevices, mbosUserTerritories, mbosVisits, timelineEvents, users } from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";
import { testPhone } from "@/lib/test-phone";
import { setTestUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import {
  activityHistory,
  activityHistoryCounts,
  activityPointsForDay,
  leadsList,
  performance,
  salesmanRecord,
  teamDay,
  tracksForDay,
  visitsList,
} from "@/lib/services/sales-service";
import { teamJourneySummary } from "@/lib/services/journey-service";
import { teamVisits } from "@/lib/services/visit-oversight-service";
import { leadPanelCounts, leadTimelinePage, leadVisitsFor } from "@/lib/services/lead-record-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const SHOP = { lat: 21.1601, lng: 79.0805 };

let salesman: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;
let principal: MbosPrincipal;
let customerId: string;
let leadId: string;
let custVisit: string;
let leadVisit: string;
let day: string;

async function makeUser(name: string, role: "associate" | "manager", reportsToId?: string) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
      reportsToId: reportsToId ?? null,
    })
    .returning();
  return row!;
}

const item = (over: Partial<SyncItem> & Pick<SyncItem, "entityType" | "payload">): SyncItem => {
  const entityId = over.entityId ?? id("mbos");
  return {
    queueId: id("q"),
    entityId,
    op: "create",
    idempotencyKey: `${entityId}:create`,
    clientCreatedAt: Date.now(),
    location: { ...SHOP, accuracyM: 10, capturedAt: Date.now() - 60_000, ageSeconds: 60, source: "trail" },
    ...over,
  };
};

const visitPayload = (shop: string) => ({
  customerId: shop,
  checkInAt: Date.now() - 20 * 60_000,
  checkOutAt: Date.now() - 5 * 60_000,
  checkInLat: SHOP.lat,
  checkInLng: SHOP.lng,
  checkInAccuracyM: 10,
  outcome: "visited",
  notes: "Met the owner.",
  ...(shop.startsWith("mbos_lead_") ? { suspectDecision: "still_suspect" } : {}),
});

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/);
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table orders, bills, lead_stage_transitions, mbos_visits, mbos_devices,
      mbos_journey_stops, mbos_journey_plans, mbos_sync_receipts, mbos_user_territories,
      timeline_events, audit_log, notifications, app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  day = await today();

  manager = await makeUser("Vikram", "manager");
  salesman = await makeUser("Mahesh", "associate", manager.id);
  await db.insert(appAccess).values([
    { id: id("aa"), userId: salesman.id, app: "field" },
    { id: id("aa"), userId: manager.id, app: "sales", role: "manager" },
    { id: id("aa"), userId: manager.id, app: "crm", role: "manager" },
  ]);
  await db.insert(mbosUserTerritories).values({ id: id("ut"), userId: salesman.id, kind: "state", region: "Maharashtra" });
  await db.insert(mbosDevices).values({ id: id("dev"), userId: salesman.id, deviceId: "probe-device", active: true });
  principal = { user: salesman, deviceId: "probe-device", role: "associate", scope: { kind: "own", userIds: [salesman.id] } } as MbosPrincipal;

  customerId = id("cus");
  await db.insert(customers).values({
    id: customerId, name: "Sai Paint Depot", phone: testPhone(), city: "Nagpur",
    territoryRegion: "Maharashtra", kind: "customer", ownerId: salesman.id, gpsLat: SHOP.lat, gpsLng: SHOP.lng,
  });

  /* The phone's own order: the lead, then a visit on it, then a customer visit. */
  leadId = `mbos_lead_${randomUUID()}`;
  leadVisit = id("visit");
  custVisit = id("visit");
  const results = await ingestSyncBatch(principal, [
    item({
      entityType: "lead",
      entityId: leadId,
      payload: { name: "Shree Ganesh Paints", mobile: testPhone(), salesType: "direct", stage: "suspect", city: "Nagpur", state: "Maharashtra", gpsLat: SHOP.lat, gpsLng: SHOP.lng },
    }),
    item({ entityType: "visit", entityId: leadVisit, payload: visitPayload(leadId), dependsOn: [leadId] }),
    item({ entityType: "visit", entityId: custVisit, payload: visitPayload(customerId), dependsOn: [customerId] }),
  ]);
  for (const r of results) assert.equal(r.status, "accepted", JSON.stringify(r));
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

const has = (x: unknown, needle: string) => JSON.stringify(x).includes(needle);

test("the lead visit is stored like a customer visit", async () => {
  const rows = await db.select().from(mbosVisits);
  assert.deepEqual(rows.map((r) => r.customerId).sort(), [customerId, leadId].sort());
  const t = await db.select().from(timelineEvents).where(eq(timelineEvents.customerId, leadId));
  assert.ok(t.some((e) => e.sourceRecordId === leadVisit), "lead timeline has the visit");
  const [lead] = await db.select().from(customers).where(eq(customers.id, leadId));
  assert.equal(lead!.lastVisitDate, day);
});

test("Team today counts both", async () => {
  const t = await teamDay(day);
  const me = t.people.find((p) => p.id === salesman.id) as unknown as { visits: number } | undefined;
  assert.ok(me, "salesman on the team day: " + JSON.stringify(t.people.map((p) => p.id)));
  assert.equal(me!.visits, 2);
  assert.equal(t.totals.visits, 2);
});

test("Visit log lists both", async () => {
  const v = await visitsList(day);
  assert.ok(has(v, custVisit), "customer visit (control)");
  assert.ok(has(v, leadVisit), "lead visit");
});

test("Activity history lists and counts both", async () => {
  const h = await activityHistory({ from: day, to: day });
  assert.ok(has(h, custVisit), "customer visit (control)");
  assert.ok(has(h, leadVisit), "lead visit");
  const c = await activityHistoryCounts({ from: day, to: day });
  assert.ok(has(c, '"mbos":2') || has(c, ":2"), JSON.stringify(c));
});

test("Performance counts both", async () => {
  const p = await performance(day, day);
  const me = p.find((r) => r.salesmanId === salesman.id) as unknown as { visits: number; verifiedVisits: number };
  assert.equal(me.visits, 2);
  assert.equal(me.verifiedVisits, 2);
});

test("Journeys summary counts both", async () => {
  const s = await teamJourneySummary(day, day);
  const me = s.visits.find((r) => (r as { userId: string }).userId === salesman.id) as unknown as { visits: number };
  assert.equal(me.visits, 2);
});

test("Check visits (the manager's oversight list) shows both", async () => {
  const r = await teamVisits({ id: manager.id, name: manager.name, role: manager.role }, { now: new Date() });
  assert.ok(r && "visits" in r, JSON.stringify(r));
  assert.ok(has(r, custVisit), "customer visit (control)");
  assert.ok(has(r, leadVisit), "lead visit");
});

test("Salesman record lists both", async () => {
  const r = await salesmanRecord(salesman.id);
  assert.ok(has(r, custVisit) || has(r, "Sai Paint Depot"), "customer visit (control)");
  assert.ok(has(r, "Shree Ganesh Paints"), "lead visit");
});

test("Live map trail and activity points carry the lead visit", async () => {
  const tracks = await tracksForDay(day);
  assert.ok(has([...tracks.values()], "Shree Ganesh Paints"), "trail point at the lead");
  const pts = await activityPointsForDay(day);
  assert.ok(has(pts, "Sai Paint Depot"), "control: " + JSON.stringify(pts).slice(0, 300));
  assert.ok(has(pts, "Shree Ganesh Paints"), "activity point: " + JSON.stringify(pts).slice(0, 400));
});

test("Leads list and the lead record show the visit", async () => {
  const l = await leadsList(day);
  const row = l.find((r) => r.id === leadId) as unknown as { visitCount: number } | undefined;
  assert.ok(row, "lead on the manager's Leads list");
  assert.equal(row!.visitCount, 1);
  assert.ok(has(await leadVisitsFor(leadId), leadVisit), "lead record visits");
  assert.ok(has(await leadPanelCounts(leadId), "1"), "panel counts");
  assert.ok(has(await leadTimelinePage(leadId, {}), leadVisit), "lead timeline");
});

test("a visit to a lead the office made (a cus_ id) is accepted and counted", async () => {
  const officeLead = id("cus");
  await db.insert(customers).values({
    id: officeLead, name: "Heramb Hardware", phone: testPhone(), city: "Nagpur", territoryRegion: "Maharashtra",
    kind: "lead", leadSalesType: "direct", leadStage: "suspect", leadStageSince: day, ownerId: salesman.id,
    gpsLat: SHOP.lat, gpsLng: SHOP.lng,
  });
  const visitId = id("mbos_visit");
  const [r] = await ingestSyncBatch(principal, [
    item({ entityType: "visit", entityId: visitId, payload: { ...visitPayload(officeLead), suspectDecision: "still_suspect" }, dependsOn: [officeLead] }),
  ]);
  assert.equal(r!.status, "accepted", JSON.stringify(r));
  assert.ok(has(await visitsList(day), visitId), "on the Visit log");
  const me = (await teamDay(day)).people.find((p) => p.id === salesman.id) as unknown as { visits: number };
  assert.equal(me.visits, 3);
});

test("a dependency on an office id that does not exist is still refused, not waited for", async () => {
  const [r] = await ingestSyncBatch(principal, [
    item({ entityType: "visit", entityId: id("mbos_visit"), payload: visitPayload("cus_gone"), dependsOn: ["cus_gone"] }),
  ]);
  assert.equal(r!.status, "rejected", JSON.stringify(r));
});
