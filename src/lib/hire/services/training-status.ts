import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { hireApplications, hireBlueprints, hireStageExecutions } from "@/db/schema";
import { enrollmentForApplication, enrollmentView } from "@/lib/training/service";
import type { Outcome } from "./core";
import { ensureExecution, hireTrail } from "./core";

/* ---------------------------------------------------------------------------
 * THE TRAINING STAGE, read off the training engine. Kept apart from core.ts so
 * the two services do not import each other at load time: core asks this
 * file lazily, and the training service tells this file when a track is done.
 * ------------------------------------------------------------------------- */

export async function trainingOutcome(applicationId: string): Promise<Outcome> {
  const e = await enrollmentForApplication(applicationId);
  if (!e) return { outcome: "pending", why: "They are not enrolled on a training track — it happens when the account is created." };
  if (e.status === "completed") return { outcome: "pass" };
  const v = await enrollmentView(e.id, Date.now());
  if (!v) return { outcome: "pending", why: "The training track could not be read." };
  if (v.summary.passed >= v.summary.required) return { outcome: "pass" };
  const retraining = v.modules.filter((m) => m.state === "retraining_required").length;
  return { outcome: "pending", why: `${v.summary.passed} of ${v.summary.required} required modules passed${retraining ? ` · ${retraining} waiting for retraining` : ""}.` };
}

/**
 * Every required module is passed. If the application is AT its training
 * stage and it is the last stage, onboarding is complete; otherwise the stage
 * execution is closed and the next stage is left to whoever moves them.
 */
export async function onTrainingCompleted(applicationId: string, actor: { id: string; name: string }) {
  const [a] = await db.select().from(hireApplications).where(eq(hireApplications.id, applicationId)).limit(1);
  if (!a || a.status !== "hired") return;
  const [bp] = await db.select({ definition: hireBlueprints.definition }).from(hireBlueprints).where(eq(hireBlueprints.id, a.blueprintId)).limit(1);
  const def = bp?.definition;
  const stage = def?.stages.find((s) => s.key === a.stageKey);
  if (!def || stage?.type !== "training") return;
  const now = new Date();
  const last = def.stages[def.stages.length - 1]?.key === stage.key;
  const ctx = { user: { id: actor.id, name: actor.name }, roleLabel: "Learner" } as Parameters<typeof hireTrail>[0];
  await db.transaction(async (tx) => {
    const ex = await ensureExecution(applicationId, stage, actor.id, tx);
    await tx.update(hireStageExecutions).set({ status: "completed", outcome: "pass", completedAt: now, updatedAt: now }).where(eq(hireStageExecutions.id, ex.id));
    if (last) await tx.update(hireApplications).set({ onboardingCompletedAt: now, updatedAt: now }).where(and(eq(hireApplications.id, applicationId), isNull(hireApplications.onboardingCompletedAt)));
    await hireTrail(ctx, { applicationId, candidateId: a.candidateId, entityType: "training", entityId: applicationId, event: last ? "onboarding_completed" : "training_completed", summary: last ? "Every required training module passed · onboarding completed" : "Every required training module passed" }, tx);
  });
}
