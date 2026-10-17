"use server";

import { revalidatePath } from "next/cache";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { hireApplications } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { HireNotPermitted, requireHireCap } from "../access";
import { stageByKey } from "../blueprint-types";
import { canMove } from "../engines/gating";
import { hireTrail, currentExecution, getApplication, moveApplication, stageOutcome } from "../services/core";
import { createApplication, screenIn, type NewCandidateInput } from "../services/pipeline";
import { bookInterview, suggestSlots, type Slot } from "../services/schedule";

/* ---------------------------------------------------------------------------
 * The pipeline's writes: moving a card, overriding a gate, adding a
 * candidate, assigning people, screening in and booking interviews. Each one
 * checks its own capability — a server action is a URL, and a hidden button
 * is not a permission.
 * ------------------------------------------------------------------------- */

function refused(e: unknown): Result<never> {
  if (e instanceof HireNotPermitted) return err(e.message, "not_permitted");
  throw e;
}

export type MoveBlocked = {
  why: string;
  overridable: boolean;
  /** Whether THIS person may override. */
  canOverride: boolean;
  route: { href: string; label: string } | null;
  targetName: string;
  name: string;
};

/**
 * Try to move a card. Moves it when the entry rule passes; otherwise says why,
 * whether an override is possible, and where the work that satisfies the rule
 * is done. Nothing is written on a refusal.
 */
export async function tryMoveCandidate(applicationId: string, targetKey: string): Promise<Result<{ moved: true } | { moved: false; blocked: MoveBlocked }>> {
  let ctx;
  try {
    ctx = await requireHireCap();
  } catch (e) {
    return refused(e);
  }
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const oc = await stageOutcome(b.app, b.def);
  const v = canMove(b.def, { status: b.app.status, stageKey: b.app.stageKey, currentOutcome: oc.outcome, pendingWhy: oc.why }, targetKey);
  const targetName = targetKey === "hired" ? "Hired" : (stageByKey(b.def, targetKey)?.name ?? targetKey);
  if (v.ok) {
    const r = await moveApplication(ctx, applicationId, targetKey);
    if (!r.ok) return r;
    revalidatePath("/hire");
    return ok({ moved: true as const }, r.message);
  }
  let route: MoveBlocked["route"] = null;
  if (v.route === "gate") route = { href: `/hire/gate/${applicationId}`, label: "Open the decision gate" };
  else if (v.route === "provision") route = { href: `/hire/provision?app=${applicationId}`, label: "Open provisioning" };
  else if (v.route === "documents") route = { href: `/hire/documents?app=${applicationId}`, label: "Open documents" };
  else if (v.route === "briefing") route = { href: `/hire/c/${applicationId}?tab=stages`, label: "Open the briefing" };
  else if (v.route === "scoring") {
    const ex = await currentExecution(applicationId, b.app.stageKey);
    route = ex ? { href: `/hire/scoring/${ex.id}`, label: "Review the scores" } : { href: `/hire/c/${applicationId}`, label: "Open the record" };
  }
  return ok({
    moved: false as const,
    blocked: { why: v.why, overridable: v.overridable, canOverride: v.overridable && ctx.can("override"), route, targetName, name: b.candidate.fullName },
  });
}

/** Move past a failed entry rule, with a reason. Recorded and marked on the record. */
export async function overrideMoveCandidate(applicationId: string, targetKey: string, reason: string): Promise<Result<{ stageKey: string }>> {
  let ctx;
  try {
    ctx = await requireHireCap("override");
  } catch (e) {
    return refused(e);
  }
  const r = await moveApplication(ctx, applicationId, targetKey, reason);
  if (r.ok) revalidatePath("/hire");
  return r;
}

export async function addCandidate(input: NewCandidateInput): Promise<Result<{ applicationId: string; candidateId: string; duplicate: boolean }>> {
  let ctx;
  try {
    ctx = await requireHireCap("addCandidate");
  } catch (e) {
    return refused(e);
  }
  const r = await createApplication(ctx, { ...input, enteredVia: "hr" });
  if (r.ok) {
    revalidatePath("/hire");
    revalidatePath("/hire/candidates");
  }
  return r;
}

/** Assign a recruiter and/or interviewer to several applications at once. */
export async function assignBulk(applicationIds: string[], patch: { recruiterId?: string | null; interviewerId?: string | null }): Promise<Result<{ n: number }>> {
  let ctx;
  try {
    ctx = await requireHireCap("addCandidate");
  } catch (e) {
    return refused(e);
  }
  if (!applicationIds.length) return err("Nothing selected.", "validation");
  const set: Record<string, string | null> = {};
  if (patch.recruiterId !== undefined) set.recruiterId = patch.recruiterId || null;
  if (patch.interviewerId !== undefined) set.interviewerId = patch.interviewerId || null;
  if (!Object.keys(set).length) return err("Choose somebody to assign.", "validation");
  /* Only applications this person can see. */
  const visible: string[] = [];
  for (const id of applicationIds) if (await getApplication(ctx, id)) visible.push(id);
  if (!visible.length) return err("None of those candidates are on your list.", "not_found");
  for (const uid of Object.values(set)) {
    if (!uid) continue;
    const [u] = (await db.execute(sql`select 1 from app_access where user_id = ${uid} and app = 'hire'`)) as unknown as unknown[];
    if (!u) return err("That person does not hold Hire.", "validation");
  }
  await db
    .update(hireApplications)
    .set({ ...set, updatedAt: new Date(), updatedById: ctx.user.id })
    .where(inArray(hireApplications.id, visible));
  for (const id of visible)
    await hireTrail(ctx, { applicationId: id, entityType: "application", entityId: id, event: "assigned", summary: `Assigned ${Object.keys(set).map((k) => k.replace("Id", "")).join(" and ")}`, after: set });
  revalidatePath("/hire/candidates");
  return ok({ n: visible.length }, `Assigned ${visible.length} candidate${visible.length === 1 ? "" : "s"}.`);
}

export async function screenInCandidate(applicationId: string): Promise<Result> {
  let ctx;
  try {
    ctx = await requireHireCap("addCandidate");
  } catch (e) {
    return refused(e);
  }
  if (!(await getApplication(ctx, applicationId))) return err("That candidate is not on your list.", "not_found");
  const r = await screenIn(ctx, applicationId);
  if (r.ok) revalidatePath("/hire/tasks");
  return r;
}

export async function suggestInterviewTimes(applicationId: string, interviewerId: string, minutes: number): Promise<Result<Slot[]>> {
  let ctx;
  try {
    ctx = await requireHireCap("addCandidate");
  } catch (e) {
    return refused(e);
  }
  if (!(await getApplication(ctx, applicationId))) return err("That candidate is not on your list.", "not_found");
  return ok(await suggestSlots({ applicationId, interviewerId, minutes, fromMs: Date.now() }));
}

export async function scheduleInterview(input: { applicationId: string; interviewerId: string; startIso: string; minutes: number; place: string; modality: string }): Promise<Result> {
  let ctx;
  try {
    ctx = await requireHireCap("addCandidate");
  } catch (e) {
    return refused(e);
  }
  const b = await getApplication(ctx, input.applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const r = await bookInterview(ctx, b, input);
  if (r.ok) {
    revalidatePath("/hire/calendar");
    revalidatePath("/hire/tasks");
  }
  return r;
}
