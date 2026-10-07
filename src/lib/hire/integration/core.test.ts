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
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, hireApplications, hireAudit, hireDecisions, hireStageExecutions, hireUserRoles, users } from "@/db/schema";
import { setTestUser } from "@/lib/auth";
import { hireContext, type HireContext } from "@/lib/hire/access";
import { boardRows, createApplication, resolveDuplicate, screenIn } from "@/lib/hire/services/pipeline";
import { getApplication, moveApplication, stageOutcome } from "@/lib/hire/services/core";
import { seedHireBlueprints } from "@/lib/hire/seed/seed";
import { installHire } from "@/lib/hire/install";
import { runTask } from "@/lib/hire/ai/orchestrator";
import { z } from "zod";
import { invalidateConfig } from "@/lib/config/store";

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
    assert.deepEqual(again, { blueprints: [], admins: [] });
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
});
