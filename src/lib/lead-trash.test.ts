/**
 * THE LEAD TRASH, end to end against the real services: who may delete, what
 * may be deleted, that a trashed lead leaves the reads that matter (the
 * record, every scoped list, the handset book), that phones are told, and that
 * only an administrator lists the trash and restores from it — whole.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, customers, leadTrashEvents, mbosDeletions, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { scopedToUsers } from "@/lib/access-control";
import { getCustomer } from "@/lib/queries";
import { listTrash, restoreLeads, trashLeads } from "@/lib/services/lead-trash-service";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let admin: typeof users.$inferSelect;
let manager: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;
let leadId: string;
let otherLeadId: string;
let customerId: string;

async function person(name: string, role: "admin" | "manager" | "associate") {
  const [u] = await db
    .insert(users)
    .values({ id: id("usr"), name, email: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}@t.local`, passwordHash: "x", role, initials: "XX" })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: u.id, app: "crm", role });
  return u;
}

beforeEach(async () => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against mahekone_test.");
  await db.execute(sql`
    truncate table lead_trash_events, mbos_deletions, audit_log, app_access, sessions, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  admin = await person("Admin", "admin");
  manager = await person("Manager", "manager");
  telecaller = await person("Priya", "associate");
  // A manager's scope is their reports — without this line it is empty.
  await db.update(users).set({ reportsToId: manager.id }).where(eq(users.id, telecaller.id));
  telecaller = { ...telecaller, reportsToId: manager.id };
  leadId = id("cus");
  otherLeadId = id("cus");
  customerId = id("cus");
  await db.insert(customers).values([
    { id: leadId, name: "Duplicate Paints", kind: "lead", ownerId: telecaller.id, contactPerson: "A", phone: "9820011111", city: "Pune" },
    { id: otherLeadId, name: "Real Lead", kind: "lead", ownerId: telecaller.id, contactPerson: "B", phone: "9820022222", city: "Pune" },
    { id: customerId, name: "Billed Shop", kind: "customer", ownerId: telecaller.id, contactPerson: "C", phone: "9820033333", city: "Pune" },
  ]);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

test("a telecaller cannot delete a lead; a manager can, with a reason, and a billed customer is refused by name", async () => {
  setTestUser(telecaller);
  await assert.rejects(() => trashLeads({ ids: [leadId], reason: "Duplicate" }));

  setTestUser(manager);
  const short = await trashLeads({ ids: [leadId], reason: "x" });
  assert.equal(short.ok, false, "a reason is required");

  const r = await trashLeads({ ids: [leadId, customerId], reason: "Duplicate of Real Lead" });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.data.moved, 1);
  assert.deepEqual(r.data.failed.map((f) => f.id), [customerId], "the billed customer is named back, not moved");

  const [row] = await db.select().from(customers).where(eq(customers.id, leadId));
  assert.ok(row.deletedAt);
  assert.equal(row.deletedById, manager.id);
  assert.equal(row.deletedReason, "Duplicate of Real Lead");
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  assert.equal(c.deletedAt, null);
});

test("a trashed lead leaves the record loader, every scoped list and the handsets", async () => {
  setTestUser(manager);
  await trashLeads({ ids: [leadId], reason: "Test entry" });

  // Opening it by id answers as missing.
  setTestUser(admin);
  assert.equal(await getCustomer(leadId), null);
  assert.ok(await getCustomer(otherLeadId), "the live lead still opens");

  // Every scoped read — the whole-book reader included.
  for (const ids of [null, [telecaller.id]]) {
    const seen = await db.select({ id: customers.id }).from(customers).where(scopedToUsers(ids));
    assert.ok(!seen.some((s) => s.id === leadId), `scope ${ids ? "narrowed" : "whole book"} leaves it out`);
    assert.ok(seen.some((s) => s.id === otherLeadId));
  }

  // Phones are told: off the Customers list, and archived under Leads.
  const marks = await db.select().from(mbosDeletions).where(eq(mbosDeletions.entityId, leadId));
  assert.deepEqual(marks.map((m) => m.entity).sort(), ["customers", "leads"]);
  assert.ok(marks.every((m) => m.userId === null && m.reason === "lead_trashed"));
});

test("only an administrator lists the trash and restores; a restore brings the lead back whole and withdraws the tombstones", async () => {
  setTestUser(manager);
  await trashLeads({ ids: [leadId, otherLeadId], reason: "Wrong numbers" });
  await assert.rejects(() => listTrash({}));
  await assert.rejects(() => restoreLeads({ ids: [leadId] }));

  setTestUser(admin);
  const page = await listTrash({ perPage: 25 });
  assert.equal(page.total, 2);
  assert.deepEqual(new Set(page.rows.map((r) => r.id)), new Set([leadId, otherLeadId]));
  assert.equal(page.rows[0].deletedByName, "Manager");
  assert.equal(page.rows[0].reason, "Wrong numbers");
  assert.deepEqual(page.deleters.map((d) => [d.name, d.count]), [["Manager", 2]]);
  assert.equal((await listTrash({ q: "Duplicate" })).total, 1, "search");
  assert.equal((await listTrash({ q: "20011111" })).total, 1, "search by phone digits");
  assert.equal((await listTrash({ perPage: 25, page: 99 })).page, 1, "a page past the end is the last page");

  const [before] = await db.select().from(customers).where(eq(customers.id, leadId));
  const r = await restoreLeads({ ids: [leadId] });
  assert.equal(r.ok, true, r.ok ? "" : r.error);

  const [back] = await db.select().from(customers).where(eq(customers.id, leadId));
  assert.equal(back.deletedAt, null);
  assert.equal(back.ownerId, telecaller.id, "same owner");
  assert.ok(back.updatedAt > before.updatedAt, "moved, so every phone's next pull sends it back");
  assert.ok(await getCustomer(leadId));
  assert.equal(
    (await db.select().from(mbosDeletions).where(eq(mbosDeletions.entityId, leadId))).length,
    0,
    "a phone that never synced in between is never told to drop it",
  );
  const events = await db.select().from(leadTrashEvents).where(eq(leadTrashEvents.customerId, leadId));
  assert.deepEqual(events.map((e) => e.action).sort(), ["restored", "trashed"]);
  assert.equal((await listTrash({})).total, 1, "the other one is still in the trash");

  // Restoring something not in the trash is refused rather than half-done.
  const again = await restoreLeads({ ids: [leadId, otherLeadId] });
  assert.equal(again.ok, false);
  const [still] = await db.select().from(customers).where(and(eq(customers.id, otherLeadId)));
  assert.ok(still.deletedAt, "nothing in that batch moved");
});
