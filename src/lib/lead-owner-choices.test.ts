import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, notifications, timelineEvents, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { assignDeskLead, bulkAssignDeskLeads } from "@/lib/actions/lead-desk-assignment";
import { deskHolders, ownerChoices } from "@/lib/services/lead-desk-assignment-service";
import { UNASSIGNED, firstChoosable, ownerIdFor } from "@/components/leads/owner-options";

/* ---------------------------------------------------------------------------
 * THE CHANGE OWNER LIST SHOWS EVERYBODY, AND THE SERVER'S RULE IS UNCHANGED.
 *
 * Every active CRM user is listed (those without the Calling desk are flagged so
 * the screen can draw them disabled), "Unassigned" is a real choice, and handing
 * a lead to somebody with no desk is still refused exactly as before.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type U = typeof users.$inferSelect;
const DESK = "crm.lead-calling-desk";

let manager: U; // may hand leads out: lead.verify + the desk
let ravi: U; // a desk holder, owns the leads
let seema: U; // a desk holder
let heena: U; // CRM only — no Calling desk
let plain: U; // a desk holder who may not hand leads out

async function makeUser(name: string, role: "associate" | "manager", apps: Array<"crm" | "field"> = ["crm"], active = true) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
      active,
    })
    .returning();
  for (const app of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  return row;
}
const grantDesk = (userId: string) =>
  db.insert(appModuleAccess).values({ id: id("mod"), userId, app: "crm", module: DESK });

const lead = async (over: Partial<typeof customers.$inferInsert> = {}) => {
  const [l] = await db
    .insert(customers)
    .values({
      id: id("cus"), name: `Lead ${randomUUID().slice(0, 5)}`, phone: String(9000000000 + Math.floor(Math.random() * 99999999)),
      city: "Pune", kind: "lead", leadStage: "suspect", leadSalesType: "direct", ownerId: ravi.id, ...over,
    })
    .returning();
  return l;
};
const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const count = async (table: "audit_log" | "timeline_events", leadId: string, extra = "") =>
  Number((await db.execute<{ n: string }>(sql.raw(`select count(*)::int as n from ${table} where ${table === "audit_log" ? "entity_id" : "customer_id"} = '${leadId}' ${extra}`)))[0].n);

before(() => assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Integration tests must run against a mahekone_test database."));

beforeEach(async () => {
  await db.execute(sql`
    truncate table notifications, timeline_events, audit_log, app_module_access, app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  manager = await makeUser("Mona Manager", "manager");
  ravi = await makeUser("Ravi Telecaller", "associate");
  seema = await makeUser("Seema Roy", "associate");
  heena = await makeUser("Heena Backoffice", "associate");
  await makeUser("Gone Person", "associate", ["crm"], false); // inactive
  await makeUser("Field Only", "associate", ["field"]); // no CRM at all
  plain = await makeUser("Plain Caller", "associate");
  for (const u of [manager, ravi, seema, plain]) await grantDesk(u.id);
  // A CRM account with NO module rows holds every module, the desk included, so "no Calling
  // desk" has to be an explicit narrower grant — which is what a real deployment carries.
  await db.insert(appModuleAccess).values({ id: id("mod"), userId: heena.id, app: "crm", module: "crm.leads" });
  // The manager sees the leads of the people who report to them.
  await db.update(users).set({ reportsToId: manager.id }).where(sql`id in (${ravi.id}, ${seema.id}, ${plain.id})`);
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("who the list shows", () => {
  test("every active CRM user, in name order, with the desk marked", async () => {
    const choices = await ownerChoices();
    assert.deepEqual(choices.map((c) => c.name), [...choices.map((c) => c.name)].sort((a, b) => a.localeCompare(b)));
    const byName = new Map(choices.map((c) => [c.name, c.canOwn]));
    assert.equal(byName.get("Seema Roy"), true);
    assert.equal(byName.get("Ravi Telecaller"), true);
    assert.equal(byName.get("Heena Backoffice"), false, "listed, but cannot be chosen");
    assert.equal(byName.has("Gone Person"), false, "an inactive account is not offered");
    assert.equal(byName.has("Field Only"), false, "somebody with no CRM is not offered");
  });

  test("the old list is unchanged and is still what the server accepts", async () => {
    const holders = (await deskHolders()).map((p) => p.name);
    assert.deepEqual(holders.sort(), ["Mona Manager", "Plain Caller", "Ravi Telecaller", "Seema Roy"]);
    assert.ok(!holders.includes("Heena Backoffice"));
  });

  test("the picker helpers", () => {
    assert.equal(ownerIdFor(UNASSIGNED), null);
    assert.equal(ownerIdFor("usr_1"), "usr_1");
    assert.equal(firstChoosable([{ id: "a", name: "A", canOwn: false }, { id: "b", name: "B", canOwn: true }]), "b");
    assert.equal(firstChoosable([{ id: "a", name: "A", canOwn: false }]), UNASSIGNED);
    assert.equal(firstChoosable([{ id: "a", name: "A" }]), "a", "no flag means choosable");
  });
});

describe("handing a lead to a person is unchanged", () => {
  test("a desk holder is accepted, and told", async () => {
    const l = await lead();
    const r = await assignDeskLead({ customerId: l.id, ownerId: seema.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(l.id)).ownerId, seema.id);
    const told = await db.select().from(notifications).where(eq(notifications.userId, seema.id));
    assert.equal(told.length, 1);
  });

  test("somebody without the Calling desk is still refused, and nothing moves", async () => {
    const l = await lead();
    const r = await assignDeskLead({ customerId: l.id, ownerId: heena.id });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /cannot open the Calling desk/);
    assert.equal((await row(l.id)).ownerId, ravi.id);
    assert.equal(await count("audit_log", l.id), 0);
  });

  test("somebody who may not hand leads out is still refused", async () => {
    const l = await lead();
    setTestUser(plain);
    const r = await assignDeskLead({ customerId: l.id, ownerId: seema.id });
    assert.equal(r.ok, false);
    assert.equal((await row(l.id)).ownerId, ravi.id);
  });
});

describe("Unassigned", () => {
  test("takes the owner off, with a trail, and tells the old owner", async () => {
    const l = await lead();
    const r = await assignDeskLead({ customerId: l.id, ownerId: null });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(l.id)).ownerId, null);
    assert.equal(await count("audit_log", l.id, "and action = 'lead.unassigned'"), 1);
    const events = await db
      .select()
      .from(timelineEvents)
      .where(and(eq(timelineEvents.customerId, l.id), eq(timelineEvents.eventType, "owner_change")));
    assert.equal(events.length, 1);
    assert.match(events[0].summary, /Unassigned from Ravi Telecaller/);
    const told = await db.select().from(notifications).where(eq(notifications.userId, ravi.id));
    assert.match(told[0].body, /unassigned/);
  });

  test("a next action the old owner held goes with them; the manager's stays", async () => {
    const mine = await lead({ leadNextAction: "Ring back", leadNextActionDate: "2026-10-20", leadNextActionOwnerId: ravi.id });
    const managers = await lead({ leadNextAction: "Verify", leadNextActionDate: "2026-10-20", leadNextActionOwnerId: manager.id });
    await assignDeskLead({ customerId: mine.id, ownerId: null });
    await assignDeskLead({ customerId: managers.id, ownerId: null });
    assert.equal((await row(mine.id)).leadNextActionOwnerId, null);
    assert.equal((await row(managers.id)).leadNextActionOwnerId, manager.id);
  });

  test("asking twice changes and records nothing more", async () => {
    const l = await lead();
    await assignDeskLead({ customerId: l.id, ownerId: null });
    const again = await assignDeskLead({ customerId: l.id, ownerId: null });
    assert.equal(again.ok, true);
    assert.match(again.ok ? (again.message ?? "") : "", /Already unassigned/);
    assert.equal(await count("audit_log", l.id, "and action = 'lead.unassigned'"), 1);
  });

  test("an unassigned lead can be handed out again", async () => {
    const l = await lead({ ownerId: null });
    const r = await assignDeskLead({ customerId: l.id, ownerId: seema.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(l.id)).ownerId, seema.id);
    assert.equal(await count("audit_log", l.id, "and action = 'lead.deskAssigned'"), 1);
  });

  test("somebody who may not hand leads out cannot unassign either", async () => {
    const l = await lead();
    setTestUser(plain);
    const r = await assignDeskLead({ customerId: l.id, ownerId: null });
    assert.equal(r.ok, false);
    assert.equal((await row(l.id)).ownerId, ravi.id);
  });

  test("in bulk: each lead moves by the same rules and the unchanged one is named", async () => {
    const a = await lead();
    const b = await lead({ ownerId: null });
    const r = await bulkAssignDeskLeads({ leadIds: [a.id, b.id], ownerId: null });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(r.ok && r.data.done, 1);
    assert.deepEqual(r.ok && r.data.failed.map((f) => f.why), ["already unassigned"]);
    assert.match(r.ok ? (r.message ?? "") : "", /1 lead now unassigned/);
    assert.equal((await row(a.id)).ownerId, null);
  });

  test("in bulk, a person with no desk is still refused as a whole", async () => {
    const a = await lead();
    const r = await bulkAssignDeskLeads({ leadIds: [a.id], ownerId: heena.id });
    assert.equal(r.ok, false);
    assert.equal((await row(a.id)).ownerId, ravi.id);
  });

  test("an archived lead is not unassigned", async () => {
    const l = await lead({ leadArchived: true });
    const r = await assignDeskLead({ customerId: l.id, ownerId: null });
    assert.equal(r.ok, false);
    assert.equal((await row(l.id)).ownerId, ravi.id);
  });
});
