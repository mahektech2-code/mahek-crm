"use server";

import { revalidatePath } from "next/cache";
import { err, type Result } from "@/lib/result";
import { HireNotPermitted, requireHireCap } from "../access";
import type { HireCap } from "../roles";
import { hireTrail } from "../services/core";
import {
  correctAttempt,
  createModule,
  createTrack,
  discardModuleDraft,
  enroll,
  publishModule,
  publishTrack,
  saveModuleDraft,
  saveTrackDraft,
  signOffRetraining,
} from "@/lib/training/service";
import type { ModuleDefinition, TrackDefinition } from "@/lib/training/types";
import { db } from "@/db";
import { draftQuestions } from "../ai/draft-questions";

/* Training's Hire-side writes: authoring, the trainer's sign-off, corrections. Each checks its own capability. */

async function guarded<T>(cap: HireCap, fn: (ctx: Awaited<ReturnType<typeof requireHireCap>>) => Promise<Result<T>>): Promise<Result<T>> {
  try {
    const ctx = await requireHireCap(cap);
    const r = await fn(ctx);
    if (r.ok) revalidatePath("/hire", "layout");
    return r;
  } catch (e) {
    if (e instanceof HireNotPermitted) return err(e.message, "not_permitted");
    console.error("hire training:", e instanceof Error ? e.message : e);
    return err("That could not be saved. Try again.");
  }
}

const actor = (ctx: { user: { id: string; name: string } }) => ({ id: ctx.user.id, name: ctx.user.name });

export async function createModuleAction(input: { key: string; title: string; category: string }) {
  return guarded("trainingAuthor", (ctx) => createModule(actor(ctx), input));
}

export async function saveModuleAction(moduleId: string, input: { title?: string; category?: string; definition: ModuleDefinition }) {
  return guarded("trainingAuthor", (ctx) => saveModuleDraft(actor(ctx), moduleId, input));
}

export async function publishModuleAction(moduleId: string) {
  return guarded("trainingAuthor", async (ctx) => {
    const r = await publishModule(actor(ctx), moduleId);
    if (r.ok) await hireTrail(ctx, { entityType: "training_module", entityId: moduleId, event: "training_module_published", summary: `Training module published as v${r.data.version}` });
    return r;
  });
}

export async function discardModuleDraftAction(moduleId: string) {
  return guarded("trainingAuthor", () => discardModuleDraft(moduleId));
}

export async function createTrackAction(input: { key: string; title: string }) {
  return guarded("trainingAuthor", (ctx) => createTrack(actor(ctx), input));
}

export async function saveTrackAction(trackId: string, input: { title?: string; definition: TrackDefinition }) {
  return guarded("trainingAuthor", (ctx) => saveTrackDraft(actor(ctx), trackId, input));
}

export async function publishTrackAction(trackId: string) {
  return guarded("trainingAuthor", async (ctx) => {
    const r = await publishTrack(actor(ctx), trackId);
    if (r.ok) await hireTrail(ctx, { entityType: "training_track", entityId: trackId, event: "training_track_published", summary: `Training track published as v${r.data.version}` });
    return r;
  });
}

export async function signOffRetrainingAction(enrollmentId: string, moduleKey: string, note: string) {
  return guarded("trainingTrain", (ctx) => signOffRetraining(actor(ctx), enrollmentId, moduleKey, note, Date.now()));
}

export async function correctAttemptAction(attemptId: string, input: { scorePercent: number; reason: string }) {
  return guarded("attemptCorrect", async (ctx) => {
    const r = await correctAttempt(actor(ctx), attemptId, input, Date.now());
    if (r.ok) await hireTrail(ctx, { entityType: "training_attempt", entityId: attemptId, event: "training_attempt_corrected", summary: `Training attempt corrected to ${input.scorePercent}% · “${input.reason.trim()}”` });
    return r;
  });
}

/** Enrol somebody already working here on a track — a refresher, or retraining across the team. */
export async function enrollUserAction(userId: string, trackKey: string, trainerId: string | null) {
  return guarded("trainingTrain", async (ctx) => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const r = await enroll(db, { userId, trackKey, trainerId, assignedById: ctx.user.id, todayYmd: today });
    if (r.ok) await hireTrail(ctx, { entityType: "training_enrollment", entityId: r.data.enrollmentId, event: "training_enrolled", summary: `Enrolled a user on “${trackKey}”` });
    return r;
  });
}

/** AI drafts questions from the module's own content. They land unapproved; a person approves each. */
export async function draftQuestionsAction(moduleId: string, count: number) {
  return guarded("trainingAuthor", (ctx) => draftQuestions(ctx, moduleId, count));
}
