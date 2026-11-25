/**
 * 0374_erp_ticks_everywhere — Edit and Delete now count on every ERP page, and
 * NOBODY'S ACCESS MOVES: every grant already in the screen model gets both
 * ticks on each non-Purchase page it holds. Purchase's pages, tab rows and
 * grants not yet converted are left alone. The migration has run on
 * mahekone_test, so each case writes the shape a grant had BEFORE it and runs
 * the file again, then reads what it left.
 *
 *   npm run test:db && npm run test:integration
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appScreenAccess, users } from "@/db/schema";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const MIGRATION = readFileSync(new URL("../../../drizzle/0374_erp_ticks_everywhere.sql", import.meta.url), "utf8");

async function runMigration() {
  for (const part of MIGRATION.split("--> statement-breakpoint")) if (part.trim()) await db.execute(sql.raw(part));
}

async function person(name: string, position: "associate" | null) {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${randomUUID().slice(0, 8)}@test.local`, phone: `98332${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`, passwordHash: "x", role: "associate", initials: "TT" })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "erp", role: "associate", position });
  return u;
}
const row = (userId: string, screen: string, edit = false, del = false) => ({ id: id("scr"), userId, app: "erp" as const, screen, canEdit: edit || del, canDelete: del });
async function ticks(userId: string) {
  const rows = await db.select().from(appScreenAccess).where(eq(appScreenAccess.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.screen, [r.canEdit, r.canDelete]]));
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against mahekone_test.");
});
after(async () => {
  await db.$client.end();
});

test("a converted grant gets Edit and Delete on every non-Purchase page it holds — what it could do yesterday", async () => {
  const p = await person("Floor Lead", "associate");
  await db.insert(appScreenAccess).values([row(p.id, "erp.sfgBatches"), row(p.id, "erp.orders", true), row(p.id, "erp.transport")]);
  await runMigration();
  const t = await ticks(p.id);
  for (const s of ["erp.sfgBatches", "erp.orders", "erp.transport"]) assert.deepEqual(t[s], [true, true], s);
  assert.equal(t["erp.customers"], undefined, "a page not held is not given");
});

test("Purchase's pages and tab rows keep the ticks they were given", async () => {
  const p = await person("Buyer", "associate");
  await db.insert(appScreenAccess).values([row(p.id, "erp.requisitions"), row(p.id, "erp.register", true), row(p.id, "erp.vendorReturns.debitNotes"), row(p.id, "erp.vendorReturns")]);
  await runMigration();
  const t = await ticks(p.id);
  assert.deepEqual(t["erp.requisitions"], [false, false], "Purchase's ticks have been enforced since its redesign");
  assert.deepEqual(t["erp.register"], [true, false]);
  assert.deepEqual(t["erp.vendorReturns.debitNotes"], [false, false], "a tab row is not a page");
  assert.deepEqual(t["erp.vendorReturns"], [true, true]);
});

test("a grant not yet in the screen model is not touched (it already holds every tick)", async () => {
  const p = await person("Old Grant", null);
  await db.insert(appScreenAccess).values(row(p.id, "erp.sfgBatches"));
  await runMigration();
  assert.deepEqual((await ticks(p.id))["erp.sfgBatches"], [false, false]);
});
