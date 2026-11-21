/**
 * THE SCREEN MODEL, SWITCHED ON — against the database, through the real
 * checks and the real save.
 *
 * A converted grant (a position is set) is answered from its ticks: an action
 * is allowed only with the tick that owns it, and the position decides whose
 * records are seen. Saving through the dialog's path (`setAccess` with
 * `screenGrants`) writes the ticks and keeps every table the rest of the app
 * reads — modules, level, ERP/HRMS/Tasks powers — derived from them. An
 * unconverted grant goes on meaning what its level meant.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, appScreenAccess, employees, erpUserPowers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { canFor, scopeForUser } from "@/lib/access-control";
import { setAccess, type ScreenGrantInput } from "@/lib/actions/access";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
let boss: typeof users.$inferSelect;
let seq = 0;

async function account(name: string) {
  const [e] = await db
    .insert(employees)
    .values({ id: id("emp"), rowNumber: Math.floor(Math.random() * 1e6), employeeCode: `E${randomUUID().slice(0, 6)}`, name, status: "active", raw: {}, rowHash: randomUUID() })
    .returning();
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${randomUUID().slice(0, 8)}@test.local`, phone: `98320${String(++seq).padStart(5, "0")}`, passwordHash: "x", role: "associate", initials: name.slice(0, 2).toUpperCase(), employeeId: e.id })
    .returning();
  return u;
}

const fresh = async (userId: string) => (await db.select().from(users).where(eq(users.id, userId)))[0];

/* The CRM's Lead Management module, given; All Leads at whatever ticks. */
function crmLeads(position: ScreenGrantInput["position"], leads: { edit: boolean; delete: boolean }): ScreenGrantInput {
  return {
    app: "crm",
    position,
    modules: ["Lead Management", "Daily calling"],
    screens: [
      { screen: "crm.leads", edit: leads.edit, delete: leads.delete, autoEdit: false },
      { screen: "crm.call-log", edit: false, delete: false, autoEdit: false },
    ],
  };
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table app_screen_access, app_module_access, app_access, erp_user_powers, hrms_user_powers, task_user_powers,
      notifications, sessions, audit_log, employees, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  const [row] = await db
    .insert(users)
    .values({ id: id("usr"), name: "Boss", email: `boss-${randomUUID().slice(0, 4)}@test.local`, phone: "9820000001", passwordHash: "x", role: "admin", initials: "BO" })
    .returning();
  boss = row;
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "admin", role: "admin" });
  setTestUser(boss);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("an action is allowed only with the tick that owns it", async () => {
  const p = await account("Priya");
  const r = await setAccess({ userId: p.id, grants: [], screenGrants: [crmLeads("associate", { edit: false, delete: false })] });
  assert.ok(r.ok, r.ok ? "" : r.error);
  let me = await fresh(p.id);
  assert.equal(await canFor(me, "lead.work"), true, "Access on All Leads works leads");
  assert.equal(await canFor(me, "lead.trash"), false, "no Delete, no trash");

  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [crmLeads("associate", { edit: true, delete: true })] })).ok);
  me = await fresh(p.id);
  assert.equal(await canFor(me, "lead.trash"), true, "Delete on All Leads trashes leads");
});

test("position decides whose records are seen, and nothing else", async () => {
  const p = await account("Rakesh");
  const report = await account("Report");
  await db.update(users).set({ reportsToId: p.id }).where(eq(users.id, report.id));

  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [crmLeads("associate", { edit: false, delete: false })] })).ok);
  let me = await fresh(p.id);
  const hatOf = async (pos: string) => ({ app: "crm" as const, role: (pos === "associate" ? "associate" : "manager") as "associate", position: pos as "associate" });
  assert.equal((await scopeForUser(me, undefined, await hatOf("associate"))).scope.kind, "own");

  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [crmLeads("manager", { edit: false, delete: false })] })).ok);
  me = await fresh(p.id);
  const team = await scopeForUser(me, "team", await hatOf("manager"));
  assert.equal(team.scope.kind, "team");
  assert.ok(team.scope.userIds?.includes(report.id));
  assert.equal(await canFor(me, "lead.trash"), false, "Manager adds no permission");

  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [crmLeads("everyone", { edit: false, delete: false })] })).ok);
  me = await fresh(p.id);
  assert.equal((await scopeForUser(me, undefined, await hatOf("everyone"))).scope.kind, "all");
});

test("the save writes ticks and position, and keeps modules, level and powers derived from them", async () => {
  const p = await account("Clerk");
  const erp: ScreenGrantInput = {
    app: "erp",
    position: "associate",
    modules: ["ERP · Purchase"],
    screens: [{ screen: "erp.purchaseOrders", edit: true, delete: false, autoEdit: false }],
  };
  const r = await setAccess({ userId: p.id, grants: [], erpPowers: ["lostStock"], screenGrants: [erp] });
  assert.ok(r.ok, r.ok ? "" : r.error);

  const [grant] = await db.select().from(appAccess).where(and(eq(appAccess.userId, p.id), eq(appAccess.app, "erp")));
  assert.deepEqual([grant.role, grant.position], ["associate", "associate"]);
  const ticks = await db.select().from(appScreenAccess).where(eq(appScreenAccess.userId, p.id));
  assert.deepEqual(ticks.map((t) => [t.screen, t.canEdit, t.canDelete]), [["erp.purchaseOrders", true, false]]);
  const modules = (await db.select().from(appModuleAccess).where(eq(appModuleAccess.userId, p.id))).map((m) => m.module);
  assert.ok(modules.includes("erp.purchaseOrders"));
  const powers = (await db.select().from(erpUserPowers).where(eq(erpUserPowers.userId, p.id))).map((x) => x.power).sort();
  assert.deepEqual(powers, ["approvePurchaseOrder", "viewPurchaseMoney"], "derived from the ticks; the request's own list is ignored");
});

test("a screen under a module not given, or Delete without Edit, is mended on the server", async () => {
  const p = await account("Mended");
  const sent: ScreenGrantInput = {
    app: "crm",
    position: "associate",
    modules: ["Lead Management"],
    screens: [
      { screen: "crm.leads", edit: false, delete: true, autoEdit: false },
      { screen: "crm.call-log", edit: true, delete: false, autoEdit: false },
    ],
  };
  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [sent] })).ok);
  const ticks = await db.select().from(appScreenAccess).where(eq(appScreenAccess.userId, p.id));
  assert.deepEqual(ticks.map((t) => [t.screen, t.canEdit, t.canDelete, t.editByDelete]), [["crm.leads", true, true, true]]);
});

test("taking every screen away takes the app, its ticks and its modules", async () => {
  const p = await account("Gone");
  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [crmLeads("associate", { edit: true, delete: false })] })).ok);
  const r = await setAccess({ userId: p.id, grants: [], screenGrants: [], confirmation: undefined });
  if (!r.ok) assert.match(r.error, /confirm|impact|sure/i, "a revocation asks for the impact confirmation");
  else {
    assert.equal((await db.select().from(appAccess).where(eq(appAccess.userId, p.id))).length, 0);
    assert.equal((await db.select().from(appScreenAccess).where(eq(appScreenAccess.userId, p.id))).length, 0);
  }
});

test("an unconverted grant still means what its level meant", async () => {
  const p = await account("Old");
  await db.insert(appAccess).values({ id: id("aca"), userId: p.id, app: "crm", role: "manager" });
  const me = await fresh(p.id);
  assert.equal(await canFor(me, "lead.trash"), true);
  assert.equal(await canFor(me, "order.approve"), false);
});
