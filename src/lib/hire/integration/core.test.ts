/**
 * Hire's core rules, against a real database through the real services:
 * identity is the phone number, gating is enforced, an override is a named
 * act with a reason, an interviewer's scope is narrow, and the record is
 * append-only.
 *
 *   npm run test:integration
 *
 * Needs `mahekone_test` (npm run test:db). It truncates what it touches.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, hireApplications, hireAudit, hireBlueprints, hireDecisions, hireMessages, hireOffers, hireStageExecutions, hireUserRoles, notifications, users } from "@/db/schema";
import { deleteDraftBlueprint } from "@/lib/hire/services/blueprints";
import { bookInterview, cancelBooking } from "@/lib/hire/services/schedule";
import { listHumanInterviews } from "@/lib/hire/services/interview";
import { currentOffer, recordResponse, withdrawOffer } from "@/lib/hire/services/offers";
import { setTestUser } from "@/lib/auth";
import { HireNotPermitted, hireContext, requireHireCap, type HireContext } from "@/lib/hire/access";
import { boardRows, createApplication, resolveDuplicate, screenIn } from "@/lib/hire/services/pipeline";
import { getApplication, moveApplication, stageOutcome } from "@/lib/hire/services/core";
import { cancelBookedInterviews } from "@/lib/hire/services/schedule";
import { seedHireBlueprints } from "@/lib/hire/seed/seed";
import { installHire } from "@/lib/hire/install";
import { runTask } from "@/lib/hire/ai/orchestrator";
import { z } from "zod";
import { invalidateConfig } from "@/lib/config/store";
import { confirmImpact, impactReport } from "@/lib/impact/registry";

const uid = () => `usr_${randomUUID().slice(0, 12)}`;

async function person(name: string, role: string, level: "associate" | "manager" | "admin" = "associate") {
  const [u] = await db
    .insert(users)
    .values({ id: uid(), name, email: `${name.split(" ")[0].toLowerCase()}.${randomUUID().slice(0, 6)}@test.in`, passwordHash: "x", role: level, initials: "XX" })
    .returning();
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

describe("Hire core", () => {
  let head: typeof users.$inferSelect;
  let recruiter: typeof users.$inferSelect;
  let interviewer: typeof users.$inferSelect;
  let manager: typeof users.$inferSelect;
  const SE = "hbp_sales-executive_v3";

  before(async () => {
    await db.execute(sql`truncate hire_audit, hire_ai_outputs, hire_ai_tasks, hire_messages, hire_onboarding_items, hire_offers, hire_profiles, hire_documents, hire_vault, hire_files, hire_sessions, hire_rejection_proposals, hire_decisions, hire_briefing_responses, hire_answers, hire_stage_executions, hire_outcomes, hire_applications, hire_candidates, hire_user_roles, hire_blueprints cascade`);
    head = await person("Kavita Head", "hr_head", "manager");
    recruiter = await person("Priya Recruiter", "recruiter");
    interviewer = await person("Rakesh Interviewer", "interviewer");
    manager = await person("Sanjay Manager", "hiring_manager", "manager");
    await seedHireBlueprints(head.id);
  });

  after(async () => {
    setTestUser(null);
    await db.$client.end();
  });

  test("a candidate enters only against a published version, with consent", async () => {
    const ctx = await as(recruiter);
    const noConsent = await createApplication(ctx, { fullName: "Suresh Patil", phone: "98220 41736", blueprintId: SE, consent: false });
    assert.equal(noConsent.ok, false);
    const draft = await createApplication(ctx, { fullName: "Suresh Patil", phone: "98220 41736", blueprintId: "hbp_warehouse-supervisor_v1", consent: true });
    assert.equal(draft.ok, false);
    const r = await createApplication(ctx, { fullName: "Suresh Patil", phone: "98220 41736", blueprintId: SE, consent: true, location: "Pune" });
    assert.ok(r.ok, !r.ok ? r.error : "");
    const [a] = await db.select().from(hireApplications).where(eq(hireApplications.id, r.data.applicationId));
    assert.equal(a.stageKey, "app");
    assert.equal(a.recruiterId, recruiter.id);
  });

  test("D1: identity is the phone — an open application refuses a second, and a near name proposes a duplicate", async () => {
    const ctx = await as(recruiter);
    const again = await createApplication(ctx, { fullName: "Suresh B. Patil", phone: "+91 98220-41736", blueprintId: SE, consent: true });
    assert.equal(again.ok, false);
    assert.equal(!again.ok && again.code, "duplicate");
    const near = await createApplication(ctx, { fullName: "Suresh Patill", phone: "9000011111", blueprintId: SE, consent: true, location: "Pune" });
    assert.ok(near.ok && near.data.duplicate, "a near name in the same place is raised");
    const screened = await screenIn(ctx, near.ok ? near.data.applicationId : "");
    assert.equal(screened.ok, false, "cannot screen in past an open duplicate question");
    const res = await resolveDuplicate(ctx, near.ok ? near.data.applicationId : "", false, "Different father’s name and address");
    assert.ok(res.ok);
    assert.ok((await screenIn(ctx, near.ok ? near.data.applicationId : "")).ok);
  });

  test("D5: a stage not passed cannot be left; skipping and moving back are refused", async () => {
    const ctx = await as(recruiter);
    const [a] = await db.select().from(hireApplications).where(sql`${hireApplications.candidateId} in (select id from hire_candidates where primary_phone = '+919822041736')`);
    const blocked = await moveApplication(ctx, a.id, "scr");
    assert.equal(blocked.ok, false);
    assert.match(!blocked.ok ? blocked.error : "", /not been reviewed/);
    assert.ok((await screenIn(ctx, a.id)).ok);
    const skip = await moveApplication(ctx, a.id, "l1");
    assert.match(!skip.ok ? skip.error : "", /skips AI voice screen/);
    const okMove = await moveApplication(ctx, a.id, "scr");
    assert.ok(okMove.ok);
    const back = await moveApplication(ctx, a.id, "app");
    assert.equal(back.ok, false);
    const b = await getApplication(ctx, a.id);
    assert.equal((await stageOutcome(b!.app, b!.def)).outcome, "pending");
  });

  test("an override needs the capability and a reason, and leaves a marker", async () => {
    const [a] = await db.select().from(hireApplications).where(sql`${hireApplications.candidateId} in (select id from hire_candidates where primary_phone = '+919822041736')`);
    const rctx = await as(recruiter);
    const refused = await moveApplication(rctx, a.id, "l1", "Strong referral, screen to be done later in person");
    assert.equal(!refused.ok && refused.code, "not_permitted");
    const mctx = await as(manager);
    const short = await moveApplication(mctx, a.id, "l1", "because");
    assert.equal(!short.ok && short.code, "validation");
    const done = await moveApplication(mctx, a.id, "l1", "Phone line too poor for the AI screen; will screen in person at Level 1");
    assert.ok(done.ok);
    const [after] = await db.select().from(hireApplications).where(eq(hireApplications.id, a.id));
    assert.equal(after.override?.byName, "Sanjay Manager");
    const [ex] = await db.select().from(hireStageExecutions).where(sql`${hireStageExecutions.applicationId} = ${a.id} and ${hireStageExecutions.stageKey} = 'l1'`);
    assert.equal(ex.entryWasGated, false);
    const lines = await db.select().from(hireAudit).where(eq(hireAudit.applicationId, a.id));
    assert.ok(lines.some((l) => l.eventType === "gate_override"));
  });

  test("an interviewer sees only who they are interviewing, and never a score", async () => {
    const ictx = await as(interviewer);
    assert.equal((await boardRows(ictx)).length, 0);
    const [a] = await db.select().from(hireApplications).where(sql`${hireApplications.candidateId} in (select id from hire_candidates where primary_phone = '+919822041736')`);
    assert.equal(await getApplication(ictx, a.id), null, "out of scope is not found");
    await db.update(hireApplications).set({ interviewerId: interviewer.id }).where(eq(hireApplications.id, a.id));
    const rows = await boardRows(await as(interviewer));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].latestScore, null);
    assert.ok(await getApplication(await as(interviewer), a.id));
  });

  test("the audit trail and a reasonless decision are refused by the database itself", async () => {
    const appendOnly = (e: unknown) => /append-only/.test(String((e as { cause?: { message?: string } })?.cause?.message ?? e));
    await assert.rejects(db.execute(sql`update hire_audit set summary = 'edited'`), appendOnly);
    await assert.rejects(db.execute(sql`delete from hire_audit`), appendOnly);
    const [a] = await db.select().from(hireApplications).limit(1);
    await assert.rejects(
      db.insert(hireDecisions).values({ id: `hde_${randomUUID()}`, applicationId: a.id, decisionPoint: "decision_gate", decidedById: head.id, decidedByRole: "HR Head", decision: "advance", reasoning: "ok" }),
    );
  });

  test("installing gives every platform administrator Hire as Admin, once, and seeds nothing twice", async () => {
    const [admin] = await db
      .insert(users)
      .values({ id: uid(), name: "Platform Admin", email: `pa.${randomUUID().slice(0, 6)}@test.in`, passwordHash: "x", role: "admin", initials: "PA" })
      .returning();
    await db.insert(appAccess).values({ id: `acc_${randomUUID()}`, userId: admin.id, app: "admin", role: "admin" });
    const first = await installHire();
    assert.deepEqual(first.blueprints, [], "the blueprints were already seeded");
    assert.ok(first.admins.includes("Platform Admin"));
    const ctx = await as(admin);
    assert.equal(ctx.role, "admin");
    const again = await installHire();
    assert.deepEqual(again, { blueprints: [], admins: [], content: [] }, "the onboarding content is seeded once, too");

    /* Taken away on the console, it stays away: the next deploy does not give it back. */
    await db.delete(appAccess).where(sql`${appAccess.userId} = ${admin.id} and ${appAccess.app} = 'hire'`);
    const deploy = await installHire();
    assert.deepEqual(deploy.admins, [], "a platform admin given Hire once is not given it again");
    const still = await db.select().from(appAccess).where(sql`${appAccess.userId} = ${admin.id} and ${appAccess.app} = 'hire'`);
    assert.equal(still.length, 0);
  });

  test("with AI switched off, a task takes its manual path and is still logged", async () => {
    await db.execute(sql`insert into app_settings (key, value, value_type, category, label) values ('hire.ai.enabled', 'false'::jsonb, 'boolean', 'hire', 'AI assistance in Hire') on conflict (key) do update set value = 'false'::jsonb`);
    invalidateConfig();
    try {
      const r = await runTask({ taskType: "test", promptVersion: "t/v1", tier: "fast", system: "s", prompt: "p", schema: z.object({ x: z.string() }), entity: { type: "test" } });
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.status, "disabled");
      const [row] = (await db.execute(sql`select status, fallback_used from hire_ai_tasks where task_type = 'test'`)) as unknown as { status: string; fallback_used: string }[];
      assert.equal(row.status, "disabled");
      assert.equal(row.fallback_used, "manual");
    } finally {
      await db.execute(sql`delete from app_settings where key = 'hire.ai.enabled'`);
      invalidateConfig();
    }
  });

  test("a withdrawal says what it leaves behind, and is refused without the confirmation", async () => {
    const ctx = await as(recruiter);
    const r = await createApplication(ctx, { fullName: "Meena Joshi", phone: "98111 22233", blueprintId: SE, consent: true, location: "Nashik" });
    assert.ok(r.ok, !r.ok ? r.error : "");
    const appId = r.data.applicationId;
    /* An interview already booked for her is cancelled with her — the thing a person recording a withdrawal assumes goes. */
    const execId = `hex_${randomUUID().slice(0, 12)}`;
    await db.insert(hireStageExecutions).values({ id: execId, applicationId: appId, stageKey: "app", status: "scheduled", scheduledAt: new Date(Date.now() + 86_400_000), conductedById: interviewer.id });

    const report = await impactReport("hire-withdraw", appId);
    assert.ok(report.ok, report.ok ? "" : report.error);
    const going = report.data.items.find((i) => i.app === "Hire" && i.effect === "changed" && /interview.*cancelled/.test(i.label));
    assert.equal(going?.count, 1, JSON.stringify(report.data.items));
    assert.match(going?.examples?.[0] ?? "", /Rakesh Interviewer/);
    assert.equal(report.data.confirmWord, "Meena Joshi");

    /* `changeStatus` cannot be imported here — it pulls Hire's client kit, which
       calls createContext, and this runner loads the react-server build. So the
       gate it calls before writing is asked directly, exactly as it asks it. */
    assert.ok(await confirmImpact("hire-withdraw", appId, undefined), "no confirmation, no withdrawal");
    const stale = await confirmImpact("hire-withdraw", appId, { typed: "Meena Joshi", fingerprint: "1:stale" });
    assert.equal(stale?.code, "conflict");
    assert.equal(await confirmImpact("hire-withdraw", appId, { typed: "meena  joshi", fingerprint: report.data.fingerprint }), null);

    /* Withdrawn, it is closed — and the booked interview comes off the calendar in the same transaction,
       with a trail line, as `changeStatus` does it. Answers already recorded would stay. */
    const bundle = await getApplication(ctx, appId);
    assert.ok(bundle);
    const cancelled = await db.transaction(async (tx) => {
      const rows = await cancelBookedInterviews(ctx, bundle, tx);
      await tx.update(hireApplications).set({ status: "withdrawn", closedAt: new Date() }).where(eq(hireApplications.id, appId));
      return rows;
    });
    assert.deepEqual(cancelled.map((x) => [x.id, x.conductedById]), [[execId, interviewer.id]]);
    const [exec] = await db.select().from(hireStageExecutions).where(eq(hireStageExecutions.id, execId));
    assert.equal(exec.status, "skipped");
    assert.equal(exec.outcome, "not_applicable");
    const trail = await db.select().from(hireAudit).where(eq(hireAudit.entityId, execId));
    assert.ok(trail.some((t) => t.eventType === "interview_cancelled" && /cancelled — the candidate was withdrawn/.test(t.summary)), JSON.stringify(trail));
    /* The modal says so instead of offering the button. */
    const closed = await impactReport("hire-withdraw", appId);
    assert.ok(closed.ok, closed.ok ? "" : closed.error);
    assert.deepEqual(closed.data.blockers, ["This application is already closed."]);
    assert.equal((await confirmImpact("hire-withdraw", appId, { typed: "Meena Joshi", fingerprint: closed.data.fingerprint }))?.code, "rule_violation");
  });
  test("an issued offer can be withdrawn: it says what stays, the candidate is told, and the application stays open", async () => {
    const ctx = await as(manager);
    const r = await createApplication(ctx, { fullName: "Asha Kulkarni", phone: "98200 77441", blueprintId: SE, consent: true, location: "Pune" });
    assert.ok(r.ok, !r.ok ? r.error : "");
    const appId = r.data.applicationId;
    const offerId = `hof_${randomUUID().slice(0, 12)}`;
    await db.insert(hireOffers).values({ id: offerId, applicationId: appId, status: "accepted", grade: "g1", gradeLabel: "Grade 1", basicPaise: 2000000 });

    const report = await impactReport("hire-offer-withdraw", appId);
    assert.ok(report.ok, report.ok ? "" : report.error);
    assert.deepEqual(report.data.blockers, []);
    assert.ok(report.data.items.some((i) => i.effect === "changed" && /accepted offer/.test(i.label)), JSON.stringify(report.data.items));
    assert.ok(report.data.items.some((i) => i.effect === "kept" && i.label === "application"));
    assert.ok(await confirmImpact("hire-offer-withdraw", appId, undefined), "no confirmation, no withdrawal");

    const short = await withdrawOffer(ctx, appId, "Role closed.");
    assert.equal(short.ok, false, "a reason under twenty characters is refused");
    const done = await withdrawOffer(ctx, appId, "The territory was merged and the role has closed.");
    assert.equal(done.ok, true, done.ok ? "" : done.error);

    const [o] = await db.select().from(hireOffers).where(eq(hireOffers.id, offerId));
    assert.equal(o.status, "withdrawn", "the row stays, marked withdrawn");
    const [a] = await db.select().from(hireApplications).where(eq(hireApplications.id, appId));
    assert.equal(a.status, "in_progress", "withdrawing the offer is not closing the application");
    assert.equal((await currentOffer(appId))?.status, "withdrawn");
    assert.equal((await withdrawOffer(ctx, appId, "The territory was merged and the role has closed.")).ok, false, "nothing left to withdraw");
    const after = await impactReport("hire-offer-withdraw", appId);
    assert.ok(after.ok && after.data.blockers.length > 0, "the modal says so instead of offering the button");
  });

  test("an answer to an offer is refused once the application is closed, and the closure stands", async () => {
    const ctx = await as(recruiter);
    const r = await createApplication(ctx, { fullName: "Farhan Qureshi", phone: "98765 11223", blueprintId: SE, consent: true, location: "Thane" });
    assert.ok(r.ok, !r.ok ? r.error : "");
    const appId = r.data.applicationId;
    await db.insert(hireOffers).values({ id: `hof_${randomUUID().slice(0, 12)}`, applicationId: appId, status: "issued", grade: "g1", gradeLabel: "Grade 1", basicPaise: 2000000 });
    const closedAt = new Date("2026-11-01T10:00:00+05:30");
    await db.update(hireApplications).set({ status: "rejected", decisionReason: "Failed the field ride", closedAt }).where(eq(hireApplications.id, appId));
    const answered = await recordResponse(ctx, appId, { response: "declined", note: "Candidate said no on the phone today." });
    assert.equal(answered.ok, false, "a closed application takes no answer");
    const [a] = await db.select().from(hireApplications).where(eq(hireApplications.id, appId));
    assert.equal(a.status, "rejected");
    assert.equal(a.decisionReason, "Failed the field ride");
    assert.equal(a.closedAt?.getTime(), closedAt.getTime());
  });

  test("a draft that was never published is deleted through the impact modal; a published version never is", async () => {
    const DRAFT = "hbp_warehouse-supervisor_v1";
    await as(interviewer);
    const peek = await impactReport("hire-blueprint-draft", DRAFT);
    assert.equal(peek.ok ? "ok" : peek.code, "not_permitted", "an interviewer cannot even read it");

    const ctx = await as(head);
    const published = await impactReport("hire-blueprint-draft", SE);
    assert.ok(published.ok && /has been published/.test(published.data.blockers[0] ?? ""), JSON.stringify(published));
    assert.equal((await deleteDraftBlueprint(ctx, SE, { typed: "Sales Executive", fingerprint: published.ok ? published.data.fingerprint : "" })).ok, false);

    const report = await impactReport("hire-blueprint-draft", DRAFT);
    assert.ok(report.ok, report.ok ? "" : report.error);
    assert.deepEqual(report.data.blockers, []);
    assert.equal(report.data.items.find((i) => i.effect === "deleted")?.count, 1);
    const bare = await deleteDraftBlueprint(ctx, DRAFT, null);
    assert.equal(bare.ok, false, "no confirmation, no delete");
    const done = await deleteDraftBlueprint(ctx, DRAFT, { typed: report.data.confirmWord, fingerprint: report.data.fingerprint });
    assert.ok(done.ok, done.ok ? "" : done.error);
    assert.equal((await db.select().from(hireBlueprints).where(eq(hireBlueprints.id, DRAFT))).length, 0);
    const [trail] = await db.select().from(hireAudit).where(eq(hireAudit.entityId, DRAFT)).orderBy(desc(hireAudit.at)).limit(1);
    assert.equal(trail?.eventType, "blueprint_draft_deleted");
  });

  test("a booked interview is cancelled with a reason: status and trail, the candidate told as recorded, the interviewer belled", async () => {
    const ctx = await as(recruiter);
    const r = await createApplication(ctx, { fullName: "Kiran Desai", phone: "98200 77452", blueprintId: SE, consent: true, location: "Pune" });
    assert.ok(r.ok, !r.ok ? r.error : "");
    const appId = r.data.applicationId;
    const execId = `hex_${randomUUID().slice(0, 12)}`;
    const at = new Date(Date.now() + 2 * 86_400_000);
    await db.insert(hireStageExecutions).values({ id: execId, applicationId: appId, stageKey: "app", status: "scheduled", scheduledAt: at, scheduledMinutes: 45, place: "Pune office", conductedById: interviewer.id });

    await as(interviewer);
    await assert.rejects(requireHireCap("addCandidate"), HireNotPermitted, "an interviewer cannot cancel — the action asks this first");
    await as(recruiter);
    const b = (await getApplication(ctx, appId))!;
    const short = await cancelBooking(ctx, b, execId, { reason: "no", tell: "none", message: "" });
    assert.equal(short.ok ? "ok" : short.code, "validation");
    const noEmail = await cancelBooking(ctx, b, execId, { reason: "Interviewer is travelling that day", tell: "email", message: "Your interview is cancelled, sorry." });
    assert.equal(noEmail.ok ? "ok" : noEmail.error, "There is no email address on this candidate.");

    const done = await cancelBooking(ctx, b, execId, { reason: "Interviewer is travelling that day", tell: "whatsapp", message: "Your interview is cancelled; we will send a new time." });
    assert.ok(done.ok, done.ok ? "" : done.error);
    const [x] = await db.select().from(hireStageExecutions).where(eq(hireStageExecutions.id, execId));
    assert.equal(x.status, "not_started");
    assert.equal(x.scheduledAt, null);
    const [trail] = await db.select().from(hireAudit).where(eq(hireAudit.entityId, execId)).orderBy(desc(hireAudit.at)).limit(1);
    assert.equal(trail.eventType, "interview_cancelled");
    assert.match(trail.summary, /Interviewer is travelling that day/);
    assert.equal((trail.before as { place?: string }).place, "Pune office", "the booking as it stood is kept");
    const [msg] = await db.select().from(hireMessages).where(eq(hireMessages.applicationId, appId));
    assert.equal(msg.channel, "whatsapp");
    assert.equal(msg.status, "logged");
    const bells = await db.select().from(notifications).where(eq(notifications.userId, interviewer.id));
    assert.ok(bells.some((n) => /Interview cancelled: Kiran Desai/.test(n.title)), JSON.stringify(bells.map((n) => n.title)));

    const again = await cancelBooking(ctx, b, execId, { reason: "Interviewer is travelling that day", tell: "none", message: "" });
    assert.equal(again.ok ? "ok" : again.code, "rule_violation");
  });

  test("the Interviews list carries a booking as it stands, and Reschedule moves it: one booking, the trail says rescheduled", async () => {
    const ctx = await as(recruiter);
    const r = await createApplication(ctx, { fullName: "Meera Joshi", phone: "98200 77453", blueprintId: SE, consent: true, location: "Pune" });
    assert.ok(r.ok, !r.ok ? r.error : "");
    const appId = r.data.applicationId;
    /* Straight to the first human interview: gating is tested above. */
    await db.update(hireApplications).set({ stageKey: "l1" }).where(eq(hireApplications.id, appId));
    const first = new Date(Date.now() + 3 * 86_400_000);
    const b = (await getApplication(ctx, appId))!;
    const booked = await bookInterview(ctx, b, { interviewerId: interviewer.id, startIso: first.toISOString(), minutes: 60, place: "Pune office", modality: "in_person" });
    assert.ok(booked.ok, booked.ok ? "" : booked.error);
    const row = (await listHumanInterviews(ctx)).find((x) => x.applicationId === appId)!;
    assert.equal(row.status, "scheduled");
    assert.deepEqual([row.minutes, row.place, row.interviewerId, row.hasEmail, row.doNotContact], [60, "Pune office", interviewer.id, false, false]);

    const moved = new Date(first.getTime() + 86_400_000);
    const again = await bookInterview(ctx, (await getApplication(ctx, appId))!, { interviewerId: interviewer.id, startIso: moved.toISOString(), minutes: 45, place: "Video link", modality: "video" });
    assert.ok(again.ok, again.ok ? "" : again.error);
    const runs = await db.select().from(hireStageExecutions).where(eq(hireStageExecutions.applicationId, appId));
    assert.equal(runs.filter((x) => x.status === "scheduled").length, 1, "moved, not doubled");
    assert.equal(runs.find((x) => x.status === "scheduled")?.scheduledAt?.getTime(), moved.getTime());
    const [trail] = await db.select().from(hireAudit).where(eq(hireAudit.entityId, row.execId)).orderBy(desc(hireAudit.at)).limit(1);
    assert.equal(trail.eventType, "rescheduled");

    await as(interviewer);
    await assert.rejects(requireHireCap("addCandidate"), HireNotPermitted, "an interviewer is not offered, and cannot run, Reschedule");
  });
});
