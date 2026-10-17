/**
 * The Convert to Prospect voice assistant, end to end — proving it is a door
 * that only READS, that it belongs to the CRM Sales Manager workspace, that it
 * asks the capability the save asks, and that `convertProspect` is still the
 * only thing that writes the converted values.
 *
 * Runs against mahekone_test with the real action, the real service and the
 * real `convertProspect`. There is no OpenAI/Sarvam key in this environment, so
 * `analyseConvertCall` answers with the documented "no language model answered"
 * refusal — which proves the capability, the workspace, the module, the scope,
 * the stage and the switch all run BEFORE the model is asked, and that nothing
 * is written to the lead whether a provider answers or not.
 */
import { after, before, beforeEach, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, callAiDrafts, customers, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig, updateSetting } from "@/lib/config/store";
import { convertProspect } from "@/lib/actions/sales-manager-pipeline";
import { analyseConvertCallAction } from "@/lib/actions/convert-intel";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
type Level = "associate" | "manager" | "admin";

let manager: typeof users.$inferSelect;
let otherManager: typeof users.$inferSelect;
let associate: typeof users.$inferSelect; // a CRM associate with the Sales Manager module — holds lead.work
let noModule: typeof users.$inferSelect; // a CRM associate narrowed to another module
let ledger: typeof users.$inferSelect; // an Accounts associate — holds no lead.work
let admin: typeof users.$inferSelect;
let salesman: typeof users.$inferSelect;
let productId: string;
let lead: typeof customers.$inferSelect; // a Suspect in `manager`'s and `associate`'s book
let theirs: typeof customers.$inferSelect; // a Suspect in `otherManager`'s book

async function makeUser(
  name: string,
  level: Level,
  app: "crm" | "accounts" = "crm",
  modules: string[] = level === "admin" || app !== "crm" ? [] : ["crm.sales-manager"],
) {
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
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role: level });
  for (const key of modules) await db.insert(appModuleAccess).values({ id: id("ama"), userId: row.id, app: "crm", module: key });
  return row;
}

async function makeSuspect(over: Partial<typeof customers.$inferInsert>) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Suspect ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ramesh",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nashik",
      kind: "lead",
      customerType: "retailer",
      leadStage: "suspect",
      leadSalesType: "direct",
      leadSource: "manual",
      leadStageSince: "2026-09-23",
      leadLastActivityDate: "2026-09-23",
      leadMonthlyVolumeLitres: 400,
      leadEstimatedPotentialPaise: 5_000_000,
      leadCompetitor: "Local brand",
      leadRequiredProductId: productId,
      leadDecisionMaker: "Suresh",
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
  english: "He is a dealer, uses about 250 litres a month, buys from Asian Paints, ask for Mahesh",
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
  noModule = await makeUser("Assoc Two", "associate", "crm", ["crm.leads"]);
  ledger = await makeUser("Ledger One", "associate", "accounts");
  admin = await makeUser("Big Boss", "admin");
  salesman = await makeUser("Salesman One", "associate");
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "Nano Thinner - 20 Liter (Loose)" });
  lead = await makeSuspect({ name: "Shree Paints", ownerId: salesman.id, salesManagerId: manager.id });
  theirs = await makeSuspect({ name: "Their Paints", ownerId: salesman.id, salesManagerId: otherManager.id });
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

describe("analyseConvertCallAction — the door, not the writer", () => {
  test("it writes one audit draft and NOTHING to the lead: no field, no stage, no next action, no transition", async () => {
    const before = await row(lead.id);
    const r = await analyseConvertCallAction(call(lead.id));
    /* No provider key in the test environment: the documented refusal, after the
       capability, the workspace, the module, the scope and the stage passed. */
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no language model answered/);

    const drafts = await db.select().from(callAiDrafts);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].channel, "convert_call");
    assert.equal(drafts[0].customerId, lead.id);
    assert.equal(drafts[0].userId, manager.id);
    assert.deepEqual((drafts[0].analysis as { onFileAtReading: unknown }).onFileAtReading, {
      customerType: "retailer",
      productId,
      productName: "Nano Thinner - 20 Liter (Loose)",
      monthlyLitres: 400,
      potentialRupees: 50000,
      competitor: "Local brand",
      contact: "Ramesh",
      decisionMaker: "Suresh",
    }, "the salesman's values as they stood are kept — convertProspect keeps none");

    const after = await row(lead.id);
    for (const column of [
      "leadStage", "customerType", "leadMonthlyVolumeLitres", "leadEstimatedPotentialPaise", "leadCompetitor",
      "leadRequiredProductId", "contactPerson", "leadDecisionMaker", "leadNextAction", "leadNextActionDate",
      "ownerId", "salesManagerId", "leadSalesType",
    ] as const) {
      assert.equal(after[column], before[column], column);
    }
    assert.equal(await count("lead_stage_transitions"), 0);
    assert.equal(await count("mbos_tasks"), 0);
    assert.equal(await count("mbos_lead_validations"), 0);
  });

  test("a CRM associate who holds lead.work and the module can use it — Convert is not a manager-only step", async () => {
    await db.update(customers).set({ salesManagerId: associate.id }).where(eq(customers.id, lead.id));
    setTestUser(associate);
    const r = await analyseConvertCallAction(call(lead.id));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no language model answered/, "it got as far as the model");
    assert.equal(await draftCount(), 1);
  });

  test("somebody without lead.work is refused before anything is read — the permission model is untouched", async () => {
    setTestUser(ledger);
    const r = await analyseConvertCallAction(call(lead.id));
    assert.equal(r.ok, false);
    assert.equal(await draftCount(), 0);
  });

  test("outside the CRM Sales Manager workspace — the Sales Dashboard's pipeline — it is refused", async () => {
    setTestWorkspace(null);
    const r = await analyseConvertCallAction(call(lead.id));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "not_permitted");
      assert.match(r.error, /CRM Sales Manager workspace/);
    }
    assert.equal(await draftCount(), 0);
  });

  test("seeing the dialog is not enough: somebody not granted the Sales Manager module is refused", async () => {
    setTestUser(noModule);
    const r = await analyseConvertCallAction(call(lead.id));
    assert.equal(r.ok, false);
    assert.equal(await draftCount(), 0);
  });

  test("another Sales Manager's lead cannot be read from here, and nothing is written", async () => {
    const r = await analyseConvertCallAction(call(theirs.id));
    assert.equal(r.ok, false);
    assert.equal(await draftCount(), 0);
    assert.equal((await row(theirs.id)).leadStage, "suspect");
  });

  test("an administrator reaches any lead's reading, and still writes only the draft", async () => {
    setTestUser(admin);
    const r = await analyseConvertCallAction(call(theirs.id));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no language model answered/);
    assert.equal(await draftCount(), 1);
    assert.equal((await row(theirs.id)).leadStage, "suspect");
  });

  test("only a Suspect is converted: a Prospect or a closed lead has nothing for this assistant to fill", async () => {
    for (const stage of ["prospect", "lost"] as const) {
      const other = await makeSuspect({ salesManagerId: manager.id, ownerId: salesman.id, leadStage: stage });
      const r = await analyseConvertCallAction(call(other.id));
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /Only a Suspect/);
    }
    assert.equal(await draftCount(), 0);
  });

  test("nothing to read is a question, not a model call", async () => {
    const r = await analyseConvertCallAction({ customerId: lead.id, english: "", spoken: "", typedNote: "" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /nothing to read/i);
    assert.equal(await draftCount(), 0);
  });

  test("the switch turns it off, in the registry's own words", async () => {
    assert.equal((await updateSetting("convertIntel.enabled", false, manager.id)).ok, true);
    const r = await analyseConvertCallAction(call(lead.id));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /switched off/);
    assert.equal(await draftCount(), 0);
  });
});

describe("convertProspect is still the only writer", () => {
  test("after the assistant has run, converting with a correction writes exactly what the manager sent — and the old value survives only in the audit draft", async () => {
    await analyseConvertCallAction(call(lead.id));
    assert.equal((await row(lead.id)).leadMonthlyVolumeLitres, 400, "reading changed nothing");

    const r = await convertProspect({
      customerId: lead.id,
      reasonCode: "regular_requirement",
      fields: { monthlyLitres: 250 },
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.leadMonthlyVolumeLitres, 250, "the manager's explicit correction");
    assert.equal(after.leadCompetitor, "Local brand", "a fact nobody corrected is exactly as the salesman left it");
    assert.equal(after.contactPerson, "Ramesh");

    const [draft] = await db.select().from(callAiDrafts);
    assert.equal((draft.analysis as { onFileAtReading: { monthlyLitres: number } }).onFileAtReading.monthlyLitres, 400);
  });

  test("converting without any correction leaves every salesman value untouched", async () => {
    await analyseConvertCallAction(call(lead.id));
    const r = await convertProspect({ customerId: lead.id, reasonCode: "regular_requirement", fields: {} });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.leadMonthlyVolumeLitres, 400);
    assert.equal(after.leadCompetitor, "Local brand");
    assert.equal(after.leadRequiredProductId, productId);
  });

  test("the conversion reason is still required and still validated by the server", async () => {
    await analyseConvertCallAction(call(lead.id));
    const r = await convertProspect({ customerId: lead.id, reasonCode: "made_up_reason", fields: {} });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "suspect");
  });
});
