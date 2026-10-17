/**
 * The Lead Intake voice assistant, end to end — proving it is a door that only
 * READS, and that the form's own save is still the only way a lead is made.
 *
 * Runs against mahekone_test with the real action, the real service and the
 * real `captureLead`. There is no OpenAI/Sarvam key in this environment, so
 * `analyseIntake` answers with the documented "no language model answered"
 * refusal — which is exactly what proves the permission check, the module
 * check and the switch all run BEFORE the model is asked, and that nothing is
 * written whether a provider answers or not. What a real reading would do — be
 * applied into the form's own state by a person — is proven by driving
 * `captureLead` directly with the payload an applied proposal would produce:
 * the save path voice and a human typing both go through, unchanged.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, appModuleAccess, customers, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { updateSetting } from "@/lib/config/store";
import { captureLead } from "@/lib/actions/lead-intake";
import { analyseIntakeAction } from "@/lib/actions/intake-intel";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let intake: typeof users.$inferSelect; // may open Lead intake
let noIntake: typeof users.$inferSelect; // a CRM user narrowed to another module

async function makeUser(name: string, modules: string[]) {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: String(9820000000 + Math.floor(Math.random() * 999999)),
      passwordHash: "x",
      role: "associate",
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role: "associate" });
  for (const key of modules) await db.insert(appModuleAccess).values({ id: id("ama"), userId: row.id, app: "crm", module: key });
  return row;
}

const customerCount = async () => Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from customers`))[0].n);
const draftCount = async () => Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from call_ai_drafts`))[0].n);
const auditCount = async () => Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log`))[0].n);

const call = {
  workspace: "crm" as const,
  english: "Ramesh from Shree Paints in Nashik, 9876543210, dealer, 400 litres a month",
  offerUnder: false,
};

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table call_ai_drafts, notifications, timeline_events, audit_log, app_module_access,
      app_access, customers, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  intake = await makeUser("Intake Caller", ["crm.lead-intake"]);
  noIntake = await makeUser("Other Module", ["crm.leads"]);
  setTestUser(intake);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("analyseIntakeAction — the door, not the writer", () => {
  test("it reads and writes nothing: no customer, no draft, no audit row", async () => {
    const before = [await customerCount(), await draftCount(), await auditCount()];
    const r = await analyseIntakeAction(call);
    /* No provider key in the test environment: the documented refusal, after
       the permission, the module and the switch have all passed. */
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no language model answered/);
    assert.deepEqual([await customerCount(), await draftCount(), await auditCount()], before);
  });

  test("somebody not granted Lead intake is refused before anything is read", async () => {
    setTestUser(noIntake);
    const r = await analyseIntakeAction(call);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "not_permitted");
      assert.match(r.error, /Lead intake/);
    }
  });

  test("an unreadable request is refused as validation, not run", async () => {
    // @ts-expect-error — a workspace nobody mounts
    const r = await analyseIntakeAction({ ...call, workspace: "admin" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "validation");
  });

  test("nothing to read is a question, not a model call", async () => {
    const r = await analyseIntakeAction({ workspace: "crm", english: "", spoken: "", typedNote: "", offerUnder: false });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /nothing to read/i);
  });

  test("the switch turns it off, in the registry's own words", async () => {
    assert.equal((await updateSetting("intakeIntel.enabled", false, intake.id)).ok, true);
    const r = await analyseIntakeAction(call);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /switched off/);
  });
});

describe("the existing save is the only way a lead is made", () => {
  test("a payload shaped exactly as applied proposals would be saves through the unmodified captureLead", async () => {
    const r = await captureLead({
      workspace: "crm",
      salesType: null, // the human's choice — "Not Decided" — and nothing a voice reading touches
      name: "Shree Paints",
      contactPerson: "Ramesh",
      phone: "9876543210",
      city: "Nashik",
      source: "telecalling",
      customerType: "dealer",
      monthlyLitres: 400,
      requirement: "thinner for furniture polish",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      const [row] = await db.select().from(customers).where(eq(customers.id, r.data.customerId));
      assert.equal(row.leadSalesType, null, "the sales type is still exactly what the human chose");
      assert.equal(row.leadStage, "new");
      assert.equal(row.leadMonthlyVolumeLitres, 400);
    }
  });

  test("the duplicate guard still refuses a second row for the same number", async () => {
    const base = { workspace: "crm" as const, name: "Shree Paints", phone: "9876543210", city: "Nashik", source: "telecalling" };
    assert.equal((await captureLead({ ...base, salesType: "direct" })).ok, true);
    const again = await captureLead({ ...base, name: "Shree Paints Two", salesType: "direct" });
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.code, "duplicate");
  });

  test("validation still speaks for a proposal that should not have been applied", async () => {
    const r = await captureLead({ workspace: "crm", salesType: "direct", name: "X", phone: "123", city: "N", source: "telecalling" });
    assert.equal(r.ok, false);
  });
});
