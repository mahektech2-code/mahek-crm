/**
 * 0372_erp_purchases_split — Purchases' three tabs become three pages, and
 * NOBODY'S ACCESS MOVES. The migration has already run on mahekone_test, so
 * each case writes the shape a grant had BEFORE it and runs the file again
 * (it is written to be re-runnable), then reads what it left.
 *
 *   npm run test:db && npm run test:integration
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appModuleAccess, appScreenAccess, erpDesignationModules, erpDesignations, users } from "@/db/schema";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const MIGRATION = readFileSync(new URL("../../../drizzle/0372_erp_purchases_split.sql", import.meta.url), "utf8");

async function runMigration() {
  for (const part of MIGRATION.split("--> statement-breakpoint")) if (part.trim()) await db.execute(sql.raw(part));
}

async function person(name: string) {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${randomUUID().slice(0, 8)}@test.local`, phone: `98331${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`, passwordHash: "x", role: "associate", initials: "TT" })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: "associate", position: "associate" });
  return u;
}

async function modules(userId: string) {
  return (await db.select({ m: appModuleAccess.module }).from(appModuleAccess).where(eq(appModuleAccess.userId, userId))).map((r) => r.m).sort();
}
async function screens(userId: string) {
  const rows = await db.select().from(appScreenAccess).where(eq(appScreenAccess.userId, userId));
  return new Map(rows.map((r) => [r.screen, { edit: r.canEdit, del: r.canDelete }]));
}
const modRow = (userId: string, module: string) => ({ id: id("mod"), userId, app: "erp" as const, module });
const scrRow = (userId: string, screen: string, edit = false, del = false) => ({ id: id("scr"), userId, app: "erp" as const, screen, canEdit: edit || del, canDelete: del });

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test.");
});

after(async () => {
  await db.$client.end();
});

test("a whole Purchases page becomes all three pages, with the same ticks", async () => {
  const p = await person("Whole Page");
  await db.insert(appModuleAccess).values([modRow(p.id, "erp.register"), modRow(p.id, "erp.requisitions")]);
  await db.insert(appScreenAccess).values([scrRow(p.id, "erp.register", true, true), scrRow(p.id, "erp.requisitions")]);
  await runMigration();
  assert.deepEqual(await modules(p.id), ["erp.barcode", "erp.inward", "erp.register", "erp.requisitions"]);
  const s = await screens(p.id);
  for (const page of ["erp.register", "erp.inward", "erp.barcode"]) assert.deepEqual(s.get(page), { edit: true, del: true }, page);
  assert.deepEqual(s.get("erp.requisitions"), { edit: false, del: false }, "other pages untouched");
});

test("a page narrowed to tabs keeps exactly those tabs, as pages", async () => {
  const gate = await person("Gate Only");
  await db.insert(appModuleAccess).values(modRow(gate.id, "erp.register"));
  await db.insert(appScreenAccess).values([scrRow(gate.id, "erp.register", true), scrRow(gate.id, "erp.register.inward")]);
  const bills = await person("Bills And Labels");
  await db.insert(appModuleAccess).values(modRow(bills.id, "erp.register"));
  await db.insert(appScreenAccess).values([scrRow(bills.id, "erp.register"), scrRow(bills.id, "erp.register.register"), scrRow(bills.id, "erp.register.barcode")]);
  await runMigration();

  assert.deepEqual(await modules(gate.id), ["erp.inward"], "Goods in only — Bills (its Register tab) was not held");
  assert.deepEqual([...(await screens(gate.id)).entries()], [["erp.inward", { edit: true, del: false }]]);

  assert.deepEqual(await modules(bills.id), ["erp.barcode", "erp.register"]);
  const s = await screens(bills.id);
  assert.deepEqual([...s.keys()].sort(), ["erp.barcode", "erp.register"], "no tab rows left, no Goods in");
});

test("an account with no ERP rows is not touched (it already holds every screen)", async () => {
  const p = await person("Everything");
  await runMigration();
  assert.deepEqual(await modules(p.id), []);
  assert.equal((await screens(p.id)).size, 0);
});

test("a designation carrying Purchases carries Goods in and Drum labels too; running it twice changes nothing", async () => {
  const [d] = await db.insert(erpDesignations).values({ id: id("des"), name: `Store ${randomUUID().slice(0, 6)}` }).returning();
  await db.insert(erpDesignationModules).values({ designationId: d.id, module: "erp.register" });
  await runMigration();
  await runMigration();
  const mods = await db.select({ m: erpDesignationModules.module }).from(erpDesignationModules).where(inArray(erpDesignationModules.designationId, [d.id]));
  assert.deepEqual(mods.map((r) => r.m).sort(), ["erp.barcode", "erp.inward", "erp.register"]);
});
