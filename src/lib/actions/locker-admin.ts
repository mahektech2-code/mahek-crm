"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { err, ok, type Result } from "@/lib/result";
import { lockerAccess } from "@/lib/locker/access";
import { verifyAuditChain } from "@/lib/locker/audit";
import type { LockerSettings } from "@/lib/locker/settings";
import * as ops from "@/lib/locker/ops-core";

/* The Locker's operations and admin actions: sign in, then the core checks. */

function refresh(...paths: string[]) {
  try {
    for (const p of paths) revalidatePath(p);
  } catch {
    /* outside a request */
  }
}

export async function startOffboarding(userId: string) {
  const user = await requireUser();
  const r = await ops.startOffboarding(user, userId);
  refresh("/locker/offboard");
  return r;
}

export async function completeOffItem(offId: string, index: number, done: boolean, to: string | null) {
  const user = await requireUser();
  const r = await ops.completeOffItem(user, offId, index, { done, to });
  refresh("/locker/offboard");
  return r;
}

export async function signOffOffboarding(offId: string) {
  const user = await requireUser();
  const r = await ops.signOffOffboarding(user, offId);
  refresh("/locker/offboard");
  return r;
}

export async function openReview(period: string) {
  const user = await requireUser();
  const r = await ops.openReview(user, period);
  refresh("/locker/review");
  return r;
}

export async function decideReview(itemId: string, decision: "keep" | "remove") {
  const user = await requireUser();
  const r = await ops.decideReview(user, itemId, decision);
  refresh("/locker/review", "/locker/admin/access");
  return r;
}

export async function remindReviewer(userId: string, period: string) {
  const user = await requireUser();
  return ops.remindReviewer(user, userId, period);
}

export async function setLockerModules(userId: string, modules: string[], why: string) {
  const user = await requireUser();
  const r = await ops.setLockerModules(user, userId, modules, why);
  refresh("/locker/admin/access", "/locker");
  return r;
}

export async function saveType(code: string | null, input: ops.TypeInput) {
  const user = await requireUser();
  const r = await ops.saveType(user, code, input);
  refresh("/locker/admin/types");
  return r;
}

export async function saveLadder(criticality: number, offsets: number[]) {
  const user = await requireUser();
  const r = await ops.saveLadder(user, criticality, offsets);
  refresh("/locker/admin/reminders");
  return r;
}

export async function saveEntity(id: string | null, input: { name: string; gstin: string; isPrimary: boolean; active: boolean }) {
  const user = await requireUser();
  const r = await ops.saveEntity(user, id, input);
  refresh("/locker/admin/companies");
  return r;
}

export async function saveSite(id: string | null, input: { name: string; kind: string; state: string; hazardous: boolean; entityId: string | null; active: boolean }) {
  const user = await requireUser();
  const r = await ops.saveSite(user, id, input);
  refresh("/locker/admin/companies");
  return r;
}

export async function saveSettings(next: LockerSettings) {
  const user = await requireUser();
  const r = await ops.saveSettings(user, next);
  refresh("/locker/admin/security");
  return r;
}

export async function checkAuditChain(): Promise<Result<{ ok: boolean; rows: number; line: string }>> {
  const user = await requireUser();
  if (!(await lockerAccess(user.id)).has("locker.audit")) return err("You do not have Audit in the Locker.", "not_permitted");
  const v = await verifyAuditChain();
  return ok({ ok: v.ok, rows: v.rows, line: v.ok ? `All ${v.rows.toLocaleString("en-IN")} entries intact — none altered, none removed.` : `Broken at entry ${v.brokenAt}: ${v.why}` });
}
