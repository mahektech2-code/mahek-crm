import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, mbosUserTerritories, notifications, timelineEvents, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { assignDeskLead, bulkAssignDeskLeads } from "@/lib/actions/lead-desk-assignment";
import { deskHolders, ownerChoices } from "@/lib/services/lead-desk-assignment-service";
import { leadsPage } from "@/lib/services/sales-service";
import { UNASSIGNED, firstChoosable, ownerIdFor } from "@/components/leads/owner-options";

/* ---------------------------------------------------------------------------
 * THE CHANGE OWNER / REASSIGN LIST SHOWS EVERYBODY, AND THE SERVER ACCEPTS THEM.
 *
 * Every active CRM or Salesman App account is listed and choosable, whether or
 * not they hold the Calling desk; "Unassigned" is a real choice; the lead lands
 * with exactly the account picked (by id); an inactive or unknown account is
 * refused. Who may hand leads out is unchanged.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type U = typeof users.$inferSelect;
const DESK = "crm.lead-calling-desk";

let manager: U; // may hand leads out: lead.verify + the desk
let ravi: U; // a desk holder, owns the leads
let seema: U; // a desk holder
let heena: U; // CRM only — no Calling desk
let plain: U; // a desk holder who may not hand leads out
let gone: U; // an inactive account
let fieldOnly: U; // the Salesman App and nothing else
let twinA: U; // two accounts that share a name,
let twinB: U; // told apart by id
let fieldNoArea: U; // Salesman App, and no area allocated: an empty handset book
let fieldWrongArea: U; // Salesman App, area allocated but not where the leads are
let noAccess: U; // active, but holds neither the CRM nor the Salesman App
let sameNameNoAccess: U; // shares a name with `seema`, and has no access

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
  gone = await makeUser("Gone Person", "associate", ["crm"], false); // inactive
  fieldOnly = await makeUser("Field Only", "associate", ["field"]); // Salesman App, no CRM at all
  twinA = await makeUser("Twin Name", "associate");
  twinB = await makeUser("Twin Name", "associate", ["field"]); // same name, a different account
  noAccess = await makeUser("Factory Only", "associate", []);
  fieldNoArea = await makeUser("Field No Area", "associate", ["field"]);
  fieldWrongArea = await makeUser("Field Wrong Area", "associate", ["field"]);
  // Leads here are in Pune. A handset person only sees what their area covers.
  for (const [u, city] of [[fieldOnly, "Pune"], [twinB, "Pune"], [fieldWrongArea, "Nagpur"]] as const) {
    await db.insert(mbosUserTerritories).values({ id: id("ter"), userId: u.id, kind: "city", region: city, parent: "" });
  }
  sameNameNoAccess = await makeUser("Seema Roy", "associate", []);
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
  test("every active CRM or Salesman App account, in name order, every one choosable", async () => {
    const choices = await ownerChoices();
    /* Name order within each group: everybody choosable first, then the ones who cannot be yet. */
    for (const group of [choices.filter((c) => c.canOwn), choices.filter((c) => !c.canOwn)]) {
      assert.deepEqual(group.map((c) => c.name), [...group.map((c) => c.name)].sort((x, y) => x.localeCompare(y)));
    }
    const byId = new Map(choices.map((c) => [c.id, c]));
    for (const u of [manager, ravi, seema, heena, plain, fieldOnly, twinA, twinB]) {
      assert.equal(byId.get(u.id)?.canOwn, true, `${u.name} must be choosable`);
    }
    assert.equal(byId.get(ravi.id)?.place, "desk");
    assert.equal(byId.get(heena.id)?.place, "crm", "CRM but no desk: in All Leads");
    assert.equal(byId.get(fieldOnly.id)?.place, "handset", "Salesman App only: on the handset");
    assert.equal(byId.has(gone.id), false, "an inactive account is not offered");
  });

  test("an active account with no CRM or Salesman App access is listed, flagged and not choosable", async () => {
    const choices = await ownerChoices();
    const c = choices.find((x) => x.id === noAccess.id);
    assert.ok(c, "listed, so the name is never simply missing");
    assert.equal(c.canOwn, false);
    assert.equal(c.place, "none");
    assert.match(c.blockedReason ?? "", /no CRM or Salesman App access/);
    const firstBlocked = choices.findIndex((x) => !x.canOwn);
    assert.ok(choices.slice(firstBlocked).every((x) => !x.canOwn), "blocked ones come after everybody choosable");
    assert.equal(choices.some((x) => x.id === gone.id), false, "an inactive account is still not listed");
  });

  test("a Salesman App person with NO area is listed but not choosable, and is refused with nothing written", async () => {
    const c = (await ownerChoices()).find((x) => x.id === fieldNoArea.id);
    assert.ok(c);
    assert.equal(c.canOwn, false);
    assert.match(c.blockedReason ?? "", /no area allocated/);
    const l = await lead();
    const r = await assignDeskLead({ customerId: l.id, ownerId: fieldNoArea.id });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /no area allocated/);
    assert.equal((await row(l.id)).ownerId, ravi.id);
    assert.equal(await count("audit_log", l.id), 0);
  });

  test("an area that does not cover the lead is refused: no invisible assignment", async () => {
    const l = await lead(); // Pune
    const r = await assignDeskLead({ customerId: l.id, ownerId: fieldWrongArea.id });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /does not cover this lead/);
    assert.equal((await row(l.id)).ownerId, ravi.id);

    const bulk = await bulkAssignDeskLeads({ leadIds: [l.id], ownerId: fieldWrongArea.id });
    assert.equal(bulk.ok && bulk.data.done, 0);
    assert.match(bulk.ok ? (bulk.data.failed[0]?.why ?? "") : "", /does not cover this lead/);

    const covered = await assignDeskLead({ customerId: l.id, ownerId: fieldOnly.id });
    assert.equal(covered.ok, true, covered.ok ? "" : covered.error);
    assert.equal((await row(l.id)).ownerId, fieldOnly.id, "an area that covers it is accepted");
  });

  test("handing a lead to somebody with no access is refused, says why, and writes nothing", async () => {
    const l = await lead();
    const r = await assignDeskLead({ customerId: l.id, ownerId: noAccess.id });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /no active CRM or Salesman App account/);
    assert.equal((await row(l.id)).ownerId, ravi.id);
    assert.equal(await count("audit_log", l.id), 0);
    const bulk = await bulkAssignDeskLeads({ leadIds: [l.id], ownerId: noAccess.id });
    assert.equal(bulk.ok, false);
    assert.equal((await row(l.id)).ownerId, ravi.id);
  });

  test("two Seema Roy accounts stay two entries, each tagged, and only the one with access is choosable", async () => {
    const both = (await ownerChoices()).filter((c) => c.id === seema.id || c.id === sameNameNoAccess.id);
    assert.equal(both.length, 2);
    assert.notEqual(both[0].disambiguator, both[1].disambiguator);
    assert.ok(both.every((c) => c.disambiguator));
    assert.equal(both.find((c) => c.id === seema.id)?.canOwn, true);
    assert.equal(both.find((c) => c.id === sameNameNoAccess.id)?.canOwn, false);
    const l = await lead();
    const r = await assignDeskLead({ customerId: l.id, ownerId: seema.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(l.id)).ownerId, seema.id, "the lead goes to the account picked, by id");
  });

  test("two accounts with one name are two entries, told apart by id", async () => {
    const twins = (await ownerChoices()).filter((c) => c.name === "Twin Name");
    assert.deepEqual(twins.map((c) => c.id).sort(), [twinA.id, twinB.id].sort());
  });

  test("a person on two apps is listed once", async () => {
    const both = await makeUser("Both Apps", "associate", ["crm", "field"]);
    const hits = (await ownerChoices()).filter((c) => c.id === both.id);
    assert.equal(hits.length, 1);
  });

  test("the old list is unchanged and is still what the server accepts", async () => {
    const holders = (await deskHolders()).map((p) => p.name);
    assert.deepEqual(holders.sort(), ["Mona Manager", "Plain Caller", "Ravi Telecaller", "Seema Roy", "Twin Name"]);
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

  test("somebody without the Calling desk is assigned, said so, with a trail and a bell", async () => {
    const l = await lead();
    const r = await assignDeskLead({ customerId: l.id, ownerId: heena.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.match(r.ok ? (r.message ?? "") : "", /does not hold the Calling desk/);
    assert.equal((await row(l.id)).ownerId, heena.id);
    assert.equal(await count("audit_log", l.id), 1);
    const told = await db.select().from(notifications).where(eq(notifications.userId, heena.id));
    assert.equal(told.length, 1);
    assert.equal(told[0].href, `/crm/leads/${l.id}`, "pointed at a screen they can open");
  });

  test("a Salesman App holder with no CRM login is assigned too, and told where it will be", async () => {
    const l = await lead();
    const r = await assignDeskLead({ customerId: l.id, ownerId: fieldOnly.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.match(r.ok ? (r.message ?? "") : "", /Salesman App handset/);
    assert.equal((await row(l.id)).ownerId, fieldOnly.id);
  });

  test("an account sharing a name gets the lead by id, not by name", async () => {
    const l = await lead();
    const r = await assignDeskLead({ customerId: l.id, ownerId: twinB.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(l.id)).ownerId, twinB.id);
    assert.notEqual((await row(l.id)).ownerId, twinA.id);
  });

  test("an inactive account, or an id that is nobody, is still refused and nothing moves", async () => {
    for (const ownerId of [gone.id, "usr_does_not_exist"]) {
      const l = await lead();
      const r = await assignDeskLead({ customerId: l.id, ownerId });
      assert.equal(r.ok, false);
      assert.match(!r.ok ? r.error : "", /no active CRM or Salesman App account/);
      assert.equal((await row(l.id)).ownerId, ravi.id);
      assert.equal(await count("audit_log", l.id), 0);
    }
  });

  test("a lead handed to a person with no desk is in THEIR All Leads, and not in a stranger's", async () => {
    const l = await lead();
    await assignDeskLead({ customerId: l.id, ownerId: heena.id });
    setTestUser(heena);
    const mine = await leadsPage("2026-10-12", { perPage: 200 });
    assert.ok(mine.rows.some((r) => r.id === l.id), "the new owner sees it");
    setTestUser(plain);
    const theirs = await leadsPage("2026-10-12", { perPage: 200 });
    assert.ok(!theirs.rows.some((r) => r.id === l.id), "another associate does not");
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

  test("in bulk, a person with no desk now receives them, and an unknown id is refused as a whole", async () => {
    const a = await lead();
    const b = await lead();
    const r = await bulkAssignDeskLeads({ leadIds: [a.id, b.id], ownerId: heena.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal(r.ok && r.data.done, 2);
    assert.equal((await row(a.id)).ownerId, heena.id);
    assert.equal((await row(b.id)).ownerId, heena.id);

    const c = await lead();
    const refused = await bulkAssignDeskLeads({ leadIds: [c.id], ownerId: "usr_does_not_exist" });
    assert.equal(refused.ok, false);
    assert.equal((await row(c.id)).ownerId, ravi.id);
  });

  test("an archived lead is not unassigned", async () => {
    const l = await lead({ leadArchived: true });
    const r = await assignDeskLead({ customerId: l.id, ownerId: null });
    assert.equal(r.ok, false);
    assert.equal((await row(l.id)).ownerId, ravi.id);
  });
});
