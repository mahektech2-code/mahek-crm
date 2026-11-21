/**
 * THE SCREEN-MODEL BACKFILL, AGAINST THE DATABASE.
 *
 * Seeds people with the grants the building actually holds — a whole-app
 * telecaller, a narrowed manager, an ERP clerk with powers, a Tasks power, the
 * platform administrator — runs `access-screens-backfill`, and reads back
 * what it wrote: position, one row per screen, the Delete-needs-Edit rule the
 * database itself enforces, an audit row each, and that a second run writes
 * the same thing.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, appScreenAccess, auditLog, erpUserPowers, taskUserPowers, users } from "@/db/schema";
import type { AppId } from "@/lib/apps";
import { accessScreensBackfill } from "@/lib/services/access-screens-backfill";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
let phoneSeq = 0;

async function person(name: string, role: "associate" | "manager" | "admin" = "associate") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${randomUUID().slice(0, 8)}@test.local`, phone: `98310${String(++phoneSeq).padStart(5, "0")}`, passwordHash: "x", role, initials: name.slice(0, 2).toUpperCase() })
    .returning();
  return u;
}

async function give(userId: string, app: AppId, role: "associate" | "manager" | "admin" | null, modules?: string[]) {
  await db.insert(appAccess).values({ id: id("aca"), userId, app, role });
  for (const m of modules ?? []) await db.insert(appModuleAccess).values({ id: id("amo"), userId, app, module: m });
}

const rowsOf = (userId: string, app: AppId) =>
  db.select().from(appScreenAccess).where(and(eq(appScreenAccess.userId, userId), eq(appScreenAccess.app, app)));
const positionOf = async (userId: string, app: AppId) =>
  (await db.select({ p: appAccess.position }).from(appAccess).where(and(eq(appAccess.userId, userId), eq(appAccess.app, app))))[0]?.p;

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table app_screen_access, app_module_access, app_access, erp_user_powers, hrms_user_powers, task_user_powers,
      sessions, audit_log, users
    restart identity cascade
  `);
});

after(async () => {
  await db.$client.end();
});

test("a whole-app telecaller: associate, every CRM screen, Edit where the level edited, no Delete", async () => {
  const priya = await person("Priya");
  await give(priya.id, "crm", "associate");
  const r = await accessScreensBackfill();
  assert.equal(r.refused.length, 0);
  assert.equal(await positionOf(priya.id, "crm"), "associate");
  const rows = await rowsOf(priya.id, "crm");
  const by = new Map(rows.map((x) => [x.screen, x]));
  assert.ok(by.has("crm.call-log") && by.has("crm.leads") && by.has("crm.customers"));
  assert.equal(by.get("crm.customers")?.canEdit, true);
  assert.equal(by.get("crm.leads")?.canDelete, false);
  assert.ok(rows.every((x) => !x.canDelete));
});

test("a narrowed manager keeps only their screens, and is told what went with the rest", async () => {
  const rakesh = await person("Rakesh", "manager");
  await give(rakesh.id, "crm", "manager", ["crm.call-log", "crm.leads"]);
  const r = await accessScreensBackfill();
  assert.equal(r.refused.length, 0);
  assert.equal(await positionOf(rakesh.id, "crm"), "manager");
  const screens = (await rowsOf(rakesh.id, "crm")).map((x) => x.screen).sort();
  assert.ok(screens.includes("crm.call-log") && screens.includes("crm.leads"));
  assert.ok(!screens.includes("crm.customers"));
  assert.equal((await rowsOf(rakesh.id, "crm")).find((x) => x.screen === "crm.leads")?.canDelete, true);
  assert.ok(r.noted.find((n) => n.userId === rakesh.id)?.diff.lostWithScreen.length);
});

test("ERP powers become their screens' ticks; Delete without its own Edit is marked as brought by Delete", async () => {
  const clerk = await person("Clerk");
  await give(clerk.id, "erp", "associate", ["erp.orders"]);
  await db.insert(erpUserPowers).values([
    { id: id("eup"), userId: clerk.id, power: "approvePurchaseOrder" },
    { id: id("eup"), userId: clerk.id, power: "reopenPurchase" },
  ] as never);
  await accessScreensBackfill();
  const by = new Map((await rowsOf(clerk.id, "erp")).map((x) => [x.screen, x]));
  assert.equal(by.get("erp.purchaseOrders")?.canEdit, true);
  assert.deepEqual([by.get("erp.register")?.canEdit, by.get("erp.register")?.canDelete, by.get("erp.register")?.editByDelete], [true, true, true]);
});

test("a Tasks everybody power raises the position to everyone", async () => {
  const deepa = await person("Deepa");
  await give(deepa.id, "tasks", "associate");
  await db.insert(taskUserPowers).values({ id: id("tup"), userId: deepa.id, power: "seeAll" } as never);
  await accessScreensBackfill();
  assert.equal(await positionOf(deepa.id, "tasks"), "everyone");
});

test("the platform administrator holds every screen at Edit and Delete, as everyone", async () => {
  const vikram = await person("Vikram", "admin");
  await give(vikram.id, "admin", "admin");
  await give(vikram.id, "erp", "associate", ["erp.orders"]);
  await accessScreensBackfill();
  assert.equal(await positionOf(vikram.id, "erp"), "everyone");
  const rows = await rowsOf(vikram.id, "erp");
  assert.ok(rows.length > 30);
  assert.ok(rows.every((x) => x.canEdit && x.canDelete));
});

test("a dry run writes nothing; a real run audits each grant; a second run writes the same rows", async () => {
  const a = await person("A");
  await give(a.id, "crm", "associate");
  await give(a.id, "hrms", null);
  const dry = await accessScreensBackfill({ dryRun: true });
  assert.equal(dry.converted, 2);
  assert.equal((await db.select().from(appScreenAccess)).length, 0);
  assert.equal(await positionOf(a.id, "crm"), null);

  await accessScreensBackfill();
  const first = (await db.select().from(appScreenAccess)).map((x) => `${x.screen} ${x.canEdit} ${x.canDelete}`).sort();
  assert.equal((await db.select().from(auditLog).where(eq(auditLog.action, "access.screens-backfill"))).length, 2);

  await accessScreensBackfill();
  const second = (await db.select().from(appScreenAccess)).map((x) => `${x.screen} ${x.canEdit} ${x.canDelete}`).sort();
  assert.deepEqual(second, first);
});

test("the database refuses Delete without Edit", async () => {
  const a = await person("A");
  await assert.rejects(
    db.insert(appScreenAccess).values({ id: id("scr"), userId: a.id, app: "crm", screen: "crm.leads", canEdit: false, canDelete: true }),
  );
});
