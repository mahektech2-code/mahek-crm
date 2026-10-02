/**
 * The Manager verification voice assistant, end to end — proving it is a door
 * that only READS, that it belongs to the CRM Sales Manager workspace, and that
 * the dialog's own save is still the only way a lead is verified.
 *
 * Runs against mahekone_test with the real action, the real service and the
 * real `verifyProspect`. There is no OpenAI/Sarvam key in this environment, so
 * `analyseVerifyCall` answers with the documented "no language model answered"
 * refusal — which is exactly what proves the capability, the workspace, the
 * module, the scope and the switch all run BEFORE the model is asked, and that
 * nothing is written to the lead whether a provider answers or not.
 */
import { after, before, beforeEach, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, callAiDrafts, customers, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { verifyProspect } from "@/lib/actions/sales-manager-pipeline";
import { analyseVerifyCallAction } from "@/lib/actions/verify-intel";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type Level = "associate" | "manager" | "admin";

let manager: typeof users.$inferSelect; // a CRM manager — holds lead.verify
let otherManager: typeof users.$inferSelect;
let associate: typeof users.$inferSelect; // a CRM associate — does not
let admin: typeof users.$inferSelect;
let salesman: typeof users.$inferSelect;
let productId: string;
let lead: typeof customers.$inferSelect; // a Prospect in `manager`'s book
let theirs: typeof customers.$inferSelect; // a Prospect in `otherManager`'s book

async function makeUser(name: string, level: Level) {
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
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role: level });
  if (level !== "admin") {
    await db.insert(appModuleAccess).values({ id: id("ama"), userId: row.id, app: "crm", module: "crm.sales-manager" });
  }
  return row;
}

async function makeProspect(over: Partial<typeof customers.$inferInsert>) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Prospect ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ramesh",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nashik",
      kind: "lead",
      customerType: "retailer",
      leadStage: "prospect",
      leadSalesType: "direct",
      leadSource: "manual",
      leadStageSince: "2026-09-23",
      leadLastActivityDate: "2026-09-23",
      leadMonthlyVolumeLitres: 400,
      leadEstimatedPotentialPaise: 5_000_000,
      leadCompetitor: "Local brand",
      leadRequiredProductId: productId,
      leadDecisionMaker: "Suresh",
      leadNextAction: "Manager verification call",
      leadNextActionDate: "2026-09-24",
      ...over,
    })
    .returning();
  return row;
}

const draftCount = async () => Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from call_ai_drafts`))[0].n);
const count = async (table: string) =>
  Number((await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))[0].n);
const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];

const call = (customerId: string) => ({
  customerId,
  english: "The shop says the salesman did visit, they use about 250 litres a month, ready for a trial",
});

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table call_ai_drafts, lead_verification_corrections, mbos_lead_validations, mbos_tasks,
      lead_stage_transitions, notifications, timeline_events, audit_log, app_module_access, app_access,
      customers, products, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  manager = await makeUser("Mgr One", "manager");
  otherManager = await makeUser("Mgr Two", "manager");
  associate = await makeUser("Assoc One", "associate");
  admin = await makeUser("Big Boss", "admin");
  salesman = await makeUser("Salesman One", "associate");
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "Nano Thinner - 20 Liter (Loose)" });
  lead = await makeProspect({ name: "Shree Paints", ownerId: salesman.id, salesManagerId: manager.id });
  theirs = await makeProspect({ name: "Their Paints", ownerId: salesman.id, salesManagerId: otherManager.id });
  setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE);
  setTestUser(manager);
});

afterEach(() => {
  setTestWorkspace(null);
});

after(async () => {
  setTestUser(null);
  setTestWorkspace(null);
  await db.$client.end();
});

describe("analyseVerifyCallAction — the door, not the writer", () => {
  test("it writes one audit draft and NOTHING to the lead: no verification, no correction, no move, no task", async () => {
    const before = await row(lead.id);
    const r = await analyseVerifyCallAction(call(lead.id));
    /* No provider key in the test environment: the documented refusal, after the
       capability, the workspace, the module, the scope and the switch passed. */
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no language model answered/);

    const drafts = await db.select().from(callAiDrafts);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].channel, "verify_call");
    assert.equal(drafts[0].customerId, lead.id);
    assert.equal(drafts[0].userId, manager.id);
    assert.deepEqual((drafts[0].analysis as { onFileAtReading: unknown }).onFileAtReading, {
      monthlyLitres: 400,
      potentialRupees: 50000,
      product: "Nano Thinner - 20 Liter (Loose)",
      competitor: "Local brand",
      contact: "Ramesh",
      decisionMaker: "Suresh",
    }, "the salesman's values as they stood are kept for the audit");

    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.leadVerifiedAt, null);
    assert.equal(after.leadVerifiedById, null);
    assert.equal(after.leadNextAction, before.leadNextAction);
    assert.equal(after.leadMonthlyVolumeLitres, 400);
    assert.equal(after.ownerId, salesman.id);
    assert.equal(after.salesManagerId, manager.id);
    assert.equal(await count("mbos_lead_validations"), 0);
    assert.equal(await count("lead_verification_corrections"), 0);
    assert.equal(await count("mbos_tasks"), 0);
    assert.equal(await count("lead_stage_transitions"), 0);
  });

  test("somebody without lead.verify is refused before anything is read — the permission model is untouched", async () => {
    setTestUser(associate);
    const r = await analyseVerifyCallAction(call(lead.id));
    assert.equal(r.ok, false);
    assert.equal(await draftCount(), 0);
  });

  test("outside the CRM Sales Manager workspace — the Sales Dashboard's pipeline — it is refused", async () => {
    setTestWorkspace(null);
    const r = await analyseVerifyCallAction(call(lead.id));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "not_permitted");
      assert.match(r.error, /CRM Sales Manager workspace/);
    }
    assert.equal(await draftCount(), 0);
  });

  test("somebody not granted the Sales Manager module is refused", async () => {
    await db.delete(appModuleAccess).where(eq(appModuleAccess.userId, manager.id));
    await db.insert(appModuleAccess).values({ id: id("ama"), userId: manager.id, app: "crm", module: "crm.leads" });
    const r = await analyseVerifyCallAction(call(lead.id));
    assert.equal(r.ok, false);
    assert.equal(await draftCount(), 0);
  });

  test("another Sales Manager's lead cannot be read from here, and nothing is written", async () => {
    const r = await analyseVerifyCallAction(call(theirs.id));
    assert.equal(r.ok, false);
    assert.equal(await draftCount(), 0);
    assert.equal((await row(theirs.id)).leadStage, "prospect");
  });

  test("an administrator reaches any lead's reading, and still writes only the draft", async () => {
    setTestUser(admin);
    const r = await analyseVerifyCallAction(call(theirs.id));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no language model answered/);
    assert.equal(await draftCount(), 1);
    assert.equal((await row(theirs.id)).leadVerifiedAt, null);
  });

  test("a lost lead has no verification call to record", async () => {
    const lost = await makeProspect({ salesManagerId: manager.id, ownerId: salesman.id, leadStage: "lost" });
    const r = await analyseVerifyCallAction(call(lost.id));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /closed/);
    assert.equal(await draftCount(), 0);
  });

  test("nothing to read is a question, not a model call", async () => {
    const r = await analyseVerifyCallAction({ customerId: lead.id, english: "", spoken: "", typedNote: "" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /nothing to read/i);
    assert.equal(await draftCount(), 0);
  });

  test("the switch turns it off, in the registry's own words", async () => {
    assert.equal((await updateSetting("verifyIntel.enabled", false, manager.id)).ok, true);
    const r = await analyseVerifyCallAction(call(lead.id));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /switched off/);
    assert.equal(await draftCount(), 0);
  });
});

describe("the existing save is the only way a lead is verified", () => {
  test("after the assistant has run, verifyProspect still verifies the lead exactly as before", async () => {
    await analyseVerifyCallAction(call(lead.id));
    const r = await verifyProspect({
      customerId: lead.id,
      outcome: "verified",
      answers: { visited: "Yes", explained: "Yes", genuine_interest: "Yes", ready_for_trial: "Yes" },
      corrections: [],
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadVerifiedById, manager.id, "the manager did, not the assistant");
    assert.equal(after.leadStage, "qualification");
  });

  test("a correction still needs its reason on the server, whatever the dialog sent", async () => {
    const r = await verifyProspect({
      customerId: lead.id,
      outcome: "verified",
      expectCorrections: true,
      answers: { visited: "Yes" },
      corrections: [{ field: "monthly_litres", original: "400 Litres", corrected: "250 Litres", reason: "" }],
    });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadVerifiedAt, null);
  });
});
