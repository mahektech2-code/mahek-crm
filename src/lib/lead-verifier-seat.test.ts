/**
 * SALES MANAGER VERIFICATION FOLLOWS `lead.sales_manager_id`.
 *
 *   1  an associate-level Sales Manager verifies a lead she raised herself, and
 *      Qualification opens exactly as it does for a manager;
 *   2  she cannot verify another Sales Manager's lead;
 *   3  a Salesman's handset lead is born under his org-chart Sales Manager, with
 *      no wait for the nightly pass, and that seat is not a "decision";
 *   4  that Sales Manager verifies it, and the Salesman never can;
 *   5  the verification queue holds her own pending leads and nobody else's;
 *   6  the manager-level path is unchanged.
 *
 * The creator never enters into it: a Salesman's lead and a Sales Manager's own
 * lead are verified by the same person, the one whose seat it is.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, employeeReporting, employees, mbosUserTerritories, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";
import { ingestSyncBatch } from "@/lib/actions/mbos";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { reviewLeadQualification } from "@/lib/actions/lead-qualification-review";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { verificationQueue } from "@/lib/services/lead-console-service";
import type { MbosPrincipal } from "@/lib/services/mbos-service";
import type { SyncItem } from "@/lib/mbos/types";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-10-05";
type Level = "associate" | "manager";

let seema: typeof users.$inferSelect; // Sales Manager, CRM ASSOCIATE + the module
let other: typeof users.$inferSelect; // another Sales Manager, same shape
let boss: typeof users.$inferSelect; // manager level, holds lead.verify
let salesman: typeof users.$inferSelect; // field app only
let productId: string;

async function makeUser(name: string, level: Level, apps: [string, Level][], modules: string[] = []) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: level,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  for (const [app, role] of apps) {
    await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: app as never, role });
  }
  for (const key of modules) {
    await db.insert(appModuleAccess).values({ id: id("ama"), userId: row.id, app: "crm", module: key });
  }
  return row;
}

const prospectFields = () => ({
  customerType: "retailer" as const,
  leadMonthlyVolumeLitres: 300,
  leadEstimatedPotentialPaise: 9_000_000,
  leadCompetitor: "Local thinner",
  leadRequiredProductId: productId,
  contactPerson: "Ganesh",
  leadDecisionMaker: "Owner",
});

const answers = { visited: "Yes", explained: "Yes", genuine_interest: "Yes", ready_for_trial: "Yes" };
const verify = (customerId: string) => verifyProspect({ customerId, outcome: "verified", answers, corrections: [] });
const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];

async function makeProspect(over: Partial<typeof customers.$inferInsert>) {
  const [r] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nashik",
      kind: "lead",
      leadStage: "prospect",
      leadSalesType: "direct",
      leadSource: "manual",
      leadStageSince: DAY,
      leadLastActivityDate: DAY,
      ...prospectFields(),
      ...over,
    })
    .returning();
  return r;
}

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run `npm run test:db` first.");
});
after(async () => {
  setTestUser(null);
  setTestWorkspace(null);
  await db.$client.end();
});
beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, lead_verification_corrections, mbos_lead_validations, mbos_tasks,
      notifications, timeline_events, audit_log, app_module_access, app_access, mbos_user_territories,
      employee_reporting, employees, customers, products, users, app_settings restart identity cascade`);
  invalidateConfig();
  await seedConfig();
  setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE);

  seema = await makeUser("Seema Roy", "associate", [["crm", "associate"]], ["crm.sales-manager"]);
  other = await makeUser("Other Manager", "associate", [["crm", "associate"]], ["crm.sales-manager"]);
  boss = await makeUser("Big Manager", "manager", [["crm", "manager"]], ["crm.sales-manager"]);
  salesman = await makeUser("Rakesh Field", "associate", [["field", "associate"]]);
  await db.insert(mbosUserTerritories).values({ id: id("ut"), userId: salesman.id, kind: "state", region: "Madhya Pradesh", parent: "" });
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
  setTestUser(seema);
});

describe("1: a Sales Manager verifies the lead she raised herself", () => {
  test("created at the desk, verified by the same person, Qualification opens", async () => {
    const made = await captureLead({
      salesType: "direct",
      name: "J P paints and hardware stores",
      phone: "9876501234",
      city: "Nashik",
      source: "telecalling",
    } as never);
    assert.ok(made.ok, made.ok ? "" : made.error);
    const leadId = made.data.customerId;
    assert.equal((await row(leadId)).salesManagerId, seema.id);

    /* The desk's own earlier steps are not what this pins; stand the lead at the
       Prospect rung with what the gate wants. */
    await db.update(customers).set({ leadStage: "prospect", ...prospectFields() }).where(eq(customers.id, leadId));

    const r = await verify(leadId);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(leadId);
    assert.equal(after.leadVerifiedById, seema.id);
    assert.equal(after.leadStage, "qualification", "Qualification opens as before");
  });
});

describe("2: another Sales Manager's lead is not hers to verify", () => {
  test("a different seat, same level and module", async () => {
    const theirs = await makeProspect({ salesManagerId: other.id, ownerId: salesman.id });
    const r = await verify(theirs.id);
    assert.equal(r.ok, false);
    assert.equal((await row(theirs.id)).leadStage, "prospect", "nothing moved");
    assert.equal((await row(theirs.id)).leadVerifiedAt, null);
  });

  test("the module alone grants nothing without the seat", async () => {
    const unseated = await makeProspect({ salesManagerId: null, ownerId: salesman.id });
    setTestWorkspace(null);
    const r = await verify(unseated.id);
    assert.equal(r.ok, false);
  });
});

describe("3 and 4: a Salesman's lead", () => {
  const principalFor = (user: typeof users.$inferSelect) =>
    ({ user, deviceId: "probe", role: "associate", scope: { kind: "own", userIds: [user.id] } }) as MbosPrincipal;

  const createItem = (): SyncItem => {
    const entityId = id("mbos");
    return {
      queueId: id("q"),
      entityType: "lead",
      entityId,
      op: "create",
      idempotencyKey: `${entityId}:create:${randomUUID()}`,
      clientCreatedAt: Date.now(),
      payload: { name: "Rakesh Paints", companyName: "Rakesh Paints", mobile: "9820011999", city: "Rewa", salesType: "direct", stage: "suspect" },
    };
  };

  async function orgChart() {
    const [mgr, rep] = await Promise.all(
      [seema.name, salesman.name].map(async (name, i) =>
        (
          await db
            .insert(employees)
            .values({ id: id("emp"), employeeCode: `V-${i}`, name, status: "active", rowNumber: 700 + i, raw: {}, rowHash: `v-${i}-${randomUUID()}` })
            .returning()
        )[0],
      ),
    );
    await db.insert(employeeReporting).values({ id: id("er"), employeeId: rep.id, managerId: mgr.id });
  }

  test("born under the org-chart Sales Manager, with no nightly pass and no decision mark", async () => {
    await orgChart();
    const item = createItem();
    const [result] = await ingestSyncBatch(principalFor(salesman), [item]);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    const lead = await row(item.entityId);
    assert.equal(lead.ownerId, salesman.id);
    assert.equal(lead.salesManagerId, seema.id, "the seat is filled at creation");
    assert.equal(lead.salesManagerDecidedAt, null, "a fill, so the nightly pass still owns it");
  });

  test("with no org chart the lead is born exactly as before", async () => {
    const item = createItem();
    const [result] = await ingestSyncBatch(principalFor(salesman), [item]);
    assert.equal(result.status, "accepted", JSON.stringify(result));
    assert.equal((await row(item.entityId)).salesManagerId, null);
  });

  test("that Sales Manager verifies it; the Salesman cannot", async () => {
    const lead = await makeProspect({ ownerId: salesman.id, salesManagerId: seema.id });

    setTestUser(salesman);
    setTestWorkspace(null);
    const refused = await verify(lead.id);
    assert.equal(refused.ok, false, "a Salesman never verifies");
    assert.equal((await row(lead.id)).leadStage, "prospect");

    setTestUser(seema);
    setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE);
    const ok = await verify(lead.id);
    assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });
});

describe("5: the verification queue", () => {
  test("holds her pending leads and nobody else's", async () => {
    const mine = await makeProspect({ ownerId: salesman.id, salesManagerId: seema.id });
    const theirs = await makeProspect({ ownerId: salesman.id, salesManagerId: other.id });
    const queue = await verificationQueue(DAY);
    const ids = queue.rows.map((r) => r.customerId);
    assert.ok(ids.includes(mine.id));
    assert.ok(!ids.includes(theirs.id));
  });
});

describe("6: the manager-level path is unchanged", () => {
  test("a manager verifies a lead under their own seat", async () => {
    const lead = await makeProspect({ ownerId: salesman.id, salesManagerId: boss.id });
    setTestUser(boss);
    const r = await verify(lead.id);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });
});

describe("7: the qualification review follows the same seat", () => {
  test("the seat holder may review; another Sales Manager may not", async () => {
    const lead = await makeProspect({ ownerId: salesman.id, salesManagerId: seema.id, leadStage: "qualification" });
    setTestUser(other);
    const refused = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" } as never);
    assert.equal(refused.ok, false);
    assert.equal((await row(lead.id)).leadQualificationReview, null);

    setTestUser(seema);
    const r = await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete", note: "Needs the figures." } as never);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).leadQualificationReview, "incomplete");
  });
});
