/**
 * TABS AS GRANTS, against the database — saved through the Manage access
 * dialog's own path (`setAccess` with `screenGrants`), read back by the ERP
 * (`erpContext`), refused at the write (`requireErpWrite`), and kept by the
 * backfill job.
 *
 *   npm run test:integration
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, appScreenAccess, employees, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { setAccess, type ScreenGrantInput } from "@/lib/actions/access";
import { loadScreenAccess } from "@/lib/actions/screen-access";
import { erpContext, requireErpWrite } from "@/lib/erp/access";
import { accessScreensBackfill } from "@/lib/services/access-screens-backfill";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
let boss: typeof users.$inferSelect;

async function account(name: string) {
  const [e] = await db
    .insert(employees)
    .values({ id: id("emp"), rowNumber: Math.floor(Math.random() * 1e6), employeeCode: `E${randomUUID().slice(0, 6)}`, name, status: "active", raw: {}, rowHash: randomUUID() })
    .returning();
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${randomUUID().slice(0, 8)}@test.local`, phone: `98330${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`, passwordHash: "x", role: "associate", initials: name.slice(0, 2).toUpperCase(), employeeId: e.id })
    .returning();
  return u;
}

/** Material returns given; Supplier returns at Edit, narrowed to whichever of its tabs are named. */
function erpReturns(tabs: string[]): ScreenGrantInput {
  return {
    app: "erp",
    position: "associate",
    modules: ["ERP · Material returns"],
    screens: [
      { screen: "erp.customerReturns", edit: false, delete: false, autoEdit: false },
      { screen: "erp.vendorReturns", edit: true, delete: false, autoEdit: false },
      ...tabs.map((t) => ({ screen: `erp.vendorReturns.${t}`, edit: false, delete: false, autoEdit: false })),
    ],
  };
}

async function asPerson(u: typeof users.$inferSelect) {
  setTestUser((await db.select().from(users).where(eq(users.id, u.id)))[0]);
  return erpContext();
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
    .values({ id: id("usr"), name: "Boss", email: `boss-${randomUUID().slice(0, 4)}@test.local`, phone: "9820000002", passwordHash: "x", role: "admin", initials: "BO" })
    .returning();
  boss = row;
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "admin", role: "admin" });
  setTestUser(boss);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("a page given whole holds every tab; narrowed, only the tabs ticked — and their writes", async () => {
  const p = await account("Gate Clerk");
  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [erpReturns([])] })).ok);
  let ctx = await asPerson(p);
  assert.ok(ctx.screens.has("debitNotes") && ctx.screens.has("returnOutwards"), "no tab ticked means every tab");
  assert.equal(ctx.withheld?.size ?? 0, 0);

  setTestUser(boss);
  const r = await setAccess({ userId: p.id, grants: [], screenGrants: [erpReturns(["debitNotes"])] });
  assert.ok(r.ok, r.ok ? "" : r.error);
  const stored = await db.select({ screen: appScreenAccess.screen }).from(appScreenAccess).where(eq(appScreenAccess.userId, p.id));
  assert.ok(stored.some((s) => s.screen === "erp.vendorReturns.debitNotes"), "the tab is a screen row");
  const modules = await db.select({ module: appModuleAccess.module }).from(appModuleAccess).where(eq(appModuleAccess.userId, p.id));
  assert.ok(!modules.some((m) => m.module.startsWith("erp.vendorReturns.")), "and never a module row");

  ctx = await asPerson(p);
  assert.ok(ctx.screens.has("vendorReturns"), "the page still opens — its key is also its Purchase returns tab's");
  assert.ok(ctx.screens.has("debitNotes"));
  assert.equal(ctx.screens.has("returnOutwards"), false, "Return outwards withheld");
  assert.ok(ctx.withheld?.has("vendorReturns") && ctx.withheld.has("returnOutwards"));
  assert.ok(ctx.powers.has("returnApprove"), "Edit on the page still carries its powers");

  await assert.doesNotReject(requireErpWrite("debitNotes"), "Debit note writes go through");
  await assert.rejects(requireErpWrite("vendorReturns"), /not on your account/, "a Purchase returns write is refused");
  await assert.rejects(requireErpWrite("returnOutwards"), /not on your account/);
});

test("the dialog opens on the narrowing it saved", async () => {
  const p = await account("Bill Clerk");
  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [erpReturns(["vendorReturns", "returnOutwards"])] })).ok);
  const view = await loadScreenAccess(p.id);
  assert.ok(view.ok);
  const erp = view.data.apps.find((a) => a.app === "erp")!;
  const keys = erp.screens.map((s) => s.screen);
  assert.ok(keys.includes("erp.vendorReturns.vendorReturns") && keys.includes("erp.vendorReturns.returnOutwards") && !keys.includes("erp.vendorReturns.debitNotes"));
});

test("every tab ticked is stored as none, and the backfill job keeps a narrowing", async () => {
  const p = await account("Store Keeper");
  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [erpReturns(["debitNotes", "vendorReturns", "returnOutwards"])] })).ok);
  const all = await db.select({ screen: appScreenAccess.screen }).from(appScreenAccess).where(eq(appScreenAccess.userId, p.id));
  assert.ok(!all.some((s) => s.screen.startsWith("erp.vendorReturns.")), "all three is the same as none");

  assert.ok((await setAccess({ userId: p.id, grants: [], screenGrants: [erpReturns(["debitNotes"])] })).ok);
  await accessScreensBackfill();
  const after = await db
    .select({ screen: appScreenAccess.screen })
    .from(appScreenAccess)
    .where(and(eq(appScreenAccess.userId, p.id), eq(appScreenAccess.app, "erp")));
  assert.ok(after.some((s) => s.screen === "erp.vendorReturns.debitNotes"), "reconverting from the older tables does not widen the page back");
  const ctx = await asPerson(p);
  assert.equal(ctx.screens.has("returnOutwards"), false);
});
