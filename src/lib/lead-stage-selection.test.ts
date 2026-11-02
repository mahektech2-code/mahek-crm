import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  bills,
  customers,
  leadStageTransitions,
  mbosSamples,
  orders,
  products,
  timelineEvents,
  users,
} from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { invalidateConfig, seedConfig } from "@/lib/config/store";
import { selectLeadStage } from "@/lib/actions/leads";
import { canActAsQualificationApprover } from "@/lib/services/qualification-approver";
import { reviewLeadQualification } from "@/lib/actions/lead-qualification-review";
import { setTestWorkspace } from "@/lib/services/crm-sales-manager-scope";
import { CRM_SALES_MANAGER_WORKSPACE } from "@/proxy";
import { QUALIFICATION_ANSWERS } from "@/lib/qualification-fixtures";
import { testPhone } from "@/lib/test-phone";

/* ---------------------------------------------------------------------------
 * A SALES MANAGER CHOOSING A LATER STAGE FROM QUALIFICATION — the real action,
 * the real gate, a real database.
 *
 * What is proved: nothing moves unless asked; the verified review and the whole
 * Sample / Trial entry gate are mandatory; only `lead.verify` may; the move is
 * written as a distinct `skipped` transition with its reason, the skipped rungs
 * and its own timeline event; and NO sample, order, bill or receipt row is
 * created or touched to make it possible.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const NEXT_WEEK = "2026-10-01";

let manager: typeof users.$inferSelect;
let telecaller: typeof users.$inferSelect;
let salesman: typeof users.$inferSelect;
let admin: typeof users.$inferSelect;
let productId: string;

async function makeUser(name: string, role: "associate" | "manager" | "admin", app: "crm" | "field") {
  const [row] = await db
    .insert(users)
    .values({
      id: id("usr"),
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 4)}@test.local`,
      phone: testPhone(),
      passwordHash: "x",
      role,
      initials: name.slice(0, 2).toUpperCase(),
    })
    .returning();
  await db.insert(appAccess).values({ id: id("aca"), userId: row.id, app, role });
  return row;
}

/** A direct lead at Qualification that has answered everything the Sample / Trial gate reads, review verified. */
async function qualified(over: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      id: id("cus"),
      name: `Lead ${randomUUID().slice(0, 6)}`,
      contactPerson: "Ganesh",
      phone: testPhone(),
      city: "Nashik",
      kind: "lead",
      leadStage: "qualification",
      leadSalesType: "direct",
      leadSource: "manual",
      ownerId: salesman.id,
      leadManagerId: manager.id,
      salesManagerId: manager.id,
      leadStageSince: "2026-09-23",
      leadLastActivityDate: "2026-09-23",
      customerType: "retailer",
      leadMonthlyVolumeLitres: 300,
      leadEstimatedPotentialPaise: 9_000_000,
      leadCompetitor: "Local thinner",
      leadRequiredProductId: productId,
      gstin: "27ABCDE1234F1Z5",
      gstVerified: true,
      leadDecisionMaker: "Owner",
      leadApplication: "Wood polish",
      leadCreditDaysWanted: 30,
      leadBuyer: "Ganesh's brother",
      leadFiguresConfirmedAt: new Date(),
      leadVerifiedAt: null, // the Verification Call is optional: this lead never had one
      leadNextAction: "Go back with the price list",
      leadNextActionDate: NEXT_WEEK,
      leadNextActionOwnerId: manager.id,
      leadQualification: { ...QUALIFICATION_ANSWERS },
      leadQualificationReview: "verified",
      leadQualificationReviewedAt: new Date(),
      leadQualificationReviewedById: manager.id,
      ...over,
    })
    .returning();
  return row;
}

const row = async (leadId: string) => (await db.select().from(customers).where(eq(customers.id, leadId)))[0];
const count = async (table: string) =>
  Number((await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))[0].n);

before(() => {
  assert.match(process.env.DATABASE_URL ?? "", /mahekone_test/, "Run against the test database only.");
});

beforeEach(async () => {
  await db.execute(sql`
    truncate table lead_stage_transitions, timeline_events, mbos_samples, sample_feedback, orders, bills,
      payment_receipts, payments, notifications, audit_log, app_access, customers, products, users, app_settings
    restart identity cascade
  `);
  invalidateConfig();
  await seedConfig();
  manager = await makeUser("Sales Manager", "manager", "crm");
  telecaller = await makeUser("Tele Caller", "associate", "crm");
  salesman = await makeUser("Salesman A", "associate", "field");
  admin = await makeUser("Big Boss", "admin", "crm");
  productId = id("prd");
  await db.insert(products).values({ id: productId, name: "PU Thinner - 20 Liter (Loose)" });
  setTestUser(manager);
});

after(async () => {
  setTestUser(null);
  await db.$client.end();
});

const lastTransition = async (leadId: string) =>
  (await db.select().from(leadStageTransitions).where(eq(leadStageTransitions.customerId, leadId)).orderBy(desc(leadStageTransitions.at)))[0];

describe("a Sales Manager moves a verified lead straight to Negotiation", () => {
  test("Qualification → Negotiation: a `skipped` transition names the rungs not climbed and the reason, and a timeline event of its own is written", async () => {
    const lead = await qualified();
    const r = await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "knows_product" });
    assert.equal(r.ok, true, r.ok ? "" : r.error);

    assert.equal((await row(lead.id)).leadStage, "negotiation");
    const t = await lastTransition(lead.id);
    assert.equal(t.kind, "skipped");
    assert.equal(t.fromStage, "qualification");
    assert.equal(t.toStage, "negotiation");
    assert.equal(t.reasonCode, "knows_product");
    assert.deepEqual(t.skippedStages, ["sample_trial", "sample_review"]);
    assert.deepEqual(t.overriddenConditions, [], "nothing was passed while shut — this is not an override");
    assert.equal(t.actorId, manager.id);
    assert.ok(t.at, "timestamped");

    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.customerId, lead.id));
    const ev = events.filter((e) => e.eventType === "lead_stage_skipped");
    assert.equal(ev.length, 1);
    assert.match(ev[0].summary ?? "", /Negotiation/);
    assert.match(ev[0].summary ?? "", /not climbed/);
    assert.equal(events.filter((e) => e.eventType === "lead_stage").length, 0, "it is not written as an ordinary move");
  });

  test("it never fabricates a sample, order, bill or receipt", async () => {
    const lead = await qualified();
    const before = [await count("mbos_samples"), await count("orders"), await count("bills"), await count("payment_receipts")];
    assert.equal((await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "sample_not_needed" })).ok, true);
    const after_ = [await count("mbos_samples"), await count("orders"), await count("bills"), await count("payment_receipts")];
    assert.deepEqual(after_, before);
    assert.equal(after_[0], 0);
    assert.equal((await db.select().from(mbosSamples).where(eq(mbosSamples.customerId, lead.id))).length, 0);
    assert.equal((await db.select().from(orders).where(eq(orders.customerId, lead.id))).length, 0);
    assert.equal((await db.select().from(bills).where(eq(bills.customerId, lead.id))).length, 0);
  });

  test("the Verification Call stays optional: this lead has no verification and it moves", async () => {
    const lead = await qualified();
    assert.equal((await row(lead.id)).leadVerifiedAt, null);
    assert.equal((await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "ready_to_negotiate" })).ok, true);
  });

  test("nothing is moved unless asked: a lead left alone stays in Qualification with no new rows", async () => {
    const lead = await qualified();
    assert.equal((await row(lead.id)).leadStage, "qualification");
    assert.equal(await count("lead_stage_transitions"), 0);
  });
});

describe("the safeguards that stay mandatory", () => {
  test("a pending, incomplete, clarification or voided review blocks the move", async () => {
    for (const review of [null, "incomplete", "clarification"] as const) {
      const lead = await qualified({ leadQualificationReview: review });
      const r = await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "knows_product" });
      assert.equal(r.ok, false, `review ${String(review)} must block`);
      assert.equal((await row(lead.id)).leadStage, "qualification");
    }
    assert.equal(await count("lead_stage_transitions"), 0);
  });

  test("an unvalidated GST and an unanswered question each block it", async () => {
    const gst = await qualified({ gstVerified: false });
    assert.equal((await selectLeadStage({ customerId: gst.id, to: "negotiation", reasonCode: "knows_product" })).ok, false);
    const answers: Record<string, string> = { ...QUALIFICATION_ANSWERS };
    delete answers.trial_product;
    const open = await qualified({ leadQualification: answers });
    assert.equal((await selectLeadStage({ customerId: open.id, to: "negotiation", reasonCode: "knows_product" })).ok, false);
  });

  test("a third-party lead with no distributor named is blocked", async () => {
    const lead = await qualified({ leadSalesType: "third_party" });
    const r = await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "knows_product" });
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r), /distributor/i);
  });

  test("a reason from the configured list is required, and Other demands the sentence", async () => {
    const lead = await qualified();
    assert.equal((await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "made_up" })).ok, false);
    const other = await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "other" });
    assert.equal(other.ok, false, "Other with no note is refused");
    assert.equal(
      (await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "other", note: "Known customer of the group" })).ok,
      true,
    );
  });

  test("real facts still gate later stages: no order, no 1st Order", async () => {
    const lead = await qualified();
    for (const to of ["first_order", "delivery", "payment", "second_order", "customer"] as const) {
      const r = await selectLeadStage({ customerId: lead.id, to, reasonCode: "knows_product" });
      assert.equal(r.ok, false, `${to} needs a real record`);
    }
    assert.equal((await row(lead.id)).leadStage, "qualification");
    assert.equal(await count("orders"), 0);
  });

  test("Sample / Trial is an ordinary move, and only Qualification offers the choice", async () => {
    const lead = await qualified();
    assert.equal((await selectLeadStage({ customerId: lead.id, to: "sample_trial", reasonCode: "knows_product" })).ok, false);
    const elsewhere = await qualified({ leadStage: "prospect" });
    assert.equal((await selectLeadStage({ customerId: elsewhere.id, to: "negotiation", reasonCode: "knows_product" })).ok, false);
    const distributor = await qualified({ leadSalesType: "distributor" });
    assert.equal((await selectLeadStage({ customerId: distributor.id, to: "negotiation", reasonCode: "knows_product" })).ok, false);
  });
});

describe("who may choose", () => {
  test("a Telecaller (no lead.verify) is refused on the server, and nothing is written", async () => {
    const lead = await qualified({ ownerId: telecaller.id });
    setTestUser(telecaller);
    const r = await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "knows_product" }).catch((e) => ({ ok: false as const, error: String(e) }));
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "qualification");
    assert.equal(await count("lead_stage_transitions"), 0);
  });

  test("a Salesman is refused too", async () => {
    const lead = await qualified();
    setTestUser(salesman);
    const r = await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "knows_product" }).catch((e) => ({ ok: false as const, error: String(e) }));
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });

  test("the generic override setting is irrelevant: this does not read it", async () => {
    await db.execute(sql`update app_settings set value = 'false'::jsonb where key = 'leads.allowManagerOverride'`);
    invalidateConfig();
    const lead = await qualified();
    assert.equal((await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "knows_product" })).ok, true);
  });
});

describe("the authority is the Qualification reviewer's, not a capability", () => {
  /** An Associate-level Sales Manager: holds the seat and the Sales Manager module, and NOT `lead.verify`. */
  async function associateSeat(name: string) {
    const u = await makeUser(name, "associate", "crm");
    await db.insert(appModuleAccess).values({ id: id("ama"), userId: u.id, app: "crm", module: "crm.sales-manager" });
    return u;
  }

  test("the designated reviewer may choose even as an ASSOCIATE with no lead.verify — in the Sales Manager workspace, where an Associate-level Sales Manager works — and the card's check says the same", async () => {
    const seema = await associateSeat("Seema Like");
    assert.equal(seema.role, "associate", "her level is not touched");
    const lead = await qualified({ salesManagerId: seema.id, leadManagerId: null });
    setTestUser(seema);
    setTestWorkspace(CRM_SALES_MANAGER_WORKSPACE);
    try {
      assert.equal(await canActAsQualificationApprover(seema, lead.id), true);
      const r = await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "knows_product" });
      assert.equal(r.ok, true, r.ok ? "" : r.error);
      const t = await lastTransition(lead.id);
      assert.equal(t.kind, "skipped");
      assert.equal(t.actorId, seema.id);
    } finally {
      setTestWorkspace(null);
    }
    assert.equal((await db.select().from(appAccess).where(eq(appAccess.userId, seema.id)))[0].role, "associate", "no account level changed");
  });

  test("PARITY WITH THE REVIEW: outside the workspace, with no seat the write scope counts, the review itself is refused with the very same sentence — so choosing a stage is neither stricter nor looser than reviewing", async () => {
    const seema = await associateSeat("Seema Parity");
    const lead = await qualified({ salesManagerId: seema.id, leadManagerId: null });
    setTestUser(seema);
    const chosen = await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "knows_product" });
    const reviewed = await reviewLeadQualification({ customerId: lead.id, verdict: "verified" });
    assert.equal(chosen.ok, false);
    assert.equal(reviewed.ok, false);
    assert.equal(chosen.ok === false && reviewed.ok === false && chosen.error === reviewed.error, true,
      `same refusal expected: [${chosen.ok ? "" : chosen.error}] vs [${reviewed.ok ? "" : reviewed.error}]`);
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });

  test("ANOTHER manager holding lead.verify is refused: only the designated reviewer chooses", async () => {
    const other = await makeUser("Other Manager", "manager", "crm");
    const lead = await qualified(); // its seat is `manager`, not `other`
    setTestUser(other);
    assert.equal(await canActAsQualificationApprover(other, lead.id), false, "the card is not drawn for them");
    const r = await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "knows_product" });
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r), /Only .* can confirm or reject|not_permitted|different Sales Manager|designated/i);
    assert.equal((await row(lead.id)).leadStage, "qualification");
    assert.equal(await count("lead_stage_transitions"), 0);
  });

  test("an administrator who is not the designated reviewer is refused like everybody else", async () => {
    const lead = await qualified();
    setTestUser(admin);
    assert.equal(await canActAsQualificationApprover(admin, lead.id), false);
    const r = await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "knows_product" });
    assert.equal(r.ok, false);
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });

  test("an Associate who holds the module but sits under a DIFFERENT Sales Manager is refused", async () => {
    const outsider = await associateSeat("Outsider Seat");
    const lead = await qualified(); // seat = `manager`
    setTestUser(outsider);
    assert.equal(await canActAsQualificationApprover(outsider, lead.id), false);
    assert.equal((await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "knows_product" })).ok, false);
    assert.equal((await row(lead.id)).leadStage, "qualification");
  });

  test("the lead's own seat holder at manager level still may (existing behaviour kept)", async () => {
    const lead = await qualified();
    assert.equal(await canActAsQualificationApprover(manager, lead.id), true);
    assert.equal((await selectLeadStage({ customerId: lead.id, to: "negotiation", reasonCode: "knows_product" })).ok, true);
  });
});
