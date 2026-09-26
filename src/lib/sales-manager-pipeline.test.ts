/**
 * The Sales Manager lead pipeline, end to end: reads that are counted in SQL,
 * writes that persist, and authorisation that is the existing model and nothing
 * new.
 *
 * Runs against mahekone_test with the REAL services and the REAL actions — the
 * scope narrowing, the capability checks, the gate engine, the audit log and the
 * timeline are all the real thing, because this feature adds no rule of its own
 * and the way to prove that is to drive the ones that exist.
 *
 * What is pinned, in the order the brief asked for it:
 *
 *   R  the reads: the dashboard's figures are the SAME figures the lead tiles
 *      count, the list is one page of a book and never the whole of it, search
 *      and stage narrow in the database, and a lead outside a manager's
 *      territory is not there to open;
 *   M  every mutation persists, and what the screen is told afterwards is what
 *      the database holds — convert, verify (and its four outcomes, and the
 *      calling desk's request), the qualification checklist and its review, the
 *      whole sample journey, the commitment and the first order, lost, reassign,
 *      next action, communications;
 *   D  the distributor track, through the appointment chain that already exists;
 *   A  authorisation: who can open the module, who may verify or approve, and
 *      the one place read scope and write scope disagree — reported here as a
 *      test rather than fixed, because the brief forbids changing either.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  customers,
  distributorProfiles,
  leadStageTransitions,
  leadVerificationCorrections,
  mbosApprovals,
  mbosDocuments,
  mbosSamples,
  mbosUserTerritories,
  orders,
  products,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import {
  advanceLeadStage,
  askForFirstOrder,
  confirmFirstOrder,
  recordCommunication,
  saveLeadQualification,
  saveProspectFields,
  setLeadNextAction,
} from "@/lib/actions/leads";
import { reviewLeadQualification } from "@/lib/actions/lead-qualification-review";
import { decideSample, dispatchSample, requestSample } from "@/lib/actions/lead-samples";
import {
  agreeCommercialTerms,
  decideDistributorAppointment,
  recordDistributorAgreement,
  submitForManagementReview,
} from "@/lib/actions/distributor-appointment";
import { reassignLead } from "@/lib/actions/sales";
import {
  convertProspect,
  markLeadLost,
  receiveSampleForLead,
  requestSampleForLead,
  reviewSampleForLead,
  verifyProspect,
} from "@/lib/actions/sales-manager-pipeline";
import {
  pipelineDashboard,
  pipelineFunnel,
  pipelineLead,
  pipelineList,
  pipelineRefs,
} from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";
import { leadTileCounts } from "@/lib/services/lead-views-service";
import { VERIFICATION_FAILED_CODE } from "@/lib/lead-labels";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const DAY = "2026-09-24";
const YESTERDAY = "2026-09-23";
const NEXT_WEEK = "2026-10-01";
/** Inside the seven days `commitments` calls "due this week". */
const SOON = "2026-09-28";

let manager: typeof users.$inferSelect;
let salesA: typeof users.$inferSelect;
let salesB: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;
let boss: typeof users.$inferSelect;
let productId: string;

async function makeUser(
  name: string,
  role: "associate" | "manager" | "admin",
  apps: { app: "sales" | "crm" | "field" | "admin"; role: "associate" | "manager" | "admin" }[],
  reportsToId: string | null = null,
) {
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
      reportsToId,
    })
    .returning();
  for (const a of apps) await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app: a.app, role: a.role });
  return row;
}

/** A lead with the eight Prospect answers already in, so a move is decided by the gate and not by an empty form. */
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
      leadSource: "manual",
      ownerId: salesA.id,
      leadManagerId: manager.id,
      leadStageSince: YESTERDAY,
      leadLastActivityDate: YESTERDAY,
      ...over,
    })
    .returning();
  return row;
}

const fullProspectFields = () => ({
  customerType: "retailer" as const,
  leadMonthlyVolumeLitres: 300,
  leadEstimatedPotentialPaise: 9_000_000,
  leadCompetitor: "Local thinner",
  leadRequiredProductId: productId,
  contactPerson: "Ganesh",
  leadDecisionMaker: "Owner",
});

/** A lead that has passed verification and answered everything the SAMPLE gate reads, sitting at Qualification. */
async function qualifiedLead(over: Partial<typeof customers.$inferInsert> = {}) {
  return makeLead({
    leadStage: "qualification",
    ...fullProspectFields(),
    leadVerifiedAt: new Date(),
    leadVerifiedById: manager.id,
    leadNextAction: "Go back with the price list",
    leadNextActionDate: NEXT_WEEK,
    leadNextActionOwnerId: manager.id,
    gstin: "27ABCDE1234F1Z5",
    gstVerified: true,
    leadApplication: "Wood polish",
    leadCreditDaysWanted: 30,
    leadBuyer: "Ganesh's brother",
    leadFiguresConfirmedAt: new Date(),
    leadQualification: { price_discussed: true, delivery_discussed: true, agrees_to_test: true, next_step_agreed: true },
    ...over,
  });
}

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];

before(async () => {
  assert.match(
    process.env.DATABASE_URL ?? "",
    /mahekone_test/,
    "Integration tests must run against mahekone_test. Run `npm run test:db` first.",
  );
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, lead_verification_corrections, mbos_lead_validations, mbos_tasks,
      mbos_samples, sample_feedback, mbos_approvals, mbos_documents, distributor_profiles, orders, bills,
      calls, notifications, timeline_events, audit_log, app_module_access, app_access, mbos_user_territories,
      customers, products, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();

  manager = await makeUser("Sales Manager", "manager", [
    { app: "sales", role: "manager" },
    { app: "crm", role: "manager" },
  ]);
  salesA = await makeUser("Salesman A", "associate", [{ app: "field", role: "associate" }], manager.id);
  salesB = await makeUser("Salesman B", "associate", [{ app: "field", role: "associate" }], manager.id);
  telecaller = await makeUser("Tele Caller", "associate", [{ app: "crm", role: "associate" }]);
  boss = await makeUser("Big Boss", "admin", [
    { app: "sales", role: "admin" },
    { app: "admin", role: "admin" },
  ]);
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

/* ══════════════════════════════════════════════════════════════════ reads */

describe("R — the reads are counted in the database", () => {
  test("the dashboard's figures are the lead tiles' figures, and the manager strip is real", async () => {
    await makeLead({ leadStage: "suspect" });
    await makeLead({ leadStage: "suspect" });
    await makeLead({ leadStage: "prospect", ...fullProspectFields() }); // waiting on verification
    await makeLead({ leadStage: "prospect", ...fullProspectFields(), leadVerifiedAt: new Date() }); // verified
    await makeLead({ leadStage: "sample_trial", ...fullProspectFields() });
    await makeLead({
      leadStage: "negotiation",
      ...fullProspectFields(),
      leadExpectedOrderDate: SOON,
      leadExpectedOrderCans: 40,
    });
    await makeLead({
      leadStage: "lost",
      leadLostReason: VERIFICATION_FAILED_CODE,
      leadStageSince: YESTERDAY,
    });
    await makeLead({
      leadStage: "suspect",
      leadNextAction: "Ring back",
      leadNextActionDate: YESTERDAY,
      leadNextActionOwnerId: manager.id,
    });

    const d = await pipelineDashboard(DAY);
    const tiles = await leadTileCounts(DAY);

    for (const key of ["mine", "today", "overdue", "suspects", "prospects", "sample", "negotiation", "expected", "lost30"] as const) {
      assert.equal(d.book[key], tiles[key], `tile ${key} is the same number the lead tiles count`);
    }
    assert.equal(d.book.suspects, 3);
    assert.equal(d.book.prospects, 2);
    assert.equal(d.book.overdue, 1);
    assert.equal(d.book.lost30, 1);

    assert.equal(d.manager.pendingVerification, 1, "only the unverified prospect waits on a call");
    assert.equal(d.manager.verifiedProspects, 1);
    assert.equal(d.manager.verificationFailed, 1, "the persisted verification_failed closure, not a flag");
    assert.equal(d.manager.negotiationsPending, 1);
    assert.equal(d.manager.awaitingActualOrder, 1, "a promise with no order is still a forecast");
    assert.equal(d.manager.expectedThisWeek, 1);

    assert.equal(d.attention.length, 1);
    assert.equal(d.attention[0].nextAction, "Ring back");
    assert.equal(d.attention[0].nextActionResp, "Sales Manager");
    assert.match(d.greeting, /^Good (morning|afternoon|evening), Sales$/);
    assert.ok(d.funnel.length > 0 && d.funnel.every((f) => typeof f.count === "number"));
  });

  test("the funnel folds a legacy lead onto the rung its stage stands for", async () => {
    await makeLead({ leadStage: "new", leadSalesType: null });
    await makeLead({ leadStage: "suspect" });
    const f = await pipelineFunnel(DAY);
    const suspects = f.direct.find((b) => b.stage === "suspect");
    assert.equal(suspects?.count, 2, "New (legacy) and Suspect are one bar, matching the tile beside it");
  });

  test("the list is ONE PAGE of the book, counted in SQL — never the whole of it", async () => {
    for (let i = 0; i < 60; i++) {
      await makeLead({ name: `Bulk ${String(i).padStart(2, "0")}`, leadStage: i % 2 ? "suspect" : "prospect" });
    }
    const p1 = await pipelineList(DAY, { page: 1, perPage: 25 });
    assert.equal(p1.rows.length, 25);
    assert.equal(p1.total, 60);
    assert.equal(p1.pageCount, 3);
    const p3 = await pipelineList(DAY, { page: 3, perPage: 25 });
    assert.equal(p3.rows.length, 10);
    const ids = new Set([...p1.rows, ...(await pipelineList(DAY, { page: 2, perPage: 25 })).rows, ...p3.rows].map((r) => r.id));
    assert.equal(ids.size, 60, "no lead is on two pages and none on none");

    const beyond = await pipelineList(DAY, { page: 99, perPage: 25 });
    assert.equal(beyond.page, 3, "a hand-typed page is clamped, not an empty screen");
  });

  test("search and stage narrow in the database, and an unmatched search says so", async () => {
    await makeLead({ name: "Zeta Paints", city: "Pune", leadStage: "prospect" });
    await makeLead({ name: "Alpha Hardware", city: "Nashik", leadStage: "suspect" });
    const byName = await pipelineList(DAY, { q: "zeta" });
    assert.deepEqual(byName.rows.map((r) => r.name), ["Zeta Paints"]);
    assert.equal(byName.listTotal, 2, "the whole book is still said, so a filter that empties the table says what it emptied");
    const byStage = await pipelineList(DAY, { stage: "suspect" });
    assert.deepEqual(byStage.rows.map((r) => r.name), ["Alpha Hardware"]);
    const none = await pipelineList(DAY, { q: "no such shop" });
    assert.equal(none.rows.length, 0);
    assert.equal(none.total, 0);
  });

  test("the overdue view is the overdue tile's list", async () => {
    await makeLead({ name: "Late One", leadNextAction: "Ring", leadNextActionDate: YESTERDAY, leadNextActionOwnerId: manager.id });
    await makeLead({ name: "On Time", leadNextAction: "Ring", leadNextActionDate: NEXT_WEEK, leadNextActionOwnerId: manager.id });
    const list = await pipelineList(DAY, { view: "overdue" });
    assert.deepEqual(list.rows.map((r) => r.name), ["Late One"]);
    assert.equal(list.total, list.book.overdue);
    /* the prototype's own URL is a view under another name */
    assert.equal((await pipelineList(DAY, { due: "overdue" })).total, 1);
  });

  test("a lost lead is a Lost row with no rung, and a legacy lead says 'not set' rather than guessing", async () => {
    await makeLead({ name: "Gone", leadStage: "lost", leadLostReason: "price" });
    await makeLead({ name: "Old", leadStage: "contacted", leadSalesType: null });
    const rows = (await pipelineList(DAY, {})).rows;
    const gone = rows.find((r) => r.name === "Gone")!;
    assert.equal(gone.lost, true);
    assert.equal(gone.stage, null);
    const old = rows.find((r) => r.name === "Old")!;
    assert.equal(old.salesType, null);
    assert.equal(old.lost, false);
  });

  test("the record: real fields, a real gate, real capabilities — and a missing id is not found", async () => {
    const lead = await qualifiedLead();
    const found = await pipelineLead(lead.id, DAY);
    assert.ok(found);
    const l = found.lead;
    assert.equal(l.id, lead.id);
    assert.equal(l.owner, "Salesman A");
    assert.equal(l.ownerId, salesA.id);
    assert.equal(l.manager, "Sales Manager");
    assert.equal(l.product, "PU Thinner - 20 Liter (Loose)");
    assert.equal(l.customerType, "retailer");
    assert.equal(l.stage, "qualification");
    assert.equal(l.gate.kind, "requestSample", "every sample condition is met, so the engine's own verdict opens it");
    assert.equal(l.caps.canVerify, true);
    assert.equal(l.caps.canApproveSample, true);
    assert.equal(l.qualItems.length, 8);
    assert.ok(l.qualItems.every((q) => q.done), "the checklist is the engine's — and it agrees with the gate");
    assert.deepEqual(l.orders, []);

    assert.equal(await pipelineLead(id("cus"), DAY), null, "an id that is not a lead is not found");
  });

  test("a checklist that is short says which conditions, from the engine, and draws the checklist button", async () => {
    const lead = await qualifiedLead({ leadQualification: { price_discussed: true }, gstVerified: false });
    const l = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(l.gate.kind, "qualify");
    assert.ok(l.qualItems.some((q) => !q.done));
    const gst = l.qualItems.find((q) => q.id === "gst_verified")!;
    assert.equal(gst.tickable, false, "a value on the record is never a box to tick");
    assert.equal(l.qualItems.find((q) => q.id === "price_discussed")!.tickable, true);
  });

  test("a regional manager cannot open a lead outside the patch, and the list does not draw it", async () => {
    const north = await makeUser("North Man", "associate", [{ app: "field", role: "associate" }], manager.id);
    const south = await makeUser("South Man", "associate", [{ app: "field", role: "associate" }], manager.id);
    const inRegion = await makeLead({ name: "In Gujarat", ownerId: north.id, territoryRegion: "Gujarat" });
    await db.update(customers).set({ salesAmId: north.id }).where(eq(customers.id, inRegion.id));
    const outside = await makeLead({ name: "In Kerala", ownerId: south.id, territoryRegion: "Kerala" });
    await db.update(customers).set({ salesAmId: south.id }).where(eq(customers.id, outside.id));

    const regional = await makeUser("Regional Man", "manager", [{ app: "sales", role: "manager" }]);
    await db.insert(mbosUserTerritories).values({ id: id("ter"), userId: regional.id, kind: "region", region: "Gujarat" });
    setTestUser(regional);

    assert.equal(await pipelineLead(outside.id, DAY), null);
    assert.ok(await pipelineLead(inRegion.id, DAY));
    const names = (await pipelineList(DAY, {})).rows.map((r) => r.name);
    assert.ok(names.includes("In Gujarat"));
    assert.ok(!names.includes("In Kerala"));
  });

  test("the reference lists are configuration and real users, not typed into a screen", async () => {
    const refs = await pipelineRefs();
    assert.ok(refs.lostReasons.length > 0);
    assert.ok(refs.failureReasons.length > 0);
    assert.ok(refs.sampleReasons.length > 0);
    assert.deepEqual(refs.salesmen.map((s) => s.name).sort(), ["Salesman A", "Salesman B"]);
    assert.equal(refs.me.id, manager.id);
    assert.ok(!refs.salesmen.some((s) => s.id === telecaller.id), "only people who hold the Salesman App can be given a lead");
  });
});

/* ═══════════════════════════════════════════════════════════════ mutations */

describe("M — every mutation persists, and the screen is told what the database holds", () => {
  test("convert: saves the answers, moves the rung, and sets the verification call as the next action", async () => {
    const lead = await makeLead({ leadStage: "suspect" });
    const r = await convertProspect({
      customerId: lead.id,
      reasonCode: "regular_requirement",
      fields: {
        customerType: "retailer",
        monthlyLitres: 300,
        potentialPaise: 9_000_000,
        competitor: "Local thinner",
        requiredProductId: productId,
      },
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect");
    assert.equal(after.customerType, "retailer");
    assert.equal(after.leadMonthlyVolumeLitres, 300);
    assert.equal(after.leadNextAction, "Manager verification call");
    assert.equal(after.leadNextActionOwnerId, manager.id);

    const moves = await db.select().from(leadStageTransitions).where(eq(leadStageTransitions.customerId, lead.id));
    assert.equal(moves.length, 1);
    assert.equal(moves[0].toStage, "prospect");
    assert.equal(moves[0].reasonCode, "regular_requirement");

    const rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.stage, "prospect");
    assert.equal(rec.gate.kind, "verify", "the record reads the same database and offers the next step");
  });

  test("convert refuses with the gate's own words, and the answers already typed are kept", async () => {
    const lead = await makeLead({ leadStage: "suspect" });
    const r = await convertProspect({
      customerId: lead.id,
      reasonCode: "regular_requirement",
      fields: { monthlyLitres: 120 }, // no customer type, no potential, no product ...
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /saved, but the move to Prospect was refused/i);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "suspect", "a refused move does not move the rung");
    assert.equal(after.leadMonthlyVolumeLitres, 120, "the figures somebody typed are real and are kept");
  });

  test("convert with an unknown reason is refused by the configured list, not by a literal", async () => {
    const lead = await makeLead({ leadStage: "suspect", ...fullProspectFields() });
    const r = await convertProspect({ customerId: lead.id, reasonCode: "made_up_reason", fields: {} });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "suspect");
  });

  test("verify (verified): stores the call, opens Qualification", async () => {
    const lead = await makeLead({
      leadStage: "prospect",
      ...fullProspectFields(),
      leadNextAction: "Manager verification call",
      leadNextActionDate: DAY,
      leadNextActionOwnerId: manager.id,
    });
    await db.insert(leadStageTransitions).values({
      id: id("lst"),
      customerId: lead.id,
      fromStage: "suspect",
      toStage: "prospect",
      kind: "passed",
      reasonCode: "regular_requirement",
    });
    const r = await verifyProspect({
      customerId: lead.id,
      outcome: "verified",
      answers: { visited: "Yes", explained: "Yes", genuine_interest: "Yes", ready_for_trial: "Yes" },
      corrections: [],
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(lead.id);
    assert.ok(after.leadVerifiedAt, "the verification is a stored fact");
    assert.equal(after.leadVerifiedById, manager.id);
    assert.equal(after.leadStage, "qualification");

    const rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.verification.done, true);
    assert.equal(rec.verification.result, "verified");
    assert.equal(rec.verification.visitedConfirmed, true);
    assert.equal(rec.verification.readyForTrial, true);
    assert.equal(rec.verification.by, "Sales Manager");
  });

  test("verified with corrections: a real correction row, the lead's own value untouched, and the label derived", async () => {
    const lead = await makeLead({ leadStage: "prospect", ...fullProspectFields() });
    const r = await verifyProspect({
      customerId: lead.id,
      outcome: "verified",
      expectCorrections: true,
      answers: { visited: "Yes", explained: "Yes" },
      corrections: [{ field: "competitor", original: "Local thinner", corrected: "Asian Paints", reason: "Shop said so on the phone" }],
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const rows = await db.select().from(leadVerificationCorrections).where(eq(leadVerificationCorrections.customerId, lead.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].field, "competitor");
    assert.equal(rows[0].verdict, "corrected");
    assert.equal((await row(lead.id)).leadCompetitor, "Local thinner", "the salesman's answer stays beside the shop's");

    const rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.verification.result, "verified_with_corrections");
    assert.equal(rec.verificationCorrections?.[0].corrected, "Asian Paints");
  });

  test("'verified with corrections' with nothing corrected is refused before anything is written", async () => {
    const lead = await makeLead({ leadStage: "prospect", ...fullProspectFields() });
    const r = await verifyProspect({ customerId: lead.id, outcome: "verified", expectCorrections: true, answers: {}, corrections: [] });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadVerifiedAt, null);
  });

  test("verify (follow-up) needs a sentence, closes nothing, and lands a task on the salesman", async () => {
    const lead = await makeLead({ leadStage: "prospect", ...fullProspectFields() });
    const bare = await verifyProspect({ customerId: lead.id, outcome: "follow_up", answers: {}, corrections: [] });
    assert.equal(bare.ok, false);

    const ok = await verifyProspect({
      customerId: lead.id,
      outcome: "follow_up",
      answers: {},
      corrections: [],
      followUpNote: "The owner was away — call again after lunch.",
    });
    assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
    const after = await row(lead.id);
    assert.equal(after.leadStage, "prospect", "a follow-up closes nothing");
    assert.equal(after.leadVerifiedAt, null);
    const rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.verification.result, "followup_required");
  });

  test("verify (failed): closes the lead as lost with the fixed reason, and the dashboard counts it", async () => {
    const lead = await makeLead({ leadStage: "prospect", ...fullProspectFields() });
    const refs = await pipelineRefs();

    const noFinding = await verifyProspect({ customerId: lead.id, outcome: "not_qualified", answers: {}, corrections: [], followUpNote: "Denied any visit" });
    assert.equal(noFinding.ok, false, "a failure with no finding behind it is refused");

    const r = await verifyProspect({
      customerId: lead.id,
      outcome: "not_qualified",
      answers: { visited: "No" },
      corrections: [],
      followUpNote: "The shop says nobody visited.",
      failureReasonCode: refs.failureReasons[0].code,
    });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const after = await row(lead.id);
    assert.equal(after.leadStage, "lost");
    assert.equal(after.leadLostReason, VERIFICATION_FAILED_CODE);

    const d = await pipelineDashboard(DAY);
    assert.equal(d.manager.verificationFailed, 1);
    const rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.lost?.reason, VERIFICATION_FAILED_CODE);
    assert.equal(rec.verification.result, "verification_failed");
  });

  test("the calling desk's Prospect request: a verified call is what promotes it", async () => {
    const lead = await makeLead({
      leadStage: "suspect",
      ...fullProspectFields(),
      prospectRequestState: "awaiting",
      prospectRequestedAt: new Date(),
      prospectRequestReason: "regular_requirement",
      leadNextAction: "Sales manager verification",
      leadNextActionDate: DAY,
      leadNextActionOwnerId: manager.id,
    });
    const before = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(before.deskRequest, true);
    assert.equal(before.gate.kind, "verify");
    assert.equal((await pipelineDashboard(DAY)).manager.pendingVerification, 1, "the request waits in the same queue");

    const r = await verifyProspect({ customerId: lead.id, outcome: "verified", answers: { visited: "Yes" }, corrections: [] });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const after = await row(lead.id);
    assert.notEqual(after.leadStage, "suspect", "verification is what makes the request a Prospect");
    assert.ok(after.leadVerifiedAt);
  });

  test("qualification: ticks persist and merge, and the manager's review is recorded and holds the lead", async () => {
    const lead = await qualifiedLead({ leadQualification: { price_discussed: true } });
    const before = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(before.qualItems.find((q) => q.id === "delivery_discussed")!.done, false);

    const saved = await saveLeadQualification(lead.id, { delivery_discussed: true, agrees_to_test: true, next_step_agreed: true });
    assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
    assert.deepEqual(
      Object.keys((await row(lead.id)).leadQualification ?? {}).sort(),
      ["agrees_to_test", "delivery_discussed", "next_step_agreed", "price_discussed"],
      "a patch merges — it does not erase last week's ticks",
    );
    const after = (await pipelineLead(lead.id, DAY))!.lead;
    assert.ok(after.qualItems.every((q) => q.done));
    assert.equal(after.gate.kind, "requestSample");

    const noNote = await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete" });
    assert.equal(noNote.ok, false, "a refusal has to say what to do");
    const rev = await reviewLeadQualification({ customerId: lead.id, verdict: "incomplete", note: "Ask about the credit again." });
    /* That action calls `revalidatePath` outside a try, which throws with no
       request around it — after the write. What matters here is that the write
       landed, and the assertions below read it back from the database. */
    assert.ok(rev.ok || /static generation store/.test(rev.error), rev.ok ? "" : rev.error);
    const held = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(held.qualReview?.verdict, "incomplete");
    assert.equal(held.qualReview?.note, "Ask about the credit again.");
    assert.equal(held.gate.kind, "qualify", "a negative review holds the gate shut, and says why");
    assert.match(held.gate.kind === "qualify" ? (held.gate.note ?? "") : "", /marked this checklist incomplete/i);
  });

  test("the whole sample journey, each step a real row and each gate the engine's", async () => {
    const lead = await qualifiedLead();

    const asked = await requestSampleForLead({ customerId: lead.id, productId, quantityCans: 2, application: "Wood polish", reasonCode: "trial" });
    assert.equal(asked.ok, true, asked.ok ? "" : asked.error);
    let rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.stage, "sample_trial", "asking for a sample puts the lead at Sample / Trial — by the gate, not by fiat");
    assert.equal(rec.sample?.state, "requested");
    assert.equal(rec.gate.kind, "approveSample", "a manager holding sample.approve is offered the decision");

    const noReason = await decideSample(rec.sample!.id, { approve: false });
    assert.equal(noReason.ok, false, "a refusal needs a reason");
    const approved = await decideSample(rec.sample!.id, { approve: true });
    assert.equal(approved.ok, true, approved.ok ? "" : approved.error);
    rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.sample?.state, "approved");
    assert.equal(rec.gate.kind, "markDispatched");

    const dispatched = await dispatchSample(rec.sample!.id, { courierName: "Blue Dart", trackingNumber: "BD123", expectedDeliveryDate: NEXT_WEEK });
    assert.equal(dispatched.ok, true, dispatched.ok ? "" : dispatched.error);
    rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.sample?.state, "dispatched");
    assert.equal(rec.sample?.courier, "Blue Dart");
    assert.equal(rec.sample?.docket, "BD123");
    assert.equal(rec.gate.kind, "markReceived");

    const received = await receiveSampleForLead({ customerId: lead.id, sampleId: rec.sample!.id });
    assert.equal(received.ok, true, received.ok ? "" : received.error);
    rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.sample?.state, "received");
    assert.ok(rec.sample?.receivedAt);
    assert.equal(rec.stage, "sample_received");
    assert.equal(rec.gate.kind, "sampleReview");

    const blank = await reviewSampleForLead({ customerId: lead.id, sampleId: rec.sample!.id, fields: {}, trialOutcome: "approved" });
    assert.equal(blank.ok, false, "a review that says nothing is refused");
    const reviewed = await reviewSampleForLead({
      customerId: lead.id,
      sampleId: rec.sample!.id,
      fields: { quality: "Matched their benchmark" },
      trialOutcome: "approved",
    });
    assert.equal(reviewed.ok, true, reviewed.ok ? "" : reviewed.error);
    rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.stage, "sample_review");
    assert.equal(rec.gate.kind, "moveToNegotiation", "an approved trial is what opens the commercial conversation");
    assert.equal(rec.gate.kind === "moveToNegotiation" && rec.gate.disabled, false);
    assert.equal(rec.sample?.feedbackRecorded, true);
    assert.equal(rec.sample?.trialOutcome, "approved");
    assert.match(rec.sample?.feedback ?? "", /Matched their benchmark/);
  });

  test("a rejected trial has to say why, and an unapproved sample cannot be dispatched", async () => {
    const lead = await qualifiedLead();
    await requestSample(lead.id, { productId, quantityCans: 1, application: "Wood polish", reasonCode: "trial" });
    const waiting = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(waiting.stage, "qualification", "the raw request writes the sample and leaves the rung");
    assert.equal(waiting.gate.kind, "approveSample", "a request in flight is never offered a second request");
    const s = (await db.select().from(mbosSamples).where(eq(mbosSamples.customerId, lead.id)))[0];
    const early = await dispatchSample(s.id, { courierName: "DTDC", trackingNumber: "X1", expectedDeliveryDate: NEXT_WEEK });
    assert.equal(early.ok, false, "the godown cannot pack what nobody approved");
  });

  test("negotiation: a commitment is a forecast, and confirming the first order creates a REAL order for Accounts", async () => {
    const lead = await qualifiedLead({ leadStage: "negotiation" });
    const before = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(before.gate.kind, "askOrder");

    const commitment = await askForFirstOrder(lead.id, {
      answers: { product: "PU Thinner", quantity: "450 Litres", when: NEXT_WEEK },
      expectedDate: NEXT_WEEK,
      expectedCans: 22,
    });
    assert.equal(commitment.ok, true, commitment.ok ? "" : commitment.error);
    let rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.commitment?.expectedOrderDate, NEXT_WEEK);
    assert.equal(rec.commitment?.cans, 22);
    assert.equal(rec.commitment?.confirmed, true);
    assert.deepEqual(rec.orders, [], "a forecast is not an order");
    assert.equal(rec.gate.kind, "confirmOrder");
    assert.match(rec.gate.kind === "confirmOrder" ? rec.gate.note : "", /pending approval/i, "the screen says a real order is created");

    const noRef = await confirmFirstOrder(lead.id, { orderedOn: DAY, valuePaise: 4_500_000, reference: "" });
    assert.equal(noRef.ok, false);
    const placed = await confirmFirstOrder(lead.id, { orderedOn: DAY, valuePaise: 4_500_000, reference: "PO-7781", cans: 22 });
    assert.equal(placed.ok, true, placed.ok ? "" : placed.error);

    const real = await db.select().from(orders).where(eq(orders.customerId, lead.id));
    assert.equal(real.length, 1);
    assert.equal(real[0].status, "pending_approval", "it goes to Accounts like every other order");
    assert.equal(real[0].totalAmount, 4_500_000);

    rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.orders.length, 1);
    assert.equal(rec.orders[0].status, "pending_approval");
    assert.equal(rec.orders[0].amountPaise, 4_500_000);
  });

  test("a day with no size is recorded as an expected order and not called a commitment", async () => {
    const lead = await qualifiedLead({ leadStage: "negotiation" });
    const r = await askForFirstOrder(lead.id, { answers: { product: "PU Thinner" }, expectedDate: SOON });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.commitment?.confirmed, false);
    assert.equal(rec.gate.kind, "askOrder", "there is still nothing to confirm");
    assert.equal((await pipelineDashboard(DAY)).manager.expectedThisWeek, 1, "a forecast date still counts as awaited");
  });

  test("lost: a Prospect closes through the ordinary door, and a Suspect answers Not-a-Prospect with the decision mark", async () => {
    const prospect = await makeLead({ leadStage: "prospect", ...fullProspectFields() });
    const r = await markLeadLost({ customerId: prospect.id, reasonCode: "price", note: "Too dear" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const gone = await row(prospect.id);
    assert.equal(gone.leadStage, "lost");
    assert.equal(gone.leadLostReason, "price");
    const rec = (await pipelineLead(prospect.id, DAY))!.lead;
    assert.equal(rec.lost?.reasonLabel.length ? true : false, true);
    assert.equal(rec.stage, "prospect", "a lost lead keeps the rung it was lost at");
    assert.equal(rec.gate.kind, "closed");

    const suspect = await makeLead({ leadStage: "suspect" });
    const s = await markLeadLost({ customerId: suspect.id, reasonCode: "price" });
    assert.equal(s.ok, true, s.ok ? "" : s.error);
    assert.ok((await row(suspect.id)).leadSuspectDecidedAt, "the question is not asked again tomorrow");

    const bogus = await markLeadLost({ customerId: (await makeLead()).id, reasonCode: "not_a_reason" });
    assert.equal(bogus.ok, false, "the reason list is configuration");
  });

  test("reassign: persists, notifies, and refuses somebody who cannot hold a book", async () => {
    const lead = await makeLead({ leadStage: "prospect", ...fullProspectFields() });
    const r = await reassignLead({ leadId: lead.id, salesmanId: salesB.id });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    assert.equal((await row(lead.id)).ownerId, salesB.id);
    assert.equal((await pipelineLead(lead.id, DAY))!.lead.owner, "Salesman B");

    const bad = await reassignLead({ leadId: lead.id, salesmanId: telecaller.id });
    assert.equal(bad.ok, false, "a telecaller holds no Salesman App, so cannot be given a lead");
    assert.equal((await row(lead.id)).ownerId, salesB.id, "nothing moved");
  });

  test("next action: persists with its owner, and refuses an owner who cannot sign in", async () => {
    const lead = await makeLead({ leadStage: "prospect", ...fullProspectFields() });
    const r = await setLeadNextAction(lead.id, { action: "Send the price list", date: NEXT_WEEK, ownerId: salesA.id, outcome: "A yes" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    const rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.nextAction, "Send the price list");
    assert.equal(rec.nextActionDate, NEXT_WEEK);
    assert.equal(rec.nextActionResp, "Salesman A");
    assert.equal(rec.expectedOutcome, "A yes");

    await db.update(users).set({ active: false }).where(eq(users.id, salesB.id));
    const bad = await setLeadNextAction(lead.id, { action: "x", date: NEXT_WEEK, ownerId: salesB.id });
    assert.equal(bad.ok, false);
    assert.equal((await pipelineLead(lead.id, DAY))!.lead.nextActionResp, "Salesman A");
  });

  test("communications: each press is a counted timeline row, and moves nothing", async () => {
    const lead = await makeLead({ leadStage: "prospect", ...fullProspectFields() });
    const noDoc = await recordCommunication(lead.id, { actionCode: "price_list" });
    assert.equal(noDoc.ok, false, "a send that names no document is refused — so the screen must not draw it enabled");
    assert.deepEqual((await pipelineLead(lead.id, DAY))!.lead.commDocs, {}, "nothing published, so no send button is offered");

    const docId = id("mdoc");
    await db.insert(mbosDocuments).values({ id: docId, title: "Price list Sept", category: "price_list", active: true });
    const withDoc = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(withDoc.commDocs.price_list?.id, docId);
    for (let i = 0; i < 2; i++) {
      const sent = await recordCommunication(lead.id, { actionCode: "price_list", documentId: docId });
      assert.equal(sent.ok, true, sent.ok ? "" : sent.error);
    }
    const call = await recordCommunication(lead.id, { actionCode: "call" });
    assert.equal(call.ok, true, "a call needs no document");
    const rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.comms.price_list, 2, "counted over the whole history, so the badge cannot undercount");
    assert.equal(rec.stage, "prospect");
    assert.ok(rec.timeline.length >= 2);
    assert.ok(rec.timeline.every((t) => t.d && t.title));
  });

  test("a stage that is refused is not moved, and the refusal is the engine's sentence", async () => {
    const lead = await makeLead({ leadStage: "prospect", ...fullProspectFields() }); // unverified
    const r = await advanceLeadStage({ customerId: lead.id, to: "qualification" });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /not open yet/i);
    assert.equal((await row(lead.id)).leadStage, "prospect");
    const rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.gate.kind, "verify", "the screen offers the step that unlocks it");
  });

  test("saveProspectFields refuses a made-up customer type", async () => {
    const lead = await makeLead();
    const bad = await saveProspectFields(lead.id, { customerType: "spaceship" as never });
    assert.equal(bad.ok, false);
  });
});

/* ═════════════════════════════════════════════════════════ the distributor */

describe("D — the distributor track runs through the appointment chain that exists", () => {
  async function distributorCandidate() {
    const lead = await makeLead({
      name: "Sharma Distributors",
      leadSalesType: "distributor",
      leadStage: "qualification",
      ...fullProspectFields(),
      leadVerifiedAt: new Date(),
      leadNextAction: "Send for review",
      leadNextActionDate: NEXT_WEEK,
      leadNextActionOwnerId: manager.id,
    });
    await db.insert(distributorProfiles).values({
      id: id("dpr"),
      customerId: lead.id,
      gstVerified: true,
      panNumber: "ABCDE1234F",
      panVerified: true,
      businessAddressVerified: true,
      businessType: "Wholesale",
      yearsInBusiness: 12,
      decisionMaker: "Mr Sharma",
      hasDealerNetwork: true,
      activeDealerCount: 40,
      territoryCovered: "Nashik",
      citiesCovered: "Nashik, Dhule",
      salesTeamSize: 6,
      deliveryCapability: "Own trucks",
      hasWarehouse: true,
      storageCapacityLitres: 20000,
      productPortfolio: "Paints",
      competitorBrands: "Asian",
      monthlyPotentialPaise: 90_000_000,
      initialOrderPotentialPaise: 20_000_000,
      investmentCapacityPaise: 50_000_000,
      expectedMonthlyPurchasePaise: 30_000_000,
      creditDaysRequired: 30,
      creditLimitRequiredPaise: 5_000_000,
      proposedTerritory: "North Maharashtra",
      existingDistributorChecked: true,
      territoryConflict: false,
      exclusivityRequested: false,
      initialStockCommitmentPaise: 10_000_000,
      monthlyPurchaseCommitmentPaise: 8_000_000,
      dealerDevelopmentCommitment: "Ten new dealers",
      expectedStartDate: NEXT_WEEK,
    });
    return lead;
  }

  test("the candidate is drawn with its profile, and 'send for review' is the engine's verdict", async () => {
    const lead = await distributorCandidate();
    const rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.salesType, "distributor");
    assert.equal(rec.distributorProfile?.businessType, "Wholesale");
    assert.equal(rec.distributorProfile?.activeDealers, 40);
    assert.equal(rec.gate.kind, "submitManagement");
    assert.equal(rec.approvalSteps.length, 0);
    assert.ok(rec.approvalThresholds && rec.approvalThresholds.discountPercent > 0);
  });

  test("put forward: a real approval row, and the record then offers the step to whoever may decide it", async () => {
    const lead = await distributorCandidate();
    const r = await submitForManagementReview(lead.id, "Looks solid");
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    const approvals = await db.select().from(mbosApprovals).where(eq(mbosApprovals.subjectId, lead.id));
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].state, "pending");
    assert.equal(approvals[0].stepIndex, 0);

    const rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.approvalSteps.length, 1);
    assert.equal(rec.approvalSteps[0].state, "pending");
    assert.equal(rec.approval?.id, approvals[0].id);
    assert.equal(rec.gate.kind, "decideDistributor");

    const again = await submitForManagementReview(lead.id);
    assert.equal(again.ok, false, "already waiting for a decision");
  });

  test("the whole appointment: recommend, agree terms, management decides, the agreement, the last rung", async () => {
    const lead = await distributorCandidate();
    await submitForManagementReview(lead.id);
    const step0 = (await db.select().from(mbosApprovals).where(eq(mbosApprovals.subjectId, lead.id)))[0];

    /* Step one is the sales manager's. */
    const first = await decideDistributorAppointment(step0.id, { approve: true });
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    let rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.stage, "commercial_discussion", "a recommendation opens the commercial conversation");
    assert.equal(rec.gate.kind, "agreeTerms");
    assert.equal(rec.gate.kind === "agreeTerms" && rec.gate.disabled, false);

    /* Terms are agreed, and THAT is what raises management's step. */
    const terms = await agreeCommercialTerms(lead.id, { discountPercent: 5, creditLimitPaise: 3_000_000, exclusivity: false, note: "Standard" });
    assert.equal(terms.ok, true, terms.ok ? "" : terms.error);
    rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.distributorProfile?.agreedDiscountPercent, 5);
    assert.equal(rec.distributorProfile?.agreedCreditLimitPaise, 3_000_000);
    assert.ok(rec.distributorProfile?.termsAgreedAt);
    const chain = await db.select().from(mbosApprovals).where(eq(mbosApprovals.subjectId, lead.id));
    const pending = chain.find((c) => c.state === "pending");
    assert.ok(pending && pending.stepIndex === 1, "agreeing terms raises management's step");
    assert.equal(rec.approval?.stepIndex, 1);

    /* A sales manager may recommend and may not appoint — drawn disabled, and refused by the action. */
    assert.equal(rec.gate.kind, "decideDistributor");
    assert.equal(rec.gate.kind === "decideDistributor" && rec.gate.disabled, true);
    const refused = await decideDistributorAppointment(pending!.id, { approve: true });
    assert.equal(refused.ok, false, "the action re-checks who may make the second decision");
    assert.equal((await db.select().from(mbosApprovals).where(eq(mbosApprovals.id, pending!.id)))[0].state, "pending");

    /* Management decides. */
    setTestUser(boss);
    assert.equal(((await pipelineLead(lead.id, DAY))!.lead.gate as { disabled?: boolean }).disabled, false, "management is offered it");
    const done = await decideDistributorAppointment(pending!.id, { approve: true });
    assert.equal(done.ok, true, done.ok ? "" : done.error);
    setTestUser(manager);
    rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.stage, "distributor_approval");
    assert.equal(rec.approvalSteps.length, 2);
    assert.ok(rec.approvalSteps.every((st) => st.state === "approved"));
    assert.equal(rec.gate.kind, "confirmAgreement");
    assert.match(rec.gate.kind === "confirmAgreement" ? (rec.gate.note ?? "") : "", /signed agreement/i, "the engine's own words about what the rung needs");

    /* The paper. Recording it is a fact; the rung is gated on a FILED agreement.
       KNOWN GAP, said by the screen rather than hidden: MahekOne has nowhere to
       file the signed agreement yet (see `recordDistributorAgreement`), so the
       ladder does not move, and the action says so. */
    const agreed = await recordDistributorAgreement(lead.id, {});
    assert.equal(agreed.ok && (agreed.warnings ?? []).length, 1, JSON.stringify(agreed));
    assert.equal((await pipelineLead(lead.id, DAY))!.lead.stage, "distributor_approval");
  });

  test("a refusal at step one needs a reason and leaves the candidate where it was", async () => {
    const lead = await distributorCandidate();
    await submitForManagementReview(lead.id);
    const step0 = (await db.select().from(mbosApprovals).where(eq(mbosApprovals.subjectId, lead.id)))[0];
    const bare = await decideDistributorAppointment(step0.id, { approve: false });
    assert.equal(bare.ok, false);
    const refused = await decideDistributorAppointment(step0.id, { approve: false, note: "Territory clash" });
    assert.equal(refused.ok, true, refused.ok ? "" : refused.error);
    const rec = (await pipelineLead(lead.id, DAY))!.lead;
    assert.equal(rec.approvalSteps[0].state, "rejected");
    assert.equal(rec.approvalSteps[0].note, "Territory clash");
    assert.equal(rec.stage, "qualification");
  });
});

/* ═══════════════════════════════════════════════════════ authorisation */

describe("A — authorisation is the existing model, asked in the existing order", () => {
  test("who may open the module: the Sales grant AND the module, and nobody else", async () => {
    assert.equal(await canOpenModule(manager.id, "sales.leads"), true);
    assert.equal(await canOpenModule(telecaller.id, "sales.leads"), false, "a telecaller holds only the CRM");
    assert.equal(await canOpenModule(salesA.id, "sales.leads"), false, "a field salesman's app is the handset");

    /* A sales grant narrowed away from this module is not a way in. */
    const narrowed = await makeUser("Narrowed", "manager", [{ app: "sales", role: "manager" }]);
    await db.insert(appModuleAccess).values({ id: id("ama"), userId: narrowed.id, app: "sales", module: "sales.lead-funnel" });
    assert.equal(await canOpenModule(narrowed.id, "sales.leads"), false);
  });

  test("a telecaller cannot verify, and a salesman cannot approve a sample", async () => {
    const lead = await makeLead({ leadStage: "prospect", ...fullProspectFields() });
    setTestUser(telecaller);
    const v = await verifyProspect({ customerId: lead.id, outcome: "verified", answers: {}, corrections: [] });
    assert.equal(v.ok, false);
    assert.equal((await row(lead.id)).leadVerifiedAt, null, "nothing was written");

    const qualified = await qualifiedLead();
    setTestUser(manager);
    await requestSample(qualified.id, { productId, quantityCans: 1, application: "Wood polish", reasonCode: "trial" });
    const s = (await db.select().from(mbosSamples).where(eq(mbosSamples.customerId, qualified.id)))[0];
    setTestUser(salesA);
    const d = await decideSample(s.id, { approve: true });
    assert.equal(d.ok, false, "sample.approve is a manager's");
    assert.equal((await db.select().from(mbosSamples).where(eq(mbosSamples.id, s.id)))[0].state, "requested");
  });

  test("the capability flags the screen draws from are the ones the actions check", async () => {
    const lead = await makeLead({ leadStage: "prospect", ...fullProspectFields() });
    setTestUser(manager);
    const asManager = (await pipelineLead(lead.id, DAY))!.lead.caps;
    assert.equal(asManager.canVerify, true);
    assert.equal(asManager.canApproveSample, true);
    assert.equal(asManager.canApproveDistributor, false, "management's own step is not a sales manager's");
    setTestUser(boss);
    assert.equal((await pipelineLead(lead.id, DAY))!.lead.caps.canApproveDistributor, true);
  });

  test("READ SCOPE AND WRITE SCOPE DISAGREE for a Sales Dashboard ASSOCIATE — a clear refusal, reported and not fixed", async () => {
    /* `managerScope` (what every screen here reads through) is NATIONAL for
       anybody with no region row, and it does not ask the LEVEL: an associate
       who was granted the Sales Dashboard sees every lead. `assertCustomerInScope`
       (what every action writes through) resolves scope by level, and an
       associate's is their own book. So a lead somebody else owns is visible
       and not workable: the capability flag is true (`lead.work` is every
       associate's), the action refuses, nothing changes, and the screen shows
       the refusal. Neither side is weakened by this suite — the brief forbids
       changing either — and a manager on the Sales Dashboard does not hit it,
       because their write scope is as wide as their read scope. */
    const assoc = await makeUser("Sales Associate", "associate", [{ app: "sales", role: "associate" }]);
    const lead = await makeLead({ leadStage: "prospect", ...fullProspectFields() });
    setTestUser(assoc);

    const visible = await pipelineLead(lead.id, DAY);
    assert.ok(visible, "the read side shows it");
    assert.equal(visible.lead.caps.canWork, true, "and the screen has every reason to draw the controls");

    const refused = await setLeadNextAction(lead.id, { action: "Try to change it", date: NEXT_WEEK, ownerId: salesA.id });
    assert.equal(refused.ok, false, "the write side keeps its own check");
    assert.ok(!refused.ok && refused.error.length > 0);
    assert.equal((await row(lead.id)).leadNextAction, null, "nothing was written");
  });
});
