/**
 * The Lead Calling Desk's voice assistant, end to end — proving it rides the
 * EXISTING save/question architecture rather than building a second one.
 *
 * Runs against mahekone_test with the real action, the real service and the
 * real `logQualificationCall`. There is no OpenAI/Sarvam key in this
 * environment, so `analyseLeadCall` itself answers with `reading: null` (the
 * documented, handled "no model answered" case every assistant in this
 * codebase has) — which is exactly what proves the scope-check, the draft
 * write and the call-number/question-set computation all run BEFORE the
 * model is ever asked, and none of it depends on a provider being configured.
 *
 * What the voice layer would do with a real reading — propose a value, which
 * a human applies into the dialog's own `text`/`productId` state — is proven
 * instead by driving `logQualificationCall` directly with answers shaped
 * exactly as an applied proposal would be: this is the save path voice and a
 * human typing both go through, unchanged.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { appAccess, callAiDrafts, customers, products, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { logQualificationCall } from "@/lib/actions/lead-calling-desk";
import { analyseLeadCallAction } from "@/lib/actions/lead-call-intel";
import { questionsForCall } from "@/lib/engines/lead-calling-desk";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

let desk: typeof users.$inferSelect;
let other: typeof users.$inferSelect;
let productId: string;

async function makeUser(name: string, role: "associate" | "manager") {
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
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: "crm", role });
  return row;
}

async function makeLead(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ganesh",
      phone: String(9000000000 + Math.floor(Math.random() * 999999999)),
      city: "Nashik",
      kind: "lead",
      leadStage: "suspect",
      leadSalesType: "direct",
      leadSource: "Website / Online Enquiry",
      ownerId: desk.id,
      ...over,
    })
    .returning();
  return row;
}

const stageOf = async (leadId: string) =>
  (await db.select().from(customers).where(eq(customers.id, leadId)))[0];

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table call_ai_drafts, calls, notifications, timeline_events, audit_log,
      app_access, customers, products, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  desk = await makeUser("Desk Caller", "associate");
  other = await makeUser("Other Caller", "associate");
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
  setTestUser(desk);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

describe("analyseLeadCallAction — the door, not the writer", () => {
  test("writes one call_ai_drafts row with channel 'lead_call', and never a lead field or a call", async () => {
    const lead = await makeLead();
    const r = await analyseLeadCallAction({
      customerId: lead.id,
      spoken: "",
      english: "",
      typedNote: "He wants about 400 litres a month, currently buying from Asian Paints.",
      language: null,
      heardBy: "typed",
    });
    /* No provider key in this environment — the documented, handled "could
       not read" outcome, exactly like the call and visit assistants. */
    assert.equal(r.ok, false);

    const drafts = await db.select().from(callAiDrafts).where(eq(callAiDrafts.customerId, lead.id));
    assert.equal(drafts.length, 1, "the draft is written even when no model answers");
    assert.equal(drafts[0].channel, "lead_call");
    assert.equal(drafts[0].userId, desk.id);

    /* And nothing else moved — no call, no changed lead field. */
    const row = await stageOf(lead.id);
    assert.equal(row.leadStage, "suspect");
    assert.equal(row.leadMonthlyVolumeLitres, null);
  });

  test("refuses a lead outside the caller's scope before any reading happens", async () => {
    const lead = await makeLead({ ownerId: desk.id });
    setTestUser(other);
    const r = await analyseLeadCallAction({
      customerId: lead.id,
      spoken: "",
      english: "",
      typedNote: "Something said on the call.",
      language: null,
      heardBy: "typed",
    });
    assert.equal(r.ok, false);
    const drafts = await db.select().from(callAiDrafts).where(eq(callAiDrafts.customerId, lead.id));
    assert.equal(drafts.length, 0, "a refused, out-of-scope read writes nothing at all");
  });
});

describe("Call 1 → Call 2 → Call 3 continuity, through the unmodified save path", () => {
  test("values an AI proposal would have applied save and narrow the next call's questions exactly as a typed answer would", async () => {
    const lead = await makeLead();

    /* CALL 1 — what a telecaller's typing, OR a human pressing "Apply" on a
       voice proposal, both end up calling: the same `logQualificationCall`
       with the same shape of `answers`. The voice layer is never in this
       call stack at all. */
    const askNow1 = questionsForCall({}, 1).askNow.map((f) => f.key);
    assert.deepEqual(
      [...askNow1].sort(),
      ["application", "competitor", "customerType", "monthlyLitres", "requiredProductId"].sort(),
      "Call 1 asks exactly its own suggestCall-1 fields on a brand new lead",
    );
    const call1 = await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_collected",
      answers: { monthlyLitres: 400, requiredProductId: productId, competitor: "Asian Paints" },
    });
    assert.equal(call1.ok, true, call1.ok ? "" : call1.error);
    assert.equal(call1.ok && call1.data.result, "next");

    /* CALL 2 opens. `questionsForCall` is read fresh off what Call 1 saved —
       nothing about this read knows or cares that the values came from a
       voice proposal rather than typing. */
    const afterCall1 = await stageOf(lead.id);
    const valuesAfterCall1 = {
      customerType: afterCall1.customerType,
      decisionMaker: afterCall1.leadDecisionMaker,
      monthlyLitres: afterCall1.leadMonthlyVolumeLitres,
      potentialPaise: afterCall1.leadEstimatedPotentialPaise,
      requiredProductId: afterCall1.leadRequiredProductId,
      competitor: afterCall1.leadCompetitor,
      application: afterCall1.leadApplication,
    };
    const askNow2 = questionsForCall(valuesAfterCall1, 2).askNow.map((f) => f.key);
    assert.ok(!askNow2.includes("monthlyLitres"), "Call 1's answer is never re-asked on Call 2");
    assert.ok(!askNow2.includes("requiredProductId"));
    assert.ok(!askNow2.includes("competitor"));
    assert.ok(askNow2.includes("decisionMaker"), "Call 2's own question is still owed");
    assert.ok(askNow2.includes("potentialPaise"));

    const call2 = await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_collected",
      answers: { decisionMaker: "Suresh, the owner", potentialPaise: 6_000_000 },
    });
    assert.equal(call2.ok, true, call2.ok ? "" : call2.error);
    assert.equal(call2.ok && call2.data.result, "ready", "all five required answers are in after Call 2");

    /* CALL 3 is never owed here — `questionsForCall` on the final values has
       nothing required left, which is the same engine Call 3's own voice
       assistant would have been handed its question set from, had one been
       needed. */
    const afterCall2 = await stageOf(lead.id);
    assert.equal(afterCall2.leadDecisionMaker, "Suresh, the owner");
    assert.equal(afterCall2.leadEstimatedPotentialPaise, 6_000_000);
  });

  test("Call 3 forces every still-missing required field regardless of its own suggestCall", async () => {
    const lead = await makeLead();
    /* Two calls that between them leave only the required fields incomplete,
       exactly the state Call 3's voice assistant would be handed. */
    await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_callback",
      answers: { monthlyLitres: 150 },
    });
    await logQualificationCall({
      customerId: lead.id,
      outcome: "spoke_callback",
      answers: { competitor: "Local brand" },
    });
    const row = await stageOf(lead.id);
    const values = {
      monthlyLitres: row.leadMonthlyVolumeLitres,
      competitor: row.leadCompetitor,
    };
    const askNow3 = questionsForCall(values, 3).askNow.map((f) => f.key);
    /* `requiredProductId` and `decisionMaker` are required and still missing,
       and suggestCall 1 and 2 respectively — Call 3 asks for them anyway,
       because it is the last chance. This is exactly the set a Call 3 voice
       assistant must be built from, read live rather than hand-written. */
    assert.ok(askNow3.includes("requiredProductId"));
    assert.ok(askNow3.includes("decisionMaker"));
  });
});
