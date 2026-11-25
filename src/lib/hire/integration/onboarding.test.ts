/**
 * The Onboarding & Training PRD, end to end, against a real database through
 * the real services: compensation negotiated past the line waits for an
 * approver; documents and the background check gate employment documents;
 * signed copies come back by courier; provisioning makes the person hired and
 * enrols them; assets are acknowledged by the employee; a failed module needs
 * a trainer's sign-off and fresh study before its retake; passing the track
 * completes onboarding. And nothing that was submitted can be rewritten.
 *
 *   npm run test:integration
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, hireApplications, hireAudit, hireCandidates, hireCourierShipments, hireDecisions, hireUserRoles, trainingAttempts, trainingEnrollments, trainingModuleVersions, users } from "@/db/schema";
import { GATE_POINT } from "@/lib/hire/roles";
import { setTestUser } from "@/lib/auth";
import { hireContext, type HireContext } from "@/lib/hire/access";
import { seedHireBlueprints } from "@/lib/hire/seed/seed";
import { publishOnboardingVersions, seedOnboardingContent } from "@/lib/hire/install";
import { advanceIfPassed, getApplication } from "@/lib/hire/services/core";
import { currentOffer, decideApproval, issueOffer, recordResponse, saveOffer } from "@/lib/hire/services/offers";
import { setDocumentStatus, setItem } from "@/lib/hire/services/onboarding";
import {
  acknowledgeMyAsset,
  approveEmploymentDoc,
  courierEvent,
  employmentDocRows,
  issueAsset,
  markEmploymentDocSigned,
  myAssets,
  prepareEmploymentDocs,
  publishedPlans,
  requestDocuments,
  saveBgv,
  sendEmploymentDocs,
} from "@/lib/hire/services/onboarding-records";
import { onboardingRows } from "@/lib/hire/services/onboarding-board";
import { provision } from "@/lib/hire/services/provision";
import { answerQuestion, enrollmentForApplication, enrollmentView, recordStudy, signOffRetraining, startAttempt, submitAttempt } from "@/lib/training/service";

const uid = () => `usr_${randomUUID().slice(0, 12)}`;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

async function person(name: string, role: string, level: "associate" | "manager" | "admin" = "associate") {
  const [u] = await db.insert(users).values({ id: uid(), name, email: `${name.split(" ")[0].toLowerCase()}.${randomUUID().slice(0, 6)}@test.in`, passwordHash: "x", role: level, initials: "XX" }).returning();
  await db.insert(appAccess).values({ id: `acc_${randomUUID()}`, userId: u.id, app: "hire", role: level });
  await db.insert(hireUserRoles).values({ userId: u.id, role });
  return u;
}

async function as(u: typeof users.$inferSelect): Promise<HireContext> {
  setTestUser(u);
  const ctx = await hireContext();
  assert.ok(ctx, "hire context");
  return ctx;
}

const must = <T,>(r: { ok: true; data: T } | { ok: false; error: string }, what: string): T => {
  assert.ok(r.ok, `${what}: ${r.ok ? "" : r.error}`);
  return (r as { ok: true; data: T }).data;
};

describe("Onboarding & Training PRD", () => {
  let head: typeof users.$inferSelect;
  let recruiter: typeof users.$inferSelect;
  let manager: typeof users.$inferSelect;
  let onboarder: typeof users.$inferSelect;
  let trainer: typeof users.$inferSelect;
  let appId: string;
  const SE4 = "hbp_sales-executive_v4";

  before(async () => {
    await db.execute(sql`truncate training_attempt_corrections, training_attempts, training_events, training_enrollments, training_track_versions, training_tracks, training_module_versions, training_modules, hire_courier_events, hire_courier_shipments, hire_employment_docs, hire_doc_templates, hire_background_checks, hire_asset_issues, hire_incentive_plans, hire_audit, hire_ai_outputs, hire_ai_tasks, hire_messages, hire_onboarding_items, hire_offers, hire_profiles, hire_documents, hire_vault, hire_files, hire_sessions, hire_rejection_proposals, hire_decisions, hire_briefing_responses, hire_answers, hire_stage_executions, hire_outcomes, hire_applications, hire_candidates, hire_user_roles, hire_blueprints cascade`);
    head = await person("Kavita Head", "hr_head", "manager");
    recruiter = await person("Priya Recruiter", "recruiter");
    manager = await person("Sanjay Manager", "hiring_manager", "manager");
    onboarder = await person("Farida Onboarding", "onboarding");
    trainer = await person("Rohini Trainer", "trainer");
    await seedHireBlueprints(head.id);
    await seedOnboardingContent(head.id, true);
    await publishOnboardingVersions(head.id);
    /* A candidate past the gate, at Compensation — the pipeline before it is the core suite's. */
    const cid = `hca_${randomUUID()}`;
    await db.insert(hireCandidates).values({ id: cid, code: "HC-9001", fullName: "Kiran Shinde", primaryPhone: "+919822041410", location: "Pune West" });
    appId = `hap_${randomUUID()}`;
    await db.insert(hireApplications).values({ id: appId, candidateId: cid, blueprintId: SE4, stageKey: "comp", recruiterId: recruiter.id, hiringManagerId: manager.id, location: "Pune West" });
    await db.insert(hireDecisions).values({ id: `hde_${randomUUID()}`, applicationId: appId, decisionPoint: GATE_POINT, decidedById: manager.id, decidedByRole: "Hiring Manager", decision: "advance", reasoning: "Strong on every level and the briefing was agreed in full.", agreedWithAi: null, evidenceReviewed: [] });
  });

  after(async () => {
    setTestUser(null);
    await db.$client.end();
  });

  test("compensation: a negotiated basic past the line waits for an approver who is not the asker", async () => {
    const rc = await as(recruiter);
    const plan = (await publishedPlans(["sales-executive-monthly"]))[0];
    assert.ok(plan, "the seeded plan is published");
    const base = { grade: "S1", ctcRupees: null, joiningDate: "2026-12-15", expiryDate: "2026-12-10", incentiveApplicable: true, incentivePlanId: plan.id, components: [{ key: "ta", label: "Travel allowance", amountRupees: 2500, per: "month" as const }] };
    must(await saveOffer(rc, appId, { ...base, basicRupees: 19_500 }), "first draft");
    assert.equal((await currentOffer(appId))?.approvalStatus, "not_needed");
    must(await issueOffer(rc, appId), "issue");
    must(await recordResponse(rc, appId, { response: "negotiating", note: "He asked for ₹22,000 to match his current pay." }), "negotiating");
    const noReason = await saveOffer(rc, appId, { ...base, basicRupees: 21_000 });
    assert.equal(noReason.ok, false, "a moved figure needs its reason");
    must(await saveOffer(rc, appId, { ...base, basicRupees: 21_000, changeReason: "Matched his current fixed pay from the payslips." }), "revised draft");
    const o = await currentOffer(appId);
    assert.equal(o?.approvalStatus, "pending", "+7.7% is past the 5% line");
    assert.equal(o?.proposedBasicPaise, 1_950_000, "the proposal is carried through the negotiation");
    assert.equal((await issueOffer(rc, appId)).ok, false, "it cannot be issued while waiting");
    const mc = await as(manager);
    assert.equal((await decideApproval(mc, appId, "approved", "short")).ok, false, "an approval says why");
    must(await decideApproval(mc, appId, "approved", "Within the band and matched to his payslips — fine."), "approve");
    const rc2 = await as(recruiter);
    must(await issueOffer(rc2, appId), "issue revised");
    must(await recordResponse(rc2, appId, { response: "accepted", note: "" }), "accept");
    const b = await getApplication(rc2, appId);
    assert.equal(b?.app.stageKey, "doc", "accepting moved them on to documents");
    const trail = await db.select().from(hireAudit).where(and(eq(hireAudit.applicationId, appId), eq(hireAudit.eventType, "compensation_changed")));
    assert.ok(trail.some((t) => (t.before as { basicPaise: number }).basicPaise === 1_950_000 && (t.after as { basicPaise: number }).basicPaise === 2_100_000), "the trail keeps the old and new figures");
  });

  test("documents and the background check gate employment documents", async () => {
    const oc = await as(onboarder);
    const b = (await getApplication(oc, appId))!;
    must(await requestDocuments(oc, appId, b.def.documents.map((d) => d.key)), "request");
    assert.equal((await prepareEmploymentDocs(oc, appId)).ok, false, "not at employment documents yet");
    for (const d of b.def.documents.filter((x) => x.mandatory)) must(await setDocumentStatus(oc, appId, d.key, "waived", "Verified in person at the office"), `waive ${d.key}`);
    assert.equal((await getApplication(oc, appId))?.app.stageKey, "doc", "the background check still holds it");
    assert.equal((await saveBgv(oc, appId, { required: true, status: "clear", method: "Previous-employer call" })).ok, false, "clear needs its completion date");
    must(await saveBgv(oc, appId, { required: true, status: "clear", method: "Previous-employer call", completedOn: today() }), "bgv");
    assert.equal((await getApplication(oc, appId))?.app.stageKey, "empdocs");
  });

  test("employment documents: a second person approves, signatures and the courier back close the stage", async () => {
    const oc = await as(onboarder);
    must(await prepareEmploymentDocs(oc, appId), "prepare");
    const rows = await employmentDocRows(appId);
    assert.equal(rows.length, 5);
    assert.match(rows.find((r) => r.docKey === "offer")!.body, /₹21,000/, "the template carries the accepted figure");
    assert.equal((await approveEmploymentDoc(oc, rows[0].id)).ok, false, "the preparer cannot approve");
    const hc = await as(head);
    for (const r of rows) must(await approveEmploymentDoc(hc, r.id), `approve ${r.docKey}`);
    const oc2 = await as(onboarder);
    must(await sendEmploymentDocs(oc2, appId, rows.map((r) => r.id)), "send");
    for (const r of rows) must(await markEmploymentDocSigned(oc2, r.id, today(), null), `sign ${r.docKey}`);
    assert.equal((await getApplication(oc2, appId))?.app.stageKey, "empdocs", "the hard copies are not back");
    const [out] = await db.select().from(hireCourierShipments).where(and(eq(hireCourierShipments.applicationId, appId), eq(hireCourierShipments.direction, "outbound")));
    must(await courierEvent(oc2, out.id, { status: "sent", on: today(), company: "DTDC", trackingNo: "D41239876" }), "sent");
    must(await courierEvent(oc2, out.id, { status: "delivered", on: today() }), "delivered");
    const [ret] = await db.select().from(hireCourierShipments).where(and(eq(hireCourierShipments.applicationId, appId), eq(hireCourierShipments.direction, "return")));
    assert.equal(ret?.status, "awaited", "delivery opened the return leg");
    must(await courierEvent(oc2, ret.id, { status: "received", on: today() }), "received");
    assert.equal((await getApplication(oc2, appId))?.app.stageKey, "setup");
    const board = await onboardingRows(oc2, Date.now());
    assert.equal(board.find((r) => r.id === appId)?.ob, "ready_to_provision");
  });

  test("provisioning makes them hired, enrols them, and onboarding carries on", async () => {
    const oc = await as(onboarder);
    const p = must(await provision(oc, appId, ""), "provision");
    const b = (await getApplication(oc, appId))!;
    assert.equal(b.app.status, "hired");
    assert.equal(b.app.stageKey, "kit", "Assets & induction comes after the account");
    assert.equal(b.app.onboardingCompletedAt, null);
    const e = await enrollmentForApplication(appId);
    assert.ok(e && e.userId === p.userId, "enrolled on the role's track");
    const [emp] = await db.select().from(users).where(eq(users.id, p.userId));
    await db.update(trainingEnrollments).set({ trainerId: trainer.id }).where(eq(trainingEnrollments.id, e!.id));
    /* Assets: issued by onboarding, acknowledged by the employee themselves. */
    for (const a of b.def.onboarding.assets.filter((x) => x.applicableByDefault !== false)) must(await issueAsset(oc, appId, a.key, { serial: a.serial ? `SER-${a.key}` : null, issuedOn: today() }), `issue ${a.key}`);
    for (const i of b.def.onboarding.intros ?? []) must(await setItem(oc, appId, { kind: "intro", group: "dept", item: i.key }, true), `intro ${i.key}`);
    for (const g of b.def.onboarding.setup) for (const s of g.steps) must(await setItem(oc, appId, { kind: "setup", group: g.key, item: s.key }, true), `setup ${s.key}`);
    assert.equal((await getApplication(oc, appId))?.app.stageKey, "kit", "nothing is acknowledged yet");
    const mine = await myAssets(emp.id);
    assert.ok(mine.length >= 6);
    const stranger = await person("Somebody Else", "interviewer");
    assert.equal((await acknowledgeMyAsset(stranger.id, mine[0].a.id, null)).ok, false, "only their own");
    for (const m of mine) must(await acknowledgeMyAsset(emp.id, m.a.id, null), `ack ${m.a.label}`);
    assert.equal((await getApplication(await as(onboarder), appId))?.app.stageKey, "training", "the last acknowledgement moved them to training");
  });

  test("training: a fail needs a trainer's sign-off and fresh study; passing the track completes onboarding", async () => {
    const e = (await enrollmentForApplication(appId))!;
    const learner = e.userId;
    const now = () => Date.now();
    const correctly = async (attemptId: string, wrong: boolean) => {
      const [a] = await db.select().from(trainingAttempts).where(eq(trainingAttempts.id, attemptId));
      const [v] = await db.select().from(trainingModuleVersions).where(eq(trainingModuleVersions.id, a.moduleVersionId));
      for (const it of a.items) {
        const q = v.definition.questions.find((x) => x.key === it.questionKey)!;
        const pick = wrong ? q.options.find((o) => o.key !== q.correctKey)!.key : q.correctKey;
        must(await answerQuestion(learner, attemptId, q.key, pick, now()), "answer");
      }
      return must(await submitAttempt(learner, attemptId, now()), "submit");
    };
    const first = "thinner-basics";
    assert.equal((await startAttempt(learner, e.id, first, now())).ok, false, "study first");
    must(await recordStudy(learner, e.id, first, 600, now()), "study");
    const a1 = must(await startAttempt(learner, e.id, first, now()), "start");
    const r1 = await correctly(a1.attemptId, true);
    assert.equal(r1.result, "failed");
    await assert.rejects(db.update(trainingAttempts).set({ scorePercent: 100 }).where(eq(trainingAttempts.id, a1.attemptId)), "a submitted attempt cannot be changed");
    assert.equal((await startAttempt(learner, e.id, first, now())).ok, false, "no retake before the sign-off");
    const v1 = await enrollmentView(e.id, now());
    assert.equal(v1?.modules.find((m) => m.moduleKey === "product-universal")?.state, "locked", "the next module stays locked");
    assert.equal((await signOffRetraining({ id: trainer.id, name: trainer.name }, e.id, first, "short", now())).ok, false);
    must(await signOffRetraining({ id: trainer.id, name: trainer.name }, e.id, first, "Went through compatibility with him on a call.", now()), "sign off");
    assert.equal((await startAttempt(learner, e.id, first, now())).ok, false, "study again first");
    must(await recordStudy(learner, e.id, first, 600, now()), "restudy");
    const a2 = must(await startAttempt(learner, e.id, first, now()), "retake");
    assert.equal((await correctly(a2.attemptId, false)).result, "passed");
    /* The rest of the track, in the order it unlocks. */
    for (let guard = 0; guard < 20; guard++) {
      const v = await enrollmentView(e.id, now());
      const next = v?.modules.find((m) => m.state === "available" || m.state === "in_progress");
      if (!next) break;
      must(await recordStudy(learner, e.id, next.moduleKey, 900, now()), `study ${next.moduleKey}`);
      const a = must(await startAttempt(learner, e.id, next.moduleKey, now()), `start ${next.moduleKey}`);
      await correctly(a.attemptId, false);
    }
    const done = await enrollmentView(e.id, now());
    assert.equal(done?.summary.passed, done?.summary.required, "every required module passed");
    const [en] = await db.select().from(trainingEnrollments).where(eq(trainingEnrollments.id, e.id));
    assert.equal(en.status, "completed");
    const b = await getApplication(await as(head), appId);
    assert.ok(b?.app.onboardingCompletedAt, "onboarding is complete");
    assert.equal(await advanceIfPassed(await as(head), appId), false, "nothing is left to move");
  });
});
