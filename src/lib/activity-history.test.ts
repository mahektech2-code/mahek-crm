/**
 * Activity history: MBOS visits are the record, the old app's sheet is its
 * past. Runs the merged list, its counts and its salesman list against a real
 * database, and the two places the cutover is enforced on the sheet's side —
 * the sync, which stops storing a row dated from the cutover on, and the
 * timeline projection, which never projects one already stored.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  customers,
  mbosVisits,
  sheetFieldActivityRows,
  sheetSyncRuns,
  timelineEvents,
  users,
} from "@/db/schema";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setTestUser } from "@/lib/auth";
import {
  activityHistory,
  activityHistoryCounts,
  activityHistorySalesmen,
  visitsBetween,
} from "@/lib/services/sales-service";
import { syncFieldActivitySheet } from "@/lib/services/field-activity-sync-service";
import { projectFieldActivityTimeline } from "@/lib/services/field-activity-projection-service";
import type { SheetTable } from "@/lib/sheets";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
// The registry's default cutover is 2026-10-10.
const RANGE = { from: "2026-09-01", to: "2026-10-31" };

let salesman: typeof users.$inferSelect;
let shop: typeof customers.$inferSelect;
let syncId: string;

async function sheetRow(values: Partial<typeof sheetFieldActivityRows.$inferInsert>) {
  await db.insert(sheetFieldActivityRows).values({
    id: id("fact"),
    syncId,
    rowNumber: 2,
    activityId: id("ACT"),
    raw: {},
    rowHash: id("h"),
    ...values,
  });
}

async function visit(day: string, hhmm: string) {
  const at = new Date(`${day}T${hhmm}:00+05:30`);
  await db.insert(mbosVisits).values({
    id: id("vis"),
    salesmanId: salesman.id,
    customerId: shop.id,
    checkInAt: at,
    checkOutAt: new Date(at.getTime() + 20 * 60_000),
    durationSeconds: 20 * 60,
    outcome: "visited",
    verified: true,
    notes: `Visit on ${day}`,
  } as typeof mbosVisits.$inferInsert);
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
      timeline_events, sheet_field_activity_rows, sheet_sync_runs,
      mbos_visits, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  setTestUser(null);

  [salesman] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Mahesh Patil", email: "mahesh@test.local", phone: "9820011007", passwordHash: "x", role: "associate", initials: "MP" })
    .returning();
  [shop] = await db
    .insert(customers)
    .values({ id: id("cus"), name: "Sai Paint Depot", phone: "9822200011", city: "Nagpur", kind: "customer", ownerId: salesman.id, salesAmId: salesman.id })
    .returning();
  [{ id: syncId }] = await db
    .insert(sheetSyncRuns)
    .values({ id: id("sync"), source: "field_activity", spreadsheetId: "x", tabTitle: "Activity" })
    .returning({ id: sheetSyncRuns.id });

  await visit("2026-10-05", "10:00");
  await visit("2026-10-12", "11:00");
  await sheetRow({
    visitDate: "2026-10-05",
    rowNumber: 10,
    employeeName: "Mahesh Patil",
    matchedSalesmanId: salesman.id,
    salesmanMatchStatus: "matched",
    customerName: "Sai Paint",
    matchedCustomerId: shop.id,
    customerMatchStatus: "matched",
    meetingNote: "Old app, before the cutover",
  });
  await sheetRow({
    visitDate: "2026-10-06",
    rowNumber: 11,
    employeeName: "Prakash Vasudev Prasad",
    customerName: "Somewhere Hardware",
    customerMatchStatus: "unmatched",
  });
  // Stored before the cutover existed; dated after it.
  await sheetRow({
    visitDate: "2026-10-12",
    rowNumber: 12,
    employeeName: "Mahesh Patil",
    matchedSalesmanId: salesman.id,
    customerName: "Sai Paint",
    matchedCustomerId: shop.id,
    customerMatchStatus: "matched",
  });
});

after(async () => {
  await db.$client.end();
});

describe("the merged list", () => {
  test("every MBOS visit, and the old app's rows only before the cutover, newest first", async () => {
    const r = await activityHistory(RANGE);
    assert.equal(r.cutover, "2026-10-10");
    assert.equal(r.total, 4);
    assert.deepEqual(
      r.rows.map((x) => (x.source === "mbos" ? `mbos ${x.visit.day}` : `sheet ${x.sheet.visitDate}`)),
      ["mbos 2026-10-12", "sheet 2026-10-06", "mbos 2026-10-05", "sheet 2026-10-05"],
    );
    const mbos = r.rows.find((x) => x.source === "mbos");
    assert.ok(mbos && mbos.source === "mbos");
    assert.equal(mbos.visit.customerName, "Sai Paint Depot");
    assert.equal(mbos.visit.notes, "Visit on 2026-10-12");
  });

  test("the Visit log reads the same visit select", async () => {
    const visits = await visitsBetween({ from: "2026-10-12", to: "2026-10-12" });
    assert.deepEqual(visits.map((v) => v.notes), ["Visit on 2026-10-12"]);
  });

  test("the source, match and salesman filters", async () => {
    assert.equal((await activityHistory({ ...RANGE, source: "mbos" })).total, 2);
    assert.equal((await activityHistory({ ...RANGE, source: "sheet" })).total, 2);
    assert.equal((await activityHistory({ ...RANGE, match: "unmatched" })).total, 1);
    // An account: his MBOS visits and the old rows matched to him.
    assert.equal((await activityHistory({ ...RANGE, salesman: `u:${salesman.id}` })).total, 3);
    // A name only the sheet carries.
    assert.equal((await activityHistory({ ...RANGE, salesman: "n:Prakash Vasudev Prasad" })).total, 1);
  });

  test("the counts agree with the list", async () => {
    assert.deepEqual(await activityHistoryCounts(RANGE), {
      all: 4,
      mbos: 2,
      sheet: 2,
      matched: 1,
      ambiguous: 0,
      unmatched: 1,
    });
  });

  test("the salesman filter offers accounts and old-app-only names", async () => {
    const people = await activityHistorySalesmen();
    assert.deepEqual(people.accounts.map((a) => a.name), ["Mahesh Patil"]);
    assert.deepEqual(people.sheetNames.map((n) => n.name), ["Prakash Vasudev Prasad"]);
  });

  test("an empty range says so without inventing rows", async () => {
    const r = await activityHistory({ from: "2025-01-01", to: "2025-01-31" });
    assert.equal(r.total, 0);
    assert.equal(r.rows.length, 0);
    assert.equal(r.everAnything, true);
  });
});

describe("the sheet stops at the cutover", () => {
  test("the sync stores a row before the cutover and leaves one after it out", async () => {
    await db.execute(sql`truncate table sheet_field_activity_rows, sheet_sync_runs restart identity cascade`);
    const headers = ["Activity ID", "Employee Name.", "Customer Name", "Date", "Meeting Note"];
    const rows = [
      { rowNumber: 2, cells: { "Activity ID": "OLD1", "Employee Name.": "Mahesh Patil", "Customer Name": "Sai Paint Depot", Date: "15/09/2026", "Meeting Note": "before" } },
      { rowNumber: 3, cells: { "Activity ID": "NEW1", "Employee Name.": "Mahesh Patil", "Customer Name": "Sai Paint Depot", Date: "12/10/2026", "Meeting Note": "after" } },
    ];
    const reader = async (range: { firstRow?: number }): Promise<SheetTable> =>
      range.firstRow === 1
        ? ({ headers, rows: [], rowsInWindow: 1 } as unknown as SheetTable)
        : ({ headers, rows, rowsInWindow: rows.length } as unknown as SheetTable);

    const outcome = await syncFieldActivitySheet({ spreadsheetId: "x", mode: "reconcile", reader });
    const stored = await db.select({ activityId: sheetFieldActivityRows.activityId }).from(sheetFieldActivityRows);
    assert.deepEqual(stored.map((r) => r.activityId), ["OLD1"]);
    assert.match(JSON.stringify(outcome), /left out/);
  });

  test("the projection puts only rows before the cutover on the timeline", async () => {
    const result = await projectFieldActivityTimeline();
    assert.equal(result.written, 1);
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.customerId, shop.id));
    assert.equal(events.length, 1);
    assert.equal(events[0].occurredAt.toISOString().slice(0, 10), "2026-10-05");
  });
});
