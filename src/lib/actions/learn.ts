"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { err, type Result } from "@/lib/result";
import { answerQuestion, attemptQuestion, recordStudy, startAttempt, submitAttempt, type AttemptResult, type QuestionView } from "@/lib/training/service";
import { acknowledgeMyAsset } from "@/lib/hire/services/onboarding-records";

/* ---------------------------------------------------------------------------
 * THE LEARNER'S writes, at /learn. Each one acts as the signed-in person on
 * their OWN enrolment — the user id is the session's, never an argument — so
 * nobody can study, answer or acknowledge on somebody else's behalf.
 * ------------------------------------------------------------------------- */

async function asMe<T>(fn: (userId: string) => Promise<Result<T>>, revalidate = true): Promise<Result<T>> {
  try {
    const me = await requireUser();
    const r = await fn(me.id);
    if (r.ok && revalidate) revalidatePath("/learn", "layout");
    return r;
  } catch (e) {
    console.error("learn:", e instanceof Error ? e.message : e);
    return err("That did not save. Try again.");
  }
}

export async function studyBeatAction(enrollmentId: string, moduleKey: string, seconds: number) {
  return asMe((u) => recordStudy(u, enrollmentId, moduleKey, seconds, Date.now()), false);
}

export async function startAttemptAction(enrollmentId: string, moduleKey: string) {
  return asMe((u) => startAttempt(u, enrollmentId, moduleKey, Date.now()));
}

export async function questionAction(attemptId: string, index: number): Promise<Result<QuestionView>> {
  return asMe((u) => attemptQuestion(u, attemptId, index, Date.now()), false);
}

export async function answerAction(attemptId: string, questionKey: string, optionKey: string) {
  return asMe((u) => answerQuestion(u, attemptId, questionKey, optionKey, Date.now()), false);
}

export async function submitAttemptAction(attemptId: string): Promise<Result<AttemptResult>> {
  return asMe((u) => submitAttempt(u, attemptId, Date.now()));
}

export async function acknowledgeAssetAction(assetIssueId: string, problem: string | null) {
  return asMe((u) => acknowledgeMyAsset(u, assetIssueId, problem));
}
